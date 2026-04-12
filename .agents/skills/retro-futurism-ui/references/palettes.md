# Retro-Futurism UI — Color Palettes

Complete CSS variable sets for each subgenre. Copy the entire block for your chosen style.
Never mix palettes between subgenres — each has its own visual logic.

---

## 1. Cassette Futurism / Atompunk Terminal (Fallout-inspired)

```css
:root {
  /* Backgrounds */
  --bg: #060e06;
  --screen-bg: #0a1a0a;
  --panel-bg: #0d200d;
  --panel-border: #1a3d1a;

  /* Phosphor green (classic terminal) */
  --primary: #33ff33;
  --primary-bright: #66ff66;
  --primary-dim: rgba(51, 255, 51, 0.35);
  --primary-glow: rgba(51, 255, 51, 0.15);

  /* Alternate phosphor amber (older terminals) */
  --amber: #ffb000;
  --amber-dim: rgba(255, 176, 0, 0.35);

  /* Alerts */
  --warn: #ffff00;
  --danger: #ff4444;
  --ok: #33ff33;

  /* Text */
  --text-bright: #ccffcc;
  --text-normal: #99dd99;
  --text-dim: #446644;

  /* Fonts */
  --font-primary: 'VT323', 'Share Tech Mono', monospace;
  --font-header: 'Orbitron', monospace;

  /* Effects */
  --scanline: rgba(0, 0, 0, 0.18);
  --flicker-amount: 0.03;
}
```

**Visual signature**: Green/amber phosphor glow, CRT scanlines, cursor blink, ASCII art decorations, `>_` prompts

---

## 2. NASA Mission Control / Space Age (Apollo era)

```css
:root {
  /* Backgrounds */
  --bg: #060a14;
  --panel-bg: #0a1020;
  --panel-border: #1a3050;
  --panel-border-active: #2a5080;

  /* Sky blue (core — evokes NASA displays) */
  --primary: #4fc3f7;
  --primary-bright: #81d4fa;
  --primary-dim: rgba(79, 195, 247, 0.25);
  --primary-glow: rgba(79, 195, 247, 0.12);

  /* White for critical data */
  --data-white: #e8f4fd;
  --data-dim: rgba(232, 244, 253, 0.6);

  /* Alert sequence (NASA uses orange before red) */
  --caution: #ffd54f;   /* advisory */
  --warn: #ff6b35;      /* caution */
  --danger: #ff1744;    /* emergency */
  --ok: #69f0ae;        /* nominal */

  /* Fonts */
  --font-display: 'Orbitron', sans-serif;
  --font-data: 'Share Tech Mono', monospace;
  --font-label: 'Rajdhani', sans-serif;

  /* Effects */
  --vignette: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.7) 100%);
}
```

**Visual signature**: Dark blue panels, cool sky-blue readouts, clean geometric layout, military-precision labels, orbital diagrams

---

## 3. Raygun Gothic / Art Deco Tech (1930s–50s)

```css
:root {
  /* Backgrounds */
  --bg: #0a0804;
  --panel-bg: #14100a;
  --panel-border: #3d2f0a;
  --panel-accent: #5a4510;

  /* Gold / Amber (art deco warmth) */
  --primary: #d4af37;
  --primary-bright: #f5c842;
  --primary-dim: rgba(212, 175, 55, 0.25);
  --primary-glow: rgba(212, 175, 55, 0.10);

  /* Copper / Bronze (secondary metal) */
  --secondary: #b87333;
  --secondary-bright: #cd8b3a;

  /* Chrome (highlights) */
  --chrome: #c8c8c8;
  --chrome-dim: rgba(200, 200, 200, 0.4);

  /* Alerts */
  --warn: #ff8c00;
  --danger: #8b0000;
  --ok: #4a7c59;

  /* Text */
  --text-bright: #f0e0a0;
  --text-normal: #c8a060;
  --text-dim: #6b5020;

  /* Fonts */
  --font-display: 'Orbitron', sans-serif;
  --font-body: 'Rajdhani', sans-serif;
  --font-data: 'Share Tech Mono', monospace;

  /* Structural */
  --notch-size: 12px;
  --border-width: 2px;
}
```

