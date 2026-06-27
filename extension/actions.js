// Action templates (doc 176). An action is a predefined prompt the user picks
// after selecting page text. Templates support {selection} {title} {url}
// placeholders. Built-ins are seeded into chrome.storage.sync on first run and
// are editable from the options page.

export const BUILTIN_ACTIONS = [
  { id: 'explain', label: 'Explain', template: 'Explain the following:\n\n{selection}' },
  { id: 'summarize', label: 'Summarize', template: 'Summarize the following:\n\n{selection}' },
  {
    id: 'translate_th',
    label: 'Translate to Thai',
    template: 'Translate the following to Thai:\n\n{selection}',
  },
  {
    id: 'critique',
    label: 'Find issues',
    template: 'Review the following and list any problems or risks:\n\n{selection}',
  },
  // `custom` is special-cased in the popup: the user types a free-text note that
  // becomes the prompt prefix above the selection.
  { id: 'custom', label: 'Custom…', template: '{note}\n\n{selection}' },
];

const STORAGE_KEY = 'actions';

export async function loadActions() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const actions = stored[STORAGE_KEY];
  if (Array.isArray(actions) && actions.length > 0) return actions;
  await chrome.storage.sync.set({ [STORAGE_KEY]: BUILTIN_ACTIONS });
  return BUILTIN_ACTIONS;
}

export async function saveActions(actions) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: actions });
}

// Parse a GitHub issue reference — either a full URL
// (https://github.com/<owner>/<repo>/issues/<n>) or the shorthand
// `owner/repo#123` — into the canonical fields dispatch needs (doc 178).
// Returns null for anything that doesn't resolve to a repo + numeric issue.
export function parseIssueRef(input) {
  const raw = (input || '').trim();
  if (!raw) return null;
  let owner;
  let repo;
  let number;
  const urlMatch = raw.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (urlMatch) {
    owner = urlMatch[1];
    repo = urlMatch[2];
    number = parseInt(urlMatch[3], 10);
  } else {
    const shortMatch = raw.match(/^([^/\s]+)\/([^/#\s]+)#(\d+)$/);
    if (!shortMatch) return null;
    owner = shortMatch[1];
    repo = shortMatch[2];
    number = parseInt(shortMatch[3], 10);
  }
  if (!Number.isFinite(number) || number <= 0) return null;
  return {
    owner,
    repo: `${owner}/${repo}`,
    number,
    issueKey: `${owner}/${repo}#${number}`,
    issueUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
  };
}

// Render a template into a final prompt. The body is the user selection when
// present, otherwise the page content extracted client-side (doc 177); it is
// wrapped so the lane treats it as quoted source rather than instructions. A
// Source line (with author when known) is appended when the template does not
// already reference {url}.
export function renderTemplate(action, ctx) {
  const note = ctx.note ?? '';
  const page = ctx.page ?? '';
  // Selection wins; extracted page is the fallback. {page} lets a custom action
  // force full-page content even when a selection exists.
  const body = ctx.selection || page;
  const bodyBlock = body ? `"""\n${body}\n"""` : '(no content)';
  const text = action.template
    .replaceAll('{selection}', bodyBlock)
    .replaceAll('{page}', page ? `"""\n${page}\n"""` : '(no page content)')
    .replaceAll('{title}', ctx.title ?? '')
    .replaceAll('{author}', ctx.author ?? '')
    .replaceAll('{url}', ctx.url ?? '')
    .replaceAll('{note}', note)
    .trim();
  if (action.template.includes('{url}')) {
    return text;
  }
  const by = ctx.author ? ` — ${ctx.author}` : '';
  return `${text}\n\nSource: ${ctx.title ?? ''}${by} — ${ctx.url ?? ''}`;
}
