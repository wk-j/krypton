// Spec 0355 / 400 — a system map drawn as inline SVG: the e2e explorer's run
// map and the bug trail's map. Geometry comes from `layout.ts` (a port of
// valence's map layout, checked against Go goldens); this component only turns
// it into React SVG elements, so every project string — node, group and edge
// labels, pin texts and titles — is a text node, never parsed markup. The
// surface decides how each pin, edge and node looks through the callbacks;
// sysmap.css colours them from the page tokens.

import type { JSX } from 'react';

import { pinKeyCellPath } from './layout';
import type { DrawnEdge, DrawnNode, DrawnPin, MapDrawing, TextLine } from './layout';

import './sysmap.css';

export { layoutMap, pinKeyCellPath } from './layout';
export type { DrawnEdge, DrawnGroup, DrawnNode, DrawnPin, LayoutPin, MapDrawing, SystemMap } from './layout';

/** A pin's colour, from the page tokens. */
export type SysMapTone = 'fg' | 'accent' | 'del' | 'add' | 'muted';

export interface PinLook {
  readonly tone: SysMapTone;
  /** A dashed outline: not settled (a suspect, a skipped check). */
  readonly dashed?: boolean;
  /** A heavier outline: what the reader should see first (a failure, a cited cause). */
  readonly strong?: boolean;
  /** A tinted fill: proven (a reproduced cause). */
  readonly filled?: boolean;
  /** Dimmed: not reached yet (a later step). */
  readonly dim?: boolean;
}

/** `path`: the edge is the highlighted route, dotted; `proven`: the same, solid. */
export type EdgeLook = 'path' | 'proven' | null;

export interface SysMapProps {
  readonly drawing: MapDrawing;
  readonly alt: string;
  readonly pinLook: (pin: DrawnPin) => PinLook;
  readonly edgeLook?: (edge: DrawnEdge) => EdgeLook;
  /** Draw a lit node dashed and grey anyway (a part ruled out). */
  readonly nodeMuted?: (node: DrawnNode) => boolean;
  /** The map shrinks to this share of its size at most, then scrolls. */
  readonly minScale?: number;
}

const num = (v: number): string => String(Math.round(v * 100) / 100);

function classes(...names: readonly (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

function Lines({ lines }: { readonly lines: readonly TextLine[] }): JSX.Element {
  return (
    <>
      {lines.map((line, i) => (
        <text key={i} x={num(line.x)} y={num(line.y)} textAnchor="middle" dominantBaseline="central">
          {line.text}
        </text>
      ))}
    </>
  );
}

function Pin({ pin, look }: { readonly pin: DrawnPin; readonly look: PinLook }): JSX.Element {
  const keyOnly = pin.keyW >= pin.box.w;
  return (
    <g
      className={classes(
        'lb-sysmap__pin',
        `lb-sysmap__pin--${look.tone}`,
        look.dashed && 'lb-sysmap__pin--dashed',
        look.strong && 'lb-sysmap__pin--strong',
        look.filled && 'lb-sysmap__pin--filled',
        look.dim && 'lb-sysmap__pin--dim',
        keyOnly && 'lb-sysmap__pin--key-only',
      )}
    >
      <title>{pin.title}</title>
      <rect x={num(pin.box.x)} y={num(pin.box.y)} width={num(pin.box.w)} height={num(pin.box.h)} rx={num(pin.box.h / 2)} />
      {keyOnly ? null : <path className="lb-sysmap__pin-key-cell" d={pinKeyCellPath(pin)} />}
      {pin.texts.map((t, i) => (
        <text key={i} className={`lb-sysmap__pin-${t.part}`} x={num(t.x)} y={num(t.y)} dominantBaseline="central">
          {t.text}
        </text>
      ))}
    </g>
  );
}

export function SysMap({ drawing, alt, pinLook, edgeLook, nodeMuted, minScale = 0.75 }: SysMapProps): JSX.Element {
  const { width, height } = drawing;
  return (
    <svg
      className="lb-sysmap"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${num(width)} ${num(height)}`}
      width={num(width)}
      height={num(height)}
      style={{ minWidth: `${num(width * minScale)}px` }}
      role="img"
      aria-label={alt}
    >
      <defs>
        <marker id="lb-sysmap-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path className="lb-sysmap__arrowhead" d="M0 1 L9 5 L0 9 Z" />
        </marker>
        <marker id="lb-sysmap-arrow-path" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path className="lb-sysmap__arrowhead lb-sysmap__arrowhead--path" d="M0 1 L9 5 L0 9 Z" />
        </marker>
        <marker id="lb-sysmap-cross" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="11" markerHeight="11" orient="auto">
          <path className="lb-sysmap__crossmark" d="M2 2 L8 8 M8 2 L2 8" />
        </marker>
      </defs>
      {drawing.groups.map((g) => (
        <g key={g.id} className="lb-sysmap__group">
          <title>{g.title}</title>
          <rect x={num(g.box.x)} y={num(g.box.y)} width={num(g.box.w)} height={num(g.box.h)} rx="8" />
          <text x={num(g.label.x)} y={num(g.label.y)} dominantBaseline="central">
            {g.label.text}
          </text>
        </g>
      ))}
      {drawing.edges.map((e, i) => {
        const look = edgeLook?.(e) ?? null;
        const marker = e.kind === 'refused' ? 'url(#lb-sysmap-cross)' : look ? 'url(#lb-sysmap-arrow-path)' : 'url(#lb-sysmap-arrow)';
        return (
          <path
            key={i}
            className={classes(
              'lb-sysmap__edge',
              `lb-sysmap__edge--${e.kind}`,
              e.idle && 'lb-sysmap__edge--idle',
              look && 'lb-sysmap__edge--path',
              look === 'proven' && 'lb-sysmap__edge--proven',
            )}
            d={e.d}
            markerEnd={marker}
          />
        );
      })}
      {drawing.edges.map((e, i) =>
        e.labelBox ? (
          <g key={i} className={classes('lb-sysmap__label', e.idle && 'lb-sysmap__label--idle')}>
            <rect x={num(e.labelBox.x)} y={num(e.labelBox.y)} width={num(e.labelBox.w)} height={num(e.labelBox.h)} rx="3" />
            <Lines lines={e.label} />
          </g>
        ) : null,
      )}
      {drawing.stems.map((d, i) => (
        <path key={i} className="lb-sysmap__stem" d={d} />
      ))}
      {drawing.nodes.map((n) => (
        <g
          key={n.id}
          className={classes(
            'lb-sysmap__node',
            `lb-sysmap__node--${n.shape}`,
            !n.lit && 'lb-sysmap__node--idle',
            n.lit && nodeMuted?.(n) && 'lb-sysmap__node--muted',
          )}
        >
          <title>{n.title}</title>
          <path d={n.d} />
          {n.rim ? <path className="lb-sysmap__rim" d={n.rim} /> : null}
          <Lines lines={n.lines} />
        </g>
      ))}
      {drawing.pins.map((p, i) => (
        <Pin key={i} pin={p} look={pinLook(p)} />
      ))}
    </svg>
  );
}
