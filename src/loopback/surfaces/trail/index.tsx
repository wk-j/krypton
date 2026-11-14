// Spec 400 — the bug trail page: a pre-fix diagnosis drawn on the project's
// system map. Read-only: it fetches `/trail.json` once and never posts.
//
// The map is laid out once per view (the kit's system map: a port of
// valence's map layout, drawn as inline SVG) with every step's pin on it.
// `j`/`k` walk the steps: the frame only changes
// classes (future pins dimmed, path edges, ruled-out nodes), so nothing moves.
// `a` swaps the involved nodes for the whole map.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import { Banner, EmptyState, fetchJson, HttpError, KbdHints, layoutMap, Pill, SysMap, useKeymap, useShell } from '../../kit';
import { bugPath, checkTone, focus, frame, gapText, isPathEdge, pinLook, stateLine, submap, trailPins, trailStatus } from './model';
import type { TrailEvidence, TrailPayload, TrailRepro, TrailStep } from './types';

import { TrailIndexPage } from './index-view';

import './trail.css';

const HINTS: readonly (readonly [string, string])[] = [
  ['j / k', 'step'],
  ['g / G', 'first / last'],
  ['a', 'involved / whole map'],
];

function loadErrorText(error: unknown): string {
  if (error instanceof HttpError && error.status === 404) return 'This issue has no bug trail. Analyze it in Krypton first.';
  return `The trail could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
}

function evidenceRef(evidence: TrailEvidence, repro: TrailRepro | undefined): string {
  const f = evidence.fields;
  switch (evidence.type) {
    case 'cite':
      return `${f.file ?? ''}:${f.lines ?? ''}`;
    case 'commit':
      return f.sha ?? '';
    case 'observed':
      return f.file ?? '';
    case 'repro':
      // The run id and outcome come in `detail`; the command's purpose is the text.
      return f.id ?? '';
    case 'inferred':
    case 'ref':
      return f.source ?? f.url ?? '';
  }
}

function evidenceText(evidence: TrailEvidence): string | null {
  const f = evidence.fields;
  switch (evidence.type) {
    case 'cite':
      return f.quote ? `"${f.quote}"` : null;
    case 'observed':
    case 'inferred':
    case 'ref':
      return f.what ?? null;
    default:
      return null;
  }
}

function EvidenceLine({ evidence, repro }: { readonly evidence: TrailEvidence; readonly repro: TrailRepro | undefined }): JSX.Element {
  const ref = evidenceRef(evidence, repro);
  const text = evidence.type === 'repro' ? (repro?.what ?? null) : evidenceText(evidence);
  const tail = evidence.outputTail ?? (evidence.type === 'repro' ? (repro?.lastRun?.outputTail ?? null) : null);
  return (
    <div className="lb-trail__evidence">
      <span className={`lb-trail__status lb-trail__status--${checkTone(evidence.status)}`}>{evidence.status}</span>
      <span className="lb-trail__ev-type">{evidence.type}</span>
      {ref ? <span className="lb-trail__ev-ref">{ref}</span> : null}
      {text ? <span className="lb-trail__ev-text">{text}</span> : null}
      {evidence.detail ? <span className="lb-trail__ev-detail">{evidence.detail}</span> : null}
      {tail ? <pre className="lb-trail__tail">{tail}</pre> : null}
    </div>
  );
}

interface StepRowProps {
  readonly step: TrailStep;
  readonly index: number;
  readonly current: number;
  readonly repro: readonly TrailRepro[];
  readonly onSelect: (index: number) => void;
}

function StepRow({ step, index, current, repro, onSelect }: StepRowProps): JSX.Element {
  let className = `lb-trail__step lb-trail__step--${step.kind}`;
  if (index === current) className += ' lb-trail__step--current';
  else if (index > current) className += ' lb-trail__step--future';
  const number = step.kind === 'decision' ? `?${index + 1}` : String(index + 1);
  return (
    <li className={className} data-index={index} aria-current={index === current ? 'step' : undefined} onClick={() => onSelect(index)}>
      <span className={`lb-trail__num lb-trail__num--${step.kind}`}>{number}</span>
      <span className={`lb-trail__kind lb-trail__kind--${step.kind}`}>{step.kind}</span>
      <div className="lb-trail__body">
        <div className="lb-trail__line">
          <span className="lb-trail__at">{step.at}</span> <span className="lb-trail__note">{step.note}</span>
        </div>
        {step.question ? <div className="lb-trail__question">{step.question}</div> : null}
        {step.options.length ? (
          <ul className="lb-trail__options">
            {step.options.map((option, i) => (
              <li key={i}>{option}</li>
            ))}
          </ul>
        ) : null}
        {step.kind === 'decision' ? (
          <div className={step.answer ? 'lb-trail__answer' : 'lb-trail__answer lb-trail__answer--open'}>
            {step.answer ? `answer: ${step.answer}` : 'open: answer in the harness chat'}
          </div>
        ) : null}
        {step.evidence.map((evidence, i) => (
          <EvidenceLine key={i} evidence={evidence} repro={evidence.type === 'repro' ? repro.find((r) => r.id === evidence.fields.id) : undefined} />
        ))}
      </div>
    </li>
  );
}

function TrailIssuePage(): JSX.Element {
  const { setTitle } = useShell();
  const [payload, setPayload] = useState<TrailPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cur, setCur] = useState(0);
  const [whole, setWhole] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchJson<TrailPayload>(`/trail.json${location.search}`, { signal: controller.signal })
      .then((next) => {
        setPayload(next);
        setCur(Math.max(0, next.steps.length - 1));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(loadErrorText(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (payload) setTitle(`Bug trail · ${payload.issue}`);
  }, [payload, setTitle]);

  const view = useMemo(() => {
    if (!payload) return null;
    const f = frame(payload, cur);
    const map = payload.map.map;
    const path = map ? bugPath(map, f) : new Set<string>();
    return { f, map, path };
  }, [payload, cur]);

  // One layout per payload and view: every step's pin is on it, and the
  // involved nodes are those of the whole trail, so stepping never moves a box.
  const drawing = useMemo(() => {
    const map = payload?.map.map;
    if (!payload || !map) return null;
    const all = frame(payload, payload.steps.length - 1);
    const involved = focus(map, all, bugPath(map, all));
    const drawn = whole ? map : submap(map, involved);
    try {
      return { layout: layoutMap(drawn, trailPins(payload).filter((p) => drawn.nodes.some((n) => n.id === p.at)), involved), shown: drawn.nodes.length, total: map.nodes.length, error: null };
    } catch (error: unknown) {
      return { layout: null, shown: 0, total: map.nodes.length, error: `map could not be drawn: ${error instanceof Error ? error.message : String(error)}` };
    }
  }, [payload, whole]);

  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.lb-trail__step--current');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [cur, payload]);

  const last = payload ? payload.steps.length - 1 : 0;
  const clamp = (index: number): number => Math.min(Math.max(index, 0), Math.max(last, 0));
  // Functional updates: keys pressed faster than a render must still add up.
  const move = (delta: number): void => setCur((c) => clamp(c + delta));
  useKeymap([
    { key: ['j', 'ArrowDown'], label: 'Next step', run: () => move(1) },
    { key: ['k', 'ArrowUp'], label: 'Previous step', run: () => move(-1) },
    { key: 'g', label: 'First step', run: () => setCur(0) },
    { key: 'G', label: 'Last step', run: () => setCur(clamp(last)) },
    { key: 'a', label: 'Involved nodes / whole map', run: () => setWhole((w) => !w) },
  ]);

  if (loadError) {
    return (
      <div className="lb-page lb-trail">
        <Banner text={loadError} tone="error" />
      </div>
    );
  }
  if (!payload || !view) return <div className="lb-page lb-trail" />;

  const { f } = view;
  const status = trailStatus(f);
  const line = stateLine(payload);
  const gap = gapText(payload, f);
  const errors: string[] = [
    ...payload.errors,
    ...payload.map.errors.map((e) => `map ${payload.map.path}: ${e}`),
    ...(drawing?.error ? [drawing.error] : []),
  ];
  const warnings = [...payload.warnings, ...payload.map.warnings.map((w) => `map ${payload.map.path}: ${w}`)];
  const offMap = f.unplaced.map((i) => `step ${i + 1} "${payload.steps[i].at}"`);

  let mapBlock: ReactNode = null;
  if (view.map && drawing?.layout) {
    const futureKeys = new Set(
      payload.steps.flatMap((step, i) => (i > f.upTo ? [step.kind === 'decision' ? `?${i + 1}` : String(i + 1)] : [])),
    );
    mapBlock = (
      <figure className="lb-trail__map">
        <div className="lb-trail__map-scroll">
          <SysMap
            drawing={drawing.layout}
            alt={`System map, step ${f.upTo + 1} of ${payload.steps.length}`}
            pinLook={(pin) => ({ ...pinLook(pin.status), dim: futureKeys.has(pin.key) })}
            edgeLook={(edge) => (isPathEdge(edge, f, view.path) ? (f.anyReproduced ? 'proven' : 'path') : null)}
            nodeMuted={(node) => f.states.get(node.id) === 'ruled-out'}
          />
        </div>
        <figcaption className="lb-trail__caption">
          {`${drawing.shown} of ${drawing.total} nodes shown · `}
          <kbd>a</kbd>
          {whole ? ' involved nodes' : ' whole map'}
        </figcaption>
      </figure>
    );
  }

  return (
    <div className="lb-page lb-trail">
      <header className="lb-trail__head">
        <div className="lb-trail__titles">
          <h1 className="lb-trail__title">{payload.title ?? payload.issue}</h1>
          <div className="lb-trail__meta">
            <span>{payload.issue}</span>
            <span className={line.warn ? 'lb-trail__state lb-trail__state--warn' : 'lb-trail__state'}>{line.text}</span>
            <span>{`map ${payload.map.path}`}</span>
            <a className="lb-trail__back" href={indexHref()}>
              all trails
            </a>
          </div>
        </div>
        <div className="lb-trail__pills">
          <Pill label={status.label} tone={status.tone} />
          {f.openDecisions > 0 ? (
            <Pill label={`${f.openDecisions} decision${f.openDecisions === 1 ? '' : 's'} open`} tone="accent" />
          ) : null}
        </div>
      </header>
      {errors.length ? (
        <div className="lb-trail__errors">
          {errors.map((text, i) => (
            <Banner key={i} text={text} tone="error" />
          ))}
        </div>
      ) : null}
      {warnings.length ? (
        <ul className="lb-trail__warnings">
          {warnings.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      ) : null}
      {gap ? (
        <p className="lb-trail__gap" role="note">
          {gap}
        </p>
      ) : null}
      {mapBlock}
      {offMap.length ? <p className="lb-trail__offmap">{`not on the map (${payload.map.path}): ${offMap.join(' · ')}`}</p> : null}
      <div className="lb-trail__progress">{payload.steps.length ? `step ${f.upTo + 1} of ${payload.steps.length}` : ''}</div>
      {payload.steps.length ? (
        <ol className="lb-trail__steps" ref={listRef}>
          {payload.steps.map((step, i) => (
            <StepRow key={i} step={step} index={i} current={f.upTo} repro={payload.repro} onSelect={(n) => setCur(clamp(n))} />
          ))}
        </ol>
      ) : (
        <EmptyState text="No steps yet" />
      )}
      <KbdHints entries={HINTS} />
    </div>
  );
}

/** The project's trail index: this page's query without `issue`. */
function indexHref(): string {
  const params = new URLSearchParams(location.search);
  params.delete('issue');
  const query = params.toString();
  return query ? `/trail?${query}` : '/trail';
}

/** Spec 400: one issue's trail with `issue=`, the project's index without it. */
export function TrailPage(): JSX.Element {
  return new URLSearchParams(location.search).has('issue') ? <TrailIssuePage /> : <TrailIndexPage />;
}
