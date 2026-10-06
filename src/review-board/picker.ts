// Krypton — Review Board picker (spec 211)
//
// A summon overlay over the durable bundles found by walking `.krypton/reviews/`.
// This is the path for reopening ANYTHING — including reviews from previous
// sessions and previous app runs — which is why it reads the filesystem rather
// than a session registry.
//
// It is also the answer to "why is the browser archive read-only": `/reviews`
// shows you what exists, and this picker is the one keystroke that opens it.

import { invoke } from '../profiler/ipc';

import type { ReviewBundle } from '../acp/types';

/** Result of a pick: the bundle to open, or null when the human dismissed it. */
export type ReviewPickResult = ReviewBundle | null;

/**
 * Which projects the picker lists. `project` is the normal case — the project the
 * focused pane sits in — so one project's reviews never mix with another's. `all`
 * is the fallback when the focus is in no open project, and then every row names
 * its project: lane names (`Claude-1`) restart each app run, so they can't.
 */
export type ReviewPickerScope =
  | { kind: 'project'; label: string }
  | { kind: 'all'; projectOf: (bundle: ReviewBundle) => string };

/** `/a/b/` and `/a/b` are the same project root; `/` stays `/`. */
function trimSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** A project's display name — the last segment of its root, never uppercased. */
export function projectLabel(root: string): string {
  const trimmed = trimSlash(root);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

/**
 * Narrow the open harnesses to the project the focused cwd sits in: the deepest
 * harness root equal to or containing it, so a terminal in `krypton/src` still
 * scopes to `krypton`. Every harness (and a null root) when the cwd is unknown or
 * outside all of them.
 */
export function scopeToFocusedProject<T extends { cwd: string | null }>(
  entries: readonly T[],
  focusedCwd: string | null,
): { root: string | null; entries: T[] } {
  if (focusedCwd) {
    const target = trimSlash(focusedCwd);
    let root: string | null = null;
    for (const entry of entries) {
      if (!entry.cwd) continue;
      const candidate = trimSlash(entry.cwd);
      const inside =
        target === candidate || target.startsWith(candidate === '/' ? '/' : `${candidate}/`);
      if (inside && (root === null || candidate.length > root.length)) root = candidate;
    }
    if (root !== null) {
      return { root, entries: entries.filter((e) => e.cwd && trimSlash(e.cwd) === root) };
    }
  }
  return { root: null, entries: [...entries] };
}

/** Vim and arrow navigation stay available while the title filter has focus. */
export function reviewPickerNavigationDelta(key: string): -1 | 0 | 1 {
  if (key === 'j' || key === 'ArrowDown') return 1;
  if (key === 'k' || key === 'ArrowUp') return -1;
  return 0;
}

/** Load every bundle known to a harness, newest first. */
export async function listReviewBundles(harnessId: string): Promise<ReviewBundle[]> {
  try {
    return await invoke<ReviewBundle[]>('list_review_bundles', { harnessId });
  } catch {
    return [];
  }
}

/**
 * Show the review picker and resolve with the chosen bundle. `j`/`k` move,
 * `Enter` opens, `/` filters by title, `Esc`/`q` dismiss.
 *
 * Owns its own document-level capture listener for the duration, the same shape
 * as the other summon overlays: the caller is expected to have left compositor
 * mode first, so the router is not competing for these keys.
 */
export function pickReview(
  bundles: readonly ReviewBundle[],
  scope: ReviewPickerScope,
): Promise<ReviewPickResult> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'krypton-review-picker';

    const head = document.createElement('div');
    head.className = 'krypton-review-picker__head';
    root.appendChild(head);

    const filterRow = document.createElement('div');
    filterRow.className = 'krypton-review-picker__filter';
    const filterInput = document.createElement('input');
    filterInput.className = 'krypton-review-picker__filter-input';
    filterInput.placeholder = 'filter by title…';
    filterRow.appendChild(filterInput);
    filterRow.style.display = 'none';
    root.appendChild(filterRow);

    const list = document.createElement('div');
    list.className = 'krypton-review-picker__list';
    root.appendChild(list);

    document.body.appendChild(root);

    let filtering = false;
    let filtered = [...bundles];
    let selected = 0;

    const projectOf = scope.kind === 'all' ? scope.projectOf : null;
    const scopeLabel = scope.kind === 'project' ? scope.label : 'all projects';

    const render = (): void => {
      head.textContent =
        `reviews · ${scopeLabel} · ${filtered.length}/${bundles.length}` +
        ' · j/k move · Enter open · / filter · Esc close';
      list.innerHTML = '';
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'krypton-review-picker__empty';
        empty.textContent =
          bundles.length === 0
            ? 'no reviews yet — ask a lane to explain something, or run #review'
            : 'no review matches that filter';
        list.appendChild(empty);
        return;
      }
      filtered.forEach((bundle, i) => {
        const row = document.createElement('div');
        row.className = 'krypton-review-picker__row';
        if (i === selected) row.classList.add('krypton-review-picker__row--selected');
        row.append(cell('krypton-review-picker__date', formatDate(bundle.createdAt)));
        if (projectOf) row.append(cell('krypton-review-picker__project', projectOf(bundle)));
        row.append(
          cell('krypton-review-picker__title', bundle.title),
          cell('krypton-review-picker__lane', bundle.laneName),
          cell('krypton-review-picker__counts', countsLabel(bundle)),
          statusCell(bundle),
        );
        row.addEventListener('click', () => {
          selected = i;
          finish(filtered[selected] ?? null);
        });
        list.appendChild(row);
      });
      list
        .querySelector('.krypton-review-picker__row--selected')
        ?.scrollIntoView({ block: 'nearest' });
    };

    const applyFilter = (): void => {
      const q = filterInput.value.trim().toLowerCase();
      filtered = q
        ? bundles.filter(
            (b) =>
              b.title.toLowerCase().includes(q) ||
              b.slug.toLowerCase().includes(q) ||
              b.laneName.toLowerCase().includes(q) ||
              (projectOf?.(b).toLowerCase().includes(q) ?? false),
          )
        : [...bundles];
      selected = 0;
      render();
    };

    const move = (delta: number): void => {
      if (filtered.length === 0) return;
      selected = (selected + delta + filtered.length) % filtered.length;
      render();
    };

    let finished = false;
    const finish = (result: ReviewPickResult): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent): void => {
      // While the filter input has focus it owns typing except for the picker's
      // documented j/k and arrow navigation keys.
      if (filtering && document.activeElement === filterInput) {
        const navigationDelta = reviewPickerNavigationDelta(e.key);
        if (navigationDelta !== 0) {
          e.preventDefault();
          e.stopPropagation();
          move(navigationDelta);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          filtering = false;
          filterRow.style.display = 'none';
          filterInput.value = '';
          applyFilter();
          root.focus();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          filtering = false;
          filterInput.blur();
          return;
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          move(-1);
          return;
        case 'g':
          selected = e.shiftKey ? Math.max(0, filtered.length - 1) : 0;
          render();
          return;
        case '/':
          filtering = true;
          filterRow.style.display = '';
          filterInput.focus();
          filterInput.select();
          return;
        case 'Enter':
          finish(filtered[selected] ?? null);
          return;
        case 'q':
        case 'Escape':
          finish(null);
          return;
        default:
          return;
      }
    };

    filterInput.addEventListener('input', applyFilter);
    document.addEventListener('keydown', onKey, true);
    root.tabIndex = 0;
    root.focus();
    render();
  });
}