**Visual signature**: Gold borders, notched corners, fan-shaped gauges, ornamental dividers, warm dark backgrounds

---

## 4. Cassette Futurism / VHS Era (Alien / WarGames style)

```css
:root {
  /* Backgrounds */
  --bg: #03030a;
  --panel-bg: #07070f;
  --panel-border: #14143d;

  /* Matrix green (hacker terminal) */
  --primary: #00ff41;
  --primary-bright: #39ff84;
  --primary-dim: rgba(0, 255, 65, 0.25);

  /* Magenta (VHS second channel) */
  --magenta: #ff00ff;
  --magenta-dim: rgba(255, 0, 255, 0.3);

  /* Cyan (system highlights) */
  --cyan: #00ffff;
  --cyan-dim: rgba(0, 255, 255, 0.25);

  /* Alerts */
  --warn: #ffff00;
  --danger: #ff0000;
  --ok: #00ff41;

  /* Text */
  --text-bright: #ccffcc;
  --text-dim: rgba(0, 255, 65, 0.4);

  /* Fonts */
  --font-primary: 'Share Tech Mono', 'VT323', monospace;
  --font-pixel: 'Press Start 2P', monospace;

  /* VHS noise */
  --noise-opacity: 0.04;
  --scanline-gap: 2px;
}
```

**Visual signature**: Pure black, electric green, magenta/cyan accent, glitch effects, VHS tracking artifacts, pixel fonts

---

## 5. Soviet Cosmism / Constructivist Tech (Soyuz / Space Race)

```css
:root {
  /* Backgrounds */
  --bg: #0d0a08;
  --panel-bg: #1a0f0a;
  --panel-border: #3d1a0a;

  /* Soviet Red (primary) */
  --primary: #e63946;
  --primary-bright: #ff4d5a;
  --primary-dim: rgba(230, 57, 70, 0.25);
  --primary-glow: rgba(230, 57, 70, 0.12);

  /* Gold (constructivist accent) */
  --gold: #f4d03f;
  --gold-dim: rgba(244, 208, 63, 0.25);

  /* Steel (structural elements) */
  --steel: #aab4be;
  --steel-dim: rgba(170, 180, 190, 0.3);

  /* Alerts */
  --warn: #f4d03f;
  --danger: #e63946;
  --ok: #2ecc71;

  /* Text */
  --text-bright: #f5f5f0;
  --text-normal: #c8c0b0;
  --text-dim: #6b5a4a;

  /* Fonts */
  --font-display: 'Orbitron', 'Rajdhani', sans-serif;
  --font-data: 'Share Tech Mono', monospace;

  /* Constructivist geometry */
  --stripe-angle: -45deg;
  --hazard-stripe: repeating-linear-gradient(
    var(--stripe-angle),
    var(--primary) 0px, var(--primary) 6px,
    transparent 6px, transparent 14px
  );
}
```

**Visual signature**: Red and gold on near-black, bold geometric shapes, diagonal hazard stripes, stark sans-serif labels, functional-first layout

---

## Glow Recipe Reference

Always use multi-layer shadows for authentic phosphor/neon glow:

```css
/* Terminal phosphor green */
.glow-green {
  text-shadow:
    0 0 4px #33ff33,
    0 0 12px rgba(51, 255, 51, 0.6),
    0 0 24px rgba(51, 255, 51, 0.3);
}

/* NASA blue readout */
.glow-blue {
  text-shadow:
    0 0 4px #4fc3f7,
    0 0 12px rgba(79, 195, 247, 0.5),
    0 0 24px rgba(79, 195, 247, 0.2);
}

/* Art deco gold */
.glow-gold {
  text-shadow:
    0 0 4px #d4af37,
    0 0 12px rgba(212, 175, 55, 0.4),
    0 0 20px rgba(212, 175, 55, 0.15);
}

/* Box glow (for panels/buttons) */
.panel-glow-blue {
  box-shadow:
    0 0 0 1px rgba(79, 195, 247, 0.3),
    0 0 10px rgba(79, 195, 247, 0.15),
    inset 0 0 20px rgba(79, 195, 247, 0.05);
}
```
