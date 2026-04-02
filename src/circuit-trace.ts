// Krypton — Circuit Trace Audio Visualizer
// PCB-style orthogonal signal traces that light up in response to audio
// frequency data. Renders behind terminal windows on a workspace-level canvas.

import type { RenderCtx } from './flame';

// ─── Types ────────────────────────────────────────────────────────

interface TraceSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  band: number;       // 0 = low (power), 1 = mid (data), 2 = high (signal)
  thickness: number;
}

interface TracePulse {
  segIdx: number;
  position: number;   // 0.0–1.0 along segment
  speed: number;
  intensity: number;
  decay: number;
}

interface Chip {
  x: number;
  y: number;
  w: number;
  h: number;
  pins: { x: number; y: number; side: 'top' | 'bottom' | 'left' | 'right' }[];
}

interface Via {
  x: number;
  y: number;
  radius: number;
}

// ─── Constants ────────────────────────────────────────────────────

const GRID = 20;
const MIN_CHIPS = 6;
const MAX_CHIPS = 14;
const BAND_COLORS = [
  [0, 220, 255],    // cyan — power/low freq
  [0, 255, 100],    // green — data/mid freq
  [255, 180, 0],    // amber — signal/high freq
];
const BAND_THICKNESS = [3, 2, 1];
const PULSE_SPEED_BASE = [0.008, 0.012, 0.02];
const TRACE_DIM_ALPHA = 0.08;
const GLOW_BLUR = 8;

// ─── Renderer ─────────────────────────────────────────────────────

export class CircuitTraceRenderer {
  private segments: TraceSegment[] = [];
  private pulses: TracePulse[] = [];
  private chips: Chip[] = [];
  private vias: Via[] = [];
  private fftBins: Float32Array = new Float32Array(32);
  private W = 0;
  private H = 0;
  private frameCount = 0;

  setFftBins(bins: number[]): void {
    for (let i = 0; i < Math.min(bins.length, 32); i++) {
      this.fftBins[i] = bins[i];
    }
  }

  init(W: number, H: number): void {
    this.W = W;
    this.H = H;
    this.segments = [];
    this.pulses = [];
    this.chips = [];
    this.vias = [];
    this.frameCount = 0;
    this.generateBoard();
  }

  update(ctx: RenderCtx, W: number, H: number): void {
    if (this.W !== W || this.H !== H) this.init(W, H);
    this.frameCount++;
    this.spawnPulses();
    this.updatePulses();
    this.draw(ctx);
  }

  // ─── Board Generation ──────────────────────────────────────────

