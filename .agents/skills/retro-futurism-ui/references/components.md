# Retro-Futurism UI — Component Library

Copy-paste HTML/CSS components. Apply your subgenre palette from `palettes.md` first.

---

## 1. CRT Terminal Window

```html
<div class="crt-window">
  <div class="crt-titlebar">
    <span class="crt-title">SYSTEM TERMINAL v2.1</span>
    <span class="crt-status">● ONLINE</span>
  </div>
  <div class="crt-screen">
    <div class="crt-scanlines"></div>
    <div class="crt-content">
      <p class="crt-line">> SYSTEM BOOT SEQUENCE INITIATED</p>
      <p class="crt-line">> MEMORY CHECK: 640K OK</p>
      <p class="crt-line">> LOADING MODULES<span class="crt-cursor"></span></p>
    </div>
  </div>
</div>
```

```css
.crt-window {
  background: var(--screen-bg, #0a1a0a);
  border: 2px solid var(--primary, #33ff33);
  font-family: var(--font-primary, 'VT323', monospace);
  position: relative;
  overflow: hidden;
}
.crt-titlebar {
  background: var(--primary, #33ff33);
  color: #000;
  padding: 4px 12px;
  display: flex;
  justify-content: space-between;
  font-size: 14px;
  letter-spacing: 0.1em;
}
.crt-screen { position: relative; padding: 20px; }
.crt-scanlines {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg, rgba(0,0,0,0.15) 0, rgba(0,0,0,0.15) 1px,
    transparent 1px, transparent 3px
  );
  pointer-events: none;
  z-index: 2;
}
.crt-line {
  color: var(--primary, #33ff33);
  font-size: 20px;
  line-height: 1.4;
  text-shadow: 0 0 6px currentColor;
  margin: 0;
}
.crt-cursor::after {
  content: '█';
  animation: cursor-blink 1s step-end infinite;
}
@keyframes cursor-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
```

---

## 2. NASA Panel with Corner Brackets

```html
<div class="mc-panel">
  <div class="mc-panel-label">TELEMETRY SUBSYSTEM</div>
  <div class="mc-panel-content">
    <!-- content here -->
  </div>
</div>
```

```css
.mc-panel {
  background: var(--panel-bg, #0a1020);
  border: 1px solid var(--panel-border, #1a3050);
  padding: 16px;
  position: relative;
}
/* Corner bracket — top left */
.mc-panel::before {
  content: '';
  position: absolute;
  top: -2px; left: -2px;
  width: 14px; height: 14px;
  border-top: 2px solid var(--primary, #4fc3f7);
  border-left: 2px solid var(--primary, #4fc3f7);
}
/* Corner bracket — bottom right */
.mc-panel::after {
  content: '';
  position: absolute;
  bottom: -2px; right: -2px;
  width: 14px; height: 14px;
  border-bottom: 2px solid var(--primary, #4fc3f7);
  border-right: 2px solid var(--primary, #4fc3f7);
}
.mc-panel-label {
  font-family: var(--font-label, 'Rajdhani', sans-serif);
  font-size: 11px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--primary-dim, rgba(79,195,247,0.5));
  margin-bottom: 12px;
}
```

---

## 3. Seven-Segment Display

```html
<div class="seg-display">
  <div class="seg-label">ALTITUDE</div>
  <div class="seg-value" data-value="247.3">247.3</div>
  <div class="seg-unit">KM</div>
</div>
```

```css
.seg-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.seg-label {
  font-family: var(--font-label, 'Rajdhani');
  font-size: 10px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--primary-dim, rgba(79,195,247,0.5));
}
.seg-value {
  font-family: 'Share Tech Mono', monospace;
  font-size: 48px;
  line-height: 1;
  color: var(--primary, #4fc3f7);
  text-shadow: 0 0 8px currentColor, 0 0 20px rgba(79,195,247,0.4);
  /* Ghost digits for unused segments — classic LED look */
  position: relative;
}
.seg-value::before {
  content: attr(data-value);
  position: absolute;
  inset: 0;
  color: var(--primary-dim, rgba(79,195,247,0.1));
  /* Replace all digits with 8 to show ghost segments */
  font-feature-settings: "tnum";
}
.seg-unit {
  font-family: var(--font-label, 'Rajdhani');
  font-size: 12px;
  letter-spacing: 0.2em;
  color: var(--primary-dim);
}
```