function cell(className: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/** Walkthrough step count sits next to the block count, because on a
 *  comprehension Board it is the better measure of "how much is here to read". */
function countsLabel(bundle: ReviewBundle): string {
  const parts = [`${bundle.counts.blocks} blocks`];
  if (bundle.counts.steps > 0) parts.push(`${bundle.counts.steps} steps`);
  return parts.join(' · ');
}

/** Status comes from `response.md`, exactly as the browser archive derives it. A
 *  Board with nothing to answer is `reference` rather than given a status — it is
 *  an explanation to come back to, not a task. Never a score (ADR-0004). */
function statusCell(bundle: ReviewBundle): HTMLElement {
  const answerable = bundle.counts.findings + bundle.counts.decisions;
  if (answerable === 0) return cell('krypton-review-picker__status--reference', 'reference');
  if (bundle.sentAt !== undefined && bundle.sentAt !== null) {
    return cell('krypton-review-picker__status--sent', '✓ sent');
  }
  if (bundle.respondedAt !== undefined && bundle.respondedAt !== null) {
    return cell('krypton-review-picker__status--answered', `⋯ ${bundle.counts.unanswered} left`);
  }
  return cell('krypton-review-picker__status--unopened', `· ${bundle.counts.unanswered} to answer`);
}

function formatDate(createdAt: number): string {
  if (!createdAt) return '—';
  const d = new Date(createdAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
