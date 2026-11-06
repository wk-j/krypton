// Krypton — Program-Status Fire shaders (spec 0362).
//
// GLSL ES 3.00 port of rune-fx's procedural fire (`shaders/fire.wgsl` `flames()`
// and its ember pass, the soft variant of `shaders/glow.wgsl`, and helpers from
// `shaders/common.wgsl`) at rune 8ee30954. The smoke term and the fluid
// simulation are not ported. The ember table in `fire.ts` ports `cpu.rs::embers`.
//
// Ported code is covered by rune's license:
//
// MIT License
//
// Copyright (c) 2026 Anomaly
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/** Uniform array length: two vec4 per ember. Must match `FIRE.embers * 2`. */
export const FIRE_EMBER_VEC4S = 48;

/** One full-band triangle; no attributes. */
export const FIRE_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Coordinates are CSS px with y down (rune's pt). The host is a virtual rounded
 * rect whose top edge is the band's bottom row, so its flames rise into the band.
 */
export const FIRE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 u_res;      // band size, px
uniform float u_time;    // s
uniform float u_heat;    // 0..1
uniform uint u_seed;
uniform float u_height;  // current flame height, px
uniform float u_radius;  // host corner radius, px
uniform vec4 u_p0;       // scale, speed, warp, base glow
uniform vec4 u_p1;       // occlusion, intensity, glow radius, glow reach
uniform vec3 u_low;      // linear
uniform vec3 u_mid;
uniform vec3 u_hot;
uniform vec4 u_embers[${FIRE_EMBER_VEC4S}];
uniform int u_emberCount;

out vec4 outColor;

const float TAU = 6.2831853;
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);