---

## 4. SVG Analog Gauge

```html
<svg class="analog-gauge" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg">
  <!-- Track arc (background) -->
  <path class="gauge-track" d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke-width="8"/>
  <!-- Value arc (foreground) — use stroke-dashoffset to animate -->
  <path class="gauge-fill" d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke-width="8"
    stroke-dasharray="251" stroke-dashoffset="75"/>
  <!-- Needle -->
  <line class="gauge-needle" x1="100" y1="100" x2="100" y2="30"
    transform="rotate(-70 100 100)"/>
  <!-- Center hub -->
  <circle cx="100" cy="100" r="6" class="gauge-hub"/>
  <!-- Tick marks -->
  <g class="gauge-ticks">
    <line x1="20" y1="100" x2="28" y2="100" transform="rotate(-90 100 100)"/>
    <line x1="20" y1="100" x2="26" y2="100" transform="rotate(-67.5 100 100)"/>
    <!-- Add more ticks as needed -->
  </g>
  <!-- Labels -->
  <text x="100" y="80" class="gauge-value" text-anchor="middle">72%</text>
  <text x="100" y="115" class="gauge-label" text-anchor="middle">POWER</text>
</svg>
```

```css
.analog-gauge { overflow: visible; }
.gauge-track { stroke: var(--primary-dim, rgba(79,195,247,0.15)); }
.gauge-fill {
  stroke: var(--primary, #4fc3f7);
  filter: drop-shadow(0 0 4px var(--primary));
  transition: stroke-dashoffset 1s ease;
}
.gauge-needle {
  stroke: var(--data-white, #e8f4fd);
  stroke-width: 2;
  stroke-linecap: round;
}
.gauge-hub { fill: var(--primary); }
.gauge-ticks { stroke: var(--primary-dim); stroke-width: 1.5; }
.gauge-value {
  font-family: var(--font-data, 'Share Tech Mono');
  font-size: 18px;
  fill: var(--primary);
  filter: drop-shadow(0 0 4px currentColor);
}
.gauge-label {
  font-family: var(--font-label, 'Rajdhani');
  font-size: 10px;
  letter-spacing: 0.2em;
  fill: var(--primary-dim);
  text-transform: uppercase;
}
```

---

## 5. ASCII Progress Bar

```html
<div class="ascii-progress">
  <div class="ascii-label">DATA TRANSFER</div>
  <div class="ascii-bar">
    <span class="ascii-filled">████████████</span><span class="ascii-empty">░░░░</span>
  </div>
  <div class="ascii-value">75%</div>
</div>
```

```css
.ascii-progress { display: flex; align-items: center; gap: 10px; }
.ascii-label {
  font-family: var(--font-data, 'VT323', monospace);
  font-size: 16px;
  letter-spacing: 0.1em;
  color: var(--primary-dim);
  min-width: 130px;
}
.ascii-bar {
  font-family: var(--font-data, 'VT323', monospace);
  font-size: 20px;
  line-height: 1;
}
.ascii-filled { color: var(--primary); text-shadow: 0 0 6px currentColor; }
.ascii-empty { color: var(--primary-dim); }
.ascii-value {
  font-family: var(--font-data);
  font-size: 16px;
  color: var(--primary);
  min-width: 35px;
  text-align: right;
}
```

---

## 6. Indicator Light Matrix (Apollo DSKY style)

```html
<div class="indicator-matrix">
  <div class="indicator on">NOMINAL</div>
  <div class="indicator warn">CAUTION</div>
  <div class="indicator danger blink">ALERT</div>
  <div class="indicator off">STANDBY</div>
</div>
```

```css
.indicator-matrix {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 6px;
}
.indicator {
  background: var(--panel-bg, #0a1020);
  border: 1px solid rgba(255,255,255,0.1);
  padding: 6px 8px;
  font-family: var(--font-data, 'Share Tech Mono');
  font-size: 10px;
  letter-spacing: 0.15em;
  text-align: center;
  text-transform: uppercase;
  transition: all 0.2s;
}
.indicator.on {
  border-color: var(--ok, #69f0ae);
  color: var(--ok);
  box-shadow: 0 0 8px rgba(105,240,174,0.3), inset 0 0 10px rgba(105,240,174,0.1);
}
.indicator.warn {
  border-color: var(--caution, #ffd54f);
  color: var(--caution);
  box-shadow: 0 0 8px rgba(255,213,79,0.3), inset 0 0 10px rgba(255,213,79,0.1);
}
.indicator.danger {
  border-color: var(--danger, #ff1744);
  color: var(--danger);
  box-shadow: 0 0 12px rgba(255,23,68,0.4), inset 0 0 10px rgba(255,23,68,0.15);
}
.indicator.off { color: rgba(255,255,255,0.15); border-color: rgba(255,255,255,0.05); }
.indicator.blink { animation: alert-flash 0.8s step-end infinite; }
@keyframes alert-flash {
  0%,100%{ background:transparent }
  50%{ background: rgba(255,23,68,0.2) }
}
```

