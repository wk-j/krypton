// Krypton — native card body for `git status` (spec 352): the branch line,
// then one group per side (conflicts, staged, unstaged, untracked, ignored)
// with a status letter, the path (directory dimmed) and its line counts.

import { el } from '../ui/dom';
import { branchLine, STATUS_GROUP_LABEL, type NativeGitStatus, type StatusEntry, type StatusGroup } from './git-status';

const CODE_TITLE: Readonly<Record<string, string>> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed',
  U: 'unmerged', '?': 'untracked', '!': 'ignored',
};

/** Class suffix per letter: the colour says what happened, not which side. */
const CODE_CLASS: Readonly<Record<string, string>> = {
  M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'renamed',
  U: 'conflict', '?': 'untracked', '!': 'ignored',
};

export function renderStatus(status: NativeGitStatus): HTMLElement {
  const branch = el('div', { class: 'krypton-native-status__branch', text: branchLine(status.branch) });
  const body = status.groups.length === 0
    ? [el('div', { class: 'krypton-native-status__clean', text: 'nothing to commit, working tree clean' })]
    : status.groups.map(renderGroup);
  return el('div', { class: 'krypton-native-status' }, branch, ...body);
}

function renderGroup(group: StatusGroup): HTMLElement {
  return el(
    'div',
    { class: ['krypton-native-status__group', `krypton-native-status__group--${group.kind}`] },
    el(
      'div',
      { class: 'krypton-native-status__label' },
      STATUS_GROUP_LABEL[group.kind],
      el('span', { class: 'krypton-native-status__count', text: String(group.entries.length) }),
    ),
    ...group.entries.map(renderEntry),
  );
}

function renderEntry(entry: StatusEntry): HTMLElement {
  const letter = entry.code.length === 1 ? entry.code : 'U';
  const counts = entry.added === null && entry.deleted === null
    ? null
    : el(
      'span',
      { class: 'krypton-native-status__counts' },
      el('span', { class: 'krypton-native-status__added', text: entry.added === null ? 'bin' : `+${entry.added}` }),
      entry.deleted !== null && el('span', { class: 'krypton-native-status__deleted', text: `-${entry.deleted}` }),
    );
  return el(
    'div',
    { class: 'krypton-native-status__entry' },
    el('span', {
      class: ['krypton-native-status__code', `krypton-native-status__code--${CODE_CLASS[letter] ?? 'other'}`],
      text: entry.code,
      title: CODE_TITLE[letter] ?? entry.code,
    }),
    el(
      'span',
      { class: 'krypton-native-status__path' },
      entry.oldPath && renderPath(entry.oldPath),
      entry.oldPath && el('span', { class: 'krypton-native-status__arrow', text: ' → ' }),
      renderPath(entry.path),
    ),
    counts,
  );
}

/** `src/native-output/layer.ts` → dim `src/native-output/` + `layer.ts`; a trailing `/` stays with the name. */
function renderPath(path: string): DocumentFragment {
  const cut = path.lastIndexOf('/', path.endsWith('/') ? path.length - 2 : path.length - 1);
  const fragment = document.createDocumentFragment();
  if (cut >= 0) fragment.append(el('span', { class: 'krypton-native-status__dir', text: path.slice(0, cut + 1) }));
  fragment.append(path.slice(cut + 1));
  return fragment;
}