vec3 toSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}
vec3 toLin(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((max(c, vec3(0.0)) + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float u01(uint n) { return float(pcg(n) >> 8u) * (1.0 / 16777216.0); }
float hcell(ivec2 c, uint seed) {
  return float(pcg(uint(c.x) ^ pcg(uint(c.y) ^ pcg(seed))) >> 8u) * (1.0 / 16777216.0);
}
vec2 grad2(ivec2 c, uint seed) {
  float a = hcell(c, seed) * TAU;
  return vec2(cos(a), sin(a));
}
// Gradient noise, ~[-1, 1].
float gnoise(vec2 p, uint seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = p - floor(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(i, seed), f);
  float b = dot(grad2(i + ivec2(1, 0), seed), f - vec2(1.0, 0.0));
  float c = dot(grad2(i + ivec2(0, 1), seed), f - vec2(0.0, 1.0));
  float d = dot(grad2(i + ivec2(1, 1), seed), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.41421;
}
float fbm4(vec2 p0, uint seed) {
  vec2 p = p0;
  float a = 0.5;
  float s = 0.0;
  for (uint o = 0u; o < 4u; o++) {
    s += a * gnoise(p, seed + o * 131u);
    p = ROT * p * 2.03;
    a *= 0.5;
  }
  return s / 0.9375;
}

float sdRRect(vec2 q, vec2 halfSize, float r) {
  float rr = clamp(r, 0.0, min(halfSize.x, halfSize.y));
  vec2 k = abs(q) - halfSize + rr;
  return length(max(k, vec2(0.0))) + min(max(k.x, k.y), 0.0) - rr;
}
vec2 sdGrad(vec2 q, vec2 halfSize, float r) {
  float e = 0.35;
  float dx = sdRRect(q + vec2(e, 0.0), halfSize, r) - sdRRect(q - vec2(e, 0.0), halfSize, r);
  float dy = sdRRect(q + vec2(0.0, e), halfSize, r) - sdRRect(q - vec2(0.0, e), halfSize, r);
  vec2 g = vec2(dx, dy);
  return g / max(length(g), 1e-5);
}
float gauss(float x, float w) { return exp(-(x * x) / max(w * w, 1e-6)); }
float knee(float x) { return 1.0 - exp(-max(x, 0.0)); }
float bloom(float d, float r, float reach) {
  float o = max(d, 0.0);
  float w = 1.0 - smoothstep(reach * 0.5, reach, o);
  return (0.65 * gauss(o, r * 0.35) + 0.35 * gauss(o, r * 1.2)) * w;
}
vec2 segdist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return vec2(length(p - a - ab * h), h);
}

// Temperature to colour: smoke-dark -> deep red -> orange -> yellow -> white-yellow core.
vec3 fireRamp(float T) {
  vec3 col = mix(vec3(0.012, 0.009, 0.008), u_low, smoothstep(0.04, 0.22, T));
  col = mix(col, u_mid, smoothstep(0.2, 0.5, T));
  col = mix(col, u_hot, smoothstep(0.45, 0.78, T));
  col = mix(col, vec3(1.0, 0.92, 0.74), smoothstep(0.8, 1.08, T));
  return col;
}
// Blackbody colour (linear) for 1000-4000 K (Tanner Helland's fit).
vec3 blackbody(float k) {
  float t = k / 100.0;
  float g = clamp((99.4708 * log(t) - 161.1196) / 255.0, 0.0, 1.0);
  float b = t <= 19.0 ? 0.0 : clamp((138.5177 * log(max(t - 10.0, 1.0)) - 305.0448) / 255.0, 0.0, 1.0);
  return toLin(vec3(1.0, g, b));
}
vec3 flameLight(float T, float gain) {
  float x = max(T, 0.0);
  float e = gain * x * x * x * smoothstep(0.08, 0.3, x);
  return vec3(1.0) - exp(-blackbody(1000.0 + 1700.0 * min(x, 1.3)) * e);
}

// Flames off the host's top edge (fire.wgsl flames(), smoke and swirl removed).
vec4 flames(vec2 p, vec2 q, vec2 halfSize, float d) {
  float H = u_height;
  float sc = max(u_p0.x, 1.0);
  float t = u_time;
  float tr = t * u_p0.y;
  vec2 nrm = sdGrad(q, halfSize, u_radius);
  float up = clamp(-nrm.y, 0.0, 1.0);
  float span = smoothstep(halfSize.x + 2.0, halfSize.x - u_radius * 0.9 - 2.0, abs(q.x));
  float hl = H * smoothstep(0.15, 0.95, up) * span;
  if (hl < 0.5) return vec4(0.0);
  float y = d + 1.5;
  float yn = y / hl;
  if (yn > 1.6 || yn < -0.2) return vec4(0.0);
  float x = p.x / sc;
  float fl = 1.0 + 0.2 * gnoise(vec2(x * 0.45, t * 1.3), u_seed + 7u)
               + 0.07 * gnoise(vec2(x * 1.1 + 9.0, t * 8.0), u_seed + 8u);
  float yh = yn / max(fl, 0.4);
  vec2 wq = vec2(x * 0.7, y / sc * 0.45 - tr * 1.05);
  vec2 w = vec2(gnoise(wq, u_seed), gnoise(wq + vec2(3.7, 1.9), u_seed + 1u)) * u_p0.z * (0.2 + 0.8 * yh);
  float n = fbm4(vec2(x * 1.05, y / sc * 0.5 - tr * 1.6) + w, u_seed + 2u);
  float dens = (1.0 - yh) * 1.2 + n * 0.8 - 0.08;
  float body = smoothstep(0.0, 0.06, dens) * smoothstep(-0.2, 0.05, yn);
  float T = clamp(dens * (0.95 - 0.5 * yh), 0.0, 1.1);
  vec3 emis = fireRamp(T) * body * (0.3 + 0.75 * T * T);
  float bg = u_p0.w * 0.22 * exp(-max(d, 0.0) / max(hl * 0.12, 1.0)) * smoothstep(-1.0, 0.5, d) * span;
  emis += u_mid * bg;
  return vec4(emis, body * u_p1.x);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  float hostH = max(64.0, u_radius * 2.0);
  vec2 halfSize = vec2(u_res.x * 0.5, hostH * 0.5);
  vec2 centre = vec2(u_res.x * 0.5, u_res.y + halfSize.y);
  vec2 q = p - centre;
  float d = sdRRect(q, halfSize, u_radius);

  vec4 f = flames(p, q, halfSize, d);
  vec3 emis = f.rgb;
  float alpha = f.a;

  // Soft glow under the flames.
  float glow = knee(bloom(d, u_p1.z, u_p1.w) * (0.25 + 0.9 * u_heat) * 1.1);
  emis += u_mid * glow;

  // Embers: short shutter streaks with a hot core, cooling as they rise.
  for (int k = 0; k < ${FIRE_EMBER_VEC4S / 2}; k++) {
    if (k >= u_emberCount) break;
    vec4 a = u_embers[k * 2];
    vec4 b = u_embers[k * 2 + 1];
    vec2 sd = segdist(p, a.xy - a.zw, a.xy);
    float T = b.y;
    float core = gauss(sd.x, b.x);
    float halo = gauss(sd.x, b.x * 3.0) * 0.12;
    emis += flameLight(0.45 + T * 0.75, 6.0) * (core * 1.4 + halo) * T;
    alpha += core * T * 0.5;
  }

  float k = u_p1.y * u_heat;
  vec3 s = toSrgb(max(emis * k, vec3(0.0)));
  // TPDF dither only where there is signal (finish()).
  uvec2 ip = uvec2(gl_FragCoord.xy);
  float nz = (u01(ip.x + pcg(ip.y)) + u01(ip.x * 7919u + pcg(ip.y + 104729u))) - 1.0;
  float gate = smoothstep(0.0, 3.0 / 255.0, max(s.r, max(s.g, s.b)));
  s = clamp(s + vec3(nz / 255.0 * gate), 0.0, 1.0);
  // Valid premultiplied output: light at least covers its own brightness, so
  // WebKit composites it as drawn instead of brightening a translucent window
  // into pastel. The canvas sits under the panes, so text is never covered.
  float cover = clamp(alpha * k, 0.0, 1.0);
  outColor = vec4(s, max(cover, max(s.r, max(s.g, s.b))));
}
`;