---

## 7. Art Deco Panel (Notched Corners)

```html
<div class="deco-panel">
  <div class="deco-panel-inner">
    <div class="deco-title">
      <span class="deco-rule-left">◈</span>
      SECTOR ANALYSIS
      <span class="deco-rule-right">◈</span>
    </div>
    <!-- content -->
  </div>
</div>
```

```css
.deco-panel {
  position: relative;
  background: var(--panel-bg, #14100a);
  border: 2px solid var(--primary, #d4af37);
  clip-path: polygon(
    14px 0%, calc(100% - 14px) 0%,
    100% 14px, 100% calc(100% - 14px),
    calc(100% - 14px) 100%, 14px 100%,
    0% calc(100% - 14px), 0% 14px
  );
  padding: 20px;
  box-shadow: 0 0 0 4px var(--bg, #0a0804),
              0 0 0 5px var(--primary, #d4af37),
              0 0 20px rgba(212,175,55,0.15);
}
.deco-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display, 'Orbitron');
  font-size: 12px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--primary, #d4af37);
  text-shadow: 0 0 8px currentColor;
  margin-bottom: 16px;
}
.deco-title::before, .deco-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--primary, #d4af37));
}
.deco-title::after { background: linear-gradient(90deg, var(--primary, #d4af37), transparent); }
```

---

## 8. Boot Sequence Animation

```html
<div class="boot-sequence" id="boot">
  <p class="boot-line" style="animation-delay: 0s">INITIALIZING SYSTEMS...</p>
  <p class="boot-line" style="animation-delay: 0.4s">MEMORY: 128K VERIFIED</p>
  <p class="boot-line" style="animation-delay: 0.8s">SENSOR ARRAY: ONLINE</p>
  <p class="boot-line" style="animation-delay: 1.2s">UPLINK: ESTABLISHED</p>
  <p class="boot-line" style="animation-delay: 1.6s">READY<span class="crt-cursor"></span></p>
</div>
```

```css
.boot-line {
  font-family: var(--font-primary, 'VT323');
  font-size: 20px;
  color: var(--primary, #33ff33);
  text-shadow: 0 0 6px currentColor;
  overflow: hidden;
  white-space: nowrap;
  max-width: 100%;
  opacity: 0;
  animation: boot-reveal 0.3s ease forwards;
}
@keyframes boot-reveal {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

---

## 9. Telemetry Row

```html
<div class="telemetry-row">
  <span class="telem-label">HULL TEMP</span>
  <span class="telem-bar">···············▮▮▮▮▮▮</span>
  <span class="telem-value">847</span>
  <span class="telem-unit">°K</span>
  <span class="telem-status warn">HIGH</span>
</div>
```

```css
.telemetry-row {
  display: grid;
  grid-template-columns: 130px 1fr 70px 40px 60px;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-family: var(--font-data, 'Share Tech Mono');
  font-size: 13px;
}
.telem-label {
  color: var(--text-dim, #6b5020);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 11px;
}
.telem-bar { color: var(--primary-dim); letter-spacing: -0.05em; font-size: 11px; }
.telem-value { color: var(--primary); text-shadow: 0 0 6px currentColor; text-align: right; }
.telem-unit { color: var(--primary-dim); font-size: 11px; }
.telem-status {
  font-size: 10px;
  letter-spacing: 0.15em;
  padding: 2px 5px;
  border: 1px solid currentColor;
  text-align: center;
}
.telem-status.ok   { color: var(--ok);  border-color: var(--ok); }
.telem-status.warn { color: var(--warn); border-color: var(--warn); animation: alert-flash 1.5s step-end infinite; }
.telem-status.danger { color: var(--danger); border-color: var(--danger); }
```