  private generateBoard(): void {
    const cols = Math.floor(this.W / GRID);
    const rows = Math.floor(this.H / GRID);

    // Place chips
    const chipCount = Math.min(MAX_CHIPS, Math.max(MIN_CHIPS, Math.floor((cols * rows) / 200)));
    for (let i = 0; i < chipCount; i++) {
      const attempts = 50;
      for (let a = 0; a < attempts; a++) {
        const cw = (2 + Math.floor(Math.random() * 3)) * GRID;
        const ch = (1 + Math.floor(Math.random() * 2)) * GRID;
        const cx = Math.floor(Math.random() * (cols - cw / GRID - 4) + 2) * GRID;
        const cy = Math.floor(Math.random() * (rows - ch / GRID - 4) + 2) * GRID;

        // Check overlap
        const overlaps = this.chips.some(
          (c) =>
            cx < c.x + c.w + GRID * 3 &&
            cx + cw + GRID * 3 > c.x &&
            cy < c.y + c.h + GRID * 3 &&
            cy + ch + GRID * 3 > c.y
        );
        if (overlaps) continue;

        const chip: Chip = { x: cx, y: cy, w: cw, h: ch, pins: [] };

        // Generate pins on each side
        const pinSpacing = GRID;
        for (let px = cx + pinSpacing; px < cx + cw; px += pinSpacing) {
          chip.pins.push({ x: px, y: cy, side: 'top' });
          chip.pins.push({ x: px, y: cy + ch, side: 'bottom' });
        }
        for (let py = cy + pinSpacing; py < cy + ch; py += pinSpacing) {
          chip.pins.push({ x: cx, y: py, side: 'left' });
          chip.pins.push({ x: cx + cw, y: py, side: 'right' });
        }

        this.chips.push(chip);
        break;
      }
    }

    // Route traces between chip pins
    const allPins: { x: number; y: number; chipIdx: number }[] = [];
    this.chips.forEach((chip, ci) => {
      chip.pins.forEach((pin) => {
        allPins.push({ x: pin.x, y: pin.y, chipIdx: ci });
      });
    });

    // Connect pins from different chips with orthogonal routes
    const used = new Set<number>();
    for (let i = 0; i < allPins.length; i++) {
      if (used.has(i)) continue;

      // Find a nearby pin on a different chip
      let bestJ = -1;
      let bestDist = Infinity;
      for (let j = i + 1; j < allPins.length; j++) {
        if (used.has(j)) continue;
        if (allPins[j].chipIdx === allPins[i].chipIdx) continue;
        const dx = Math.abs(allPins[j].x - allPins[i].x);
        const dy = Math.abs(allPins[j].y - allPins[i].y);
        const dist = dx + dy; // Manhattan
        if (dist < bestDist && dist > GRID * 2) {
          bestDist = dist;
          bestJ = j;
        }
      }

      if (bestJ === -1) continue;
      used.add(i);
      used.add(bestJ);

      const p1 = allPins[i];
      const p2 = allPins[bestJ];

      // Assign to frequency band based on distance
      const band = bestDist < GRID * 8 ? 2 : bestDist < GRID * 16 ? 1 : 0;

      // Route: horizontal from p1, then vertical to p2's y, then horizontal to p2
      const midX = this.snapToGrid((p1.x + p2.x) / 2);
      const thickness = BAND_THICKNESS[band];

      // Horizontal from p1 to midX
      if (p1.x !== midX) {
        this.segments.push({
          x1: p1.x, y1: p1.y,
          x2: midX, y2: p1.y,
          band, thickness,
        });
      }

      // Vertical from p1.y to p2.y at midX
      if (p1.y !== p2.y) {
        this.segments.push({
          x1: midX, y1: p1.y,
          x2: midX, y2: p2.y,
          band, thickness,
        });
        // Add via at corner
        this.vias.push({ x: midX, y: p1.y, radius: thickness + 1 });
      }

      // Horizontal from midX to p2
      if (midX !== p2.x) {
        this.segments.push({
          x1: midX, y1: p2.y,
          x2: p2.x, y2: p2.y,
          band, thickness,
        });
        this.vias.push({ x: midX, y: p2.y, radius: thickness + 1 });
      }
    }

    // Add some standalone horizontal/vertical "bus" traces
    const busCount = Math.floor(Math.random() * 4) + 2;
    for (let b = 0; b < busCount; b++) {
      const horizontal = Math.random() > 0.5;
      const band = Math.floor(Math.random() * 3);
      if (horizontal) {
        const y = this.snapToGrid(GRID * 3 + Math.random() * (this.H - GRID * 6));
        const x1 = this.snapToGrid(GRID + Math.random() * this.W * 0.2);
        const x2 = this.snapToGrid(this.W * 0.8 + Math.random() * this.W * 0.15);
        this.segments.push({
          x1, y1: y, x2, y2: y,
          band, thickness: BAND_THICKNESS[band],
        });
      } else {
        const x = this.snapToGrid(GRID * 3 + Math.random() * (this.W - GRID * 6));
        const y1 = this.snapToGrid(GRID + Math.random() * this.H * 0.2);
        const y2 = this.snapToGrid(this.H * 0.8 + Math.random() * this.H * 0.15);
        this.segments.push({
          x1: x, y1, x2: x, y2,
          band, thickness: BAND_THICKNESS[band],
        });
      }
    }
  }

  private snapToGrid(v: number): number {
    return Math.round(v / GRID) * GRID;
  }

  // ─── Pulse Management ──────────────────────────────────────────

