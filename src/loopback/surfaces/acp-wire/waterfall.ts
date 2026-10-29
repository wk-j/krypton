// Spec 288 — per-lane waterfall of the last 60 s: request spans (latency) and
// notification ticks. Colors are token vars, resolved by the SVG renderer.

import type { Held, Selection, WireSummary } from './model';
import { fmtUs, isGap, isGroup, WINDOW_US } from './model';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

export function paintWaterfall(
  svg: SVGSVGElement,
  events: readonly Held[],
  summary: WireSummary | null,
  laneFilter: string,
  sel: Selection | null,
): void {
  const W = 1000;
  const x0 = 110;
  const rowH = 36;
  const top = 16;
  const now = summary ? summary.nowMonoUs : 0;
  const start = now - WINDOW_US;
  const lanes: string[] = [];
  for (const e of events) if (!isGap(e) && !lanes.includes(e.lane)) lanes.push(e.lane);
  const H = Math.max(44, top + lanes.length * rowH + 4);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const sx = (t: number): number => x0 + Math.max(0, Math.min(1, (t - start) / WINDOW_US)) * (W - x0 - 10);
  const out: SVGElement[] = [];
  for (let k = 0; k <= 6; k++) {
    const gx = x0 + (k / 6) * (W - x0 - 10);
    out.push(svgEl('line', { x1: gx, y1: 12, x2: gx, y2: H - 2, stroke: 'var(--border)', 'stroke-width': 1 }));
    out.push(
      k === 6
        ? svgEl('text', { x: gx - 3, y: 10, 'font-size': 9, fill: 'var(--muted)', 'text-anchor': 'end' }, 'now')
        : svgEl('text', { x: gx + 3, y: 10, 'font-size': 9, fill: 'var(--muted)' }, `-${60 - k * 10}s`),
    );
  }
  if (!lanes.length) {
    out.push(svgEl('text', { x: x0, y: 32, 'font-size': 11, fill: 'var(--muted)' }, 'no events in window'));
  }
  const selSeq = sel && !isGroup(sel) ? sel.seq : null;
  lanes.forEach((lane, li) => {
    const y = top + li * rowH;
    const dim = laneFilter !== 'all' && laneFilter !== lane;
    const g = svgEl('g', { opacity: dim ? 0.25 : 1 });
    g.append(svgEl('text', { x: 4, y: y + 16, 'font-size': 11, fill: 'var(--fg)' }, lane));
    for (const ev of events) {
      if (isGap(ev) || ev.lane !== lane || ev.dir === 'to_ui') continue;
      if (ev.kind === 'notification') {
        if (ev.monoUs < start) continue;
        const nx = sx(ev.monoUs);
        g.append(
          svgEl('line', {
            x1: nx,
            y1: y + 22,
            x2: nx,
            y2: y + 30,
            stroke: 'var(--fg)',
            'stroke-opacity': 0.35,
            'stroke-width': 1,
          }),
        );
      } else if (ev.kind === 'request') {
        const end = ev.latencyUs != null ? ev.monoUs + ev.latencyUs : now;
        if (end < start) continue;
        const outbound = ev.dir === 'to_agent';
        const x1 = sx(ev.monoUs);
        const attrs: Record<string, string | number> = {
          'data-seq': ev.seq,
          x: x1,
          y: outbound ? y + 4 : y + 13,
          width: Math.max(2, sx(end) - x1),
          height: outbound ? 8 : 6,
          rx: 2,
          fill: ev.error ? 'var(--del)' : outbound ? 'var(--accent)' : 'var(--muted)',
          class: 'lb-acp-wire__span',
        };
        if (ev.latencyUs == null) attrs['fill-opacity'] = 0.55;
        if (selSeq !== null && (selSeq === ev.seq || selSeq === ev.pairSeq)) {
          attrs.stroke = 'var(--fg)';
          attrs['stroke-width'] = 1.5;
        }
        const rect = svgEl('rect', attrs);
        rect.append(
          svgEl(
            'title',
            {},
            `${ev.method ?? ''} #${ev.id ?? ''} · ${ev.latencyUs != null ? fmtUs(ev.latencyUs) : 'in flight'}`,
          ),
        );
        g.append(rect);
      }
    }
    out.push(g);
  });
  svg.replaceChildren(...out);
}

export function createWaterfallSvg(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'lb-acp-wire__wf');
  svg.setAttribute('viewBox', '0 0 1000 60');
  svg.setAttribute('preserveAspectRatio', 'none');
  return svg;
}