  private spawnPulses(): void {
    // Only spawn every few frames
    if (this.frameCount % 2 !== 0) return;

    for (let band = 0; band < 3; band++) {
      // Average FFT energy for this band
      const binStart = Math.floor((band / 3) * 32);
      const binEnd = Math.floor(((band + 1) / 3) * 32);
      let energy = 0;
      for (let i = binStart; i < binEnd; i++) {
        energy += this.fftBins[i];
      }
      energy /= (binEnd - binStart);

      // Always have a minimum ambient pulse rate so the board looks alive
      const ambientRate = 0.03;
      const spawnRate = Math.max(ambientRate, energy * 3);
      if (Math.random() > spawnRate) continue;

      // Pick a random segment in this band
      const bandSegs = this.segments
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.band === band);
      if (bandSegs.length === 0) continue;

      const choice = bandSegs[Math.floor(Math.random() * bandSegs.length)];
      this.pulses.push({
        segIdx: choice.i,
        position: 0,
        speed: PULSE_SPEED_BASE[band] * (0.8 + energy * 1.5),
        intensity: 0.3 + energy * 0.7,
        decay: 0.992 + energy * 0.005,
      });
    }

    // Cap pulse count
    if (this.pulses.length > 200) {
      this.pulses = this.pulses.slice(-150);
    }
  }

  private updatePulses(): void {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.position += p.speed;
      p.intensity *= p.decay;

      if (p.position > 1.2 || p.intensity < 0.01) {
        this.pulses.splice(i, 1);
      }
    }
  }

  // ─── Drawing ───────────────────────────────────────────────────

  private draw(ctx: RenderCtx): void {
    // Substrate dots (subtle grid)
    ctx.fillStyle = 'rgba(30, 60, 40, 0.04)';
    for (let x = GRID; x < this.W; x += GRID * 4) {
      for (let y = GRID; y < this.H; y += GRID * 4) {
        ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
      }
    }

    // Draw chips (IC packages)
    for (const chip of this.chips) {
      ctx.strokeStyle = 'rgba(80, 120, 90, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(chip.x, chip.y, chip.w, chip.h);

      // Pin markers
      ctx.fillStyle = 'rgba(100, 150, 110, 0.12)';
      for (const pin of chip.pins) {
        ctx.fillRect(pin.x - 1.5, pin.y - 1.5, 3, 3);
      }

      // Notch on top-left
      ctx.beginPath();
      ctx.arc(chip.x + 4, chip.y + 4, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(80, 120, 90, 0.1)';
      ctx.fill();
    }

    // Draw vias (dim)
    for (const via of this.vias) {
      ctx.beginPath();
      ctx.arc(via.x, via.y, via.radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(100, 150, 110, 0.1)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(80, 120, 90, 0.06)';
      ctx.fill();
    }

    // Draw trace segments (dim base)
    for (const seg of this.segments) {
      const [r, g, b] = BAND_COLORS[seg.band];
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${TRACE_DIM_ALPHA})`;
      ctx.lineWidth = seg.thickness;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
    }

    // Draw pulses (bright glow along traces)
    ctx.save();
    for (const pulse of this.pulses) {
      const seg = this.segments[pulse.segIdx];
      if (!seg) continue;

      const [r, g, b] = BAND_COLORS[seg.band];
      const px = seg.x1 + (seg.x2 - seg.x1) * pulse.position;
      const py = seg.y1 + (seg.y2 - seg.y1) * pulse.position;

      // Trail
      const trailLen = 0.15;
      const trailPos = Math.max(0, pulse.position - trailLen);
      const tx = seg.x1 + (seg.x2 - seg.x1) * trailPos;
      const ty = seg.y1 + (seg.y2 - seg.y1) * trailPos;

      // Glow line (trail to head)
      const gradient = ctx.createLinearGradient(tx, ty, px, py);
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${pulse.intensity * 0.8})`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = seg.thickness + 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(px, py);
      ctx.stroke();

      // Head glow dot
      ctx.beginPath();
      ctx.arc(px, py, seg.thickness + 1, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${pulse.intensity})`;
      ctx.fill();

      // Outer glow (shadowBlur is expensive in workers, use radial gradient)
      ctx.beginPath();
      ctx.arc(px, py, GLOW_BLUR, 0, Math.PI * 2);
      const glow = ctx.createRadialGradient(px, py, 0, px, py, GLOW_BLUR);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${pulse.intensity * 0.4})`);
      glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = glow;
      ctx.fill();
    }
    ctx.restore();
  }
}
