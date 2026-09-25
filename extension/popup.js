import { loadActions, renderTemplate, INGEST_ACTION } from './actions.js';
import { createTicketSync, formatTicketBytes, githubIssueUrl } from './ticket-sync.js';

const $ = (sel) => document.querySelector(sel);
let ctx = { selection: '', page: '', title: '', url: '', author: '', wordCount: 0 };
let displayedTicketId = '';
let displayedTicketSignature = '';

function collapseTicketDetails() {
  $('#ticket-details').hidden = true;
  $('#ticket-expand').setAttribute('aria-expanded', 'false');
  $('#ticket-expand').textContent = 'Show ticket details ▾';
}

function renderTicketState(state) {
  const panel = $('#ticket-panel');
  panel.hidden = state.kind === 'no-lane';
  if (panel.hidden) return;
  const status = $('#ticket-state');
  const content = $('#ticket-content');
  const syncLabel = $('#ticket-sync-label');
  if (state.kind !== 'ready' || !state.ticket) {
    content.hidden = true;
    displayedTicketId = '';
    displayedTicketSignature = '';
    collapseTicketDetails();
    status.hidden = false;
    status.textContent = state.kind === 'loading' ? 'Loading ticket…'
      : state.kind === 'error' ? 'Ticket unavailable'
        : 'No active ticket';
    syncLabel.textContent = state.kind === 'error' ? 'sync failed' : '';
    return;
  }

  status.hidden = true;
  content.hidden = false;
  syncLabel.textContent = 'synced just now';
  const ticket = state.ticket;
  const signature = JSON.stringify(ticket);
  if (signature === displayedTicketSignature) return;
  if (ticket.id !== displayedTicketId) collapseTicketDetails();
  displayedTicketId = ticket.id;
  displayedTicketSignature = signature;
  $('#ticket-title').textContent = ticket.title;
  $('#ticket-id').textContent = ticket.id;
  const pill = $('#ticket-pill');
  pill.textContent = ticket.status.replaceAll('_', ' ');
  pill.className = 'ticket-panel__pill';
  if (ticket.status === 'blocked' || ticket.status === 'done') {
    pill.classList.add(`ticket-panel__pill--${ticket.status}`);
  }
  $('#ticket-progress').textContent = ticket.lastProgressSummary || 'No progress summary yet';

  const github = ticket.github;
  const issueUrl = github ? githubIssueUrl(github.issueUrl) : null;
  const link = $('#ticket-github-link');
  const plain = $('#ticket-github-plain');
  link.hidden = !issueUrl;
  if (issueUrl) {
    link.href = issueUrl;
    link.textContent = github.issueKey;
    plain.textContent = '';
  } else {
    link.removeAttribute('href');
    plain.textContent = github?.issueKey || 'not linked';
  }
  $('#ticket-github-state').textContent = github ? ` · ${github.state || 'unknown'}` : '';
  $('#ticket-worker').textContent = ticket.worker?.laneDisplayName || 'not assigned';
  $('#ticket-context').textContent = ticket.contextExcerpt || 'No context note yet.';
  $('#ticket-resources-heading').textContent = `Resources · ${ticket.resourceCount}`;
  const resourceList = $('#ticket-resources');
  resourceList.replaceChildren();
  const resources = Array.isArray(ticket.resources) ? ticket.resources.slice(0, 6) : [];
  for (const resource of resources) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = resource.name;
    const size = document.createElement('em');
    size.textContent = formatTicketBytes(resource.sizeBytes);
    item.append(name, size);
    resourceList.appendChild(item);
  }
  if (resources.length === 0 || ticket.resourceCount > resources.length) {
    const item = document.createElement('li');
    item.textContent = resources.length === 0
      ? 'No managed resources'
      : `+${ticket.resourceCount - resources.length} more`;
    resourceList.appendChild(item);
  }
  $('#ticket-analysis').textContent = ticket.analysis
    ? `${ticket.analysis.markdownCount} Markdown · ${ticket.analysis.attachmentCount} attachments`
    : 'No linked analysis bundle';
  $('#ticket-announce').textContent = `Active ticket ${ticket.title}, ${pill.textContent}`;
}

const ticketSync = createTicketSync(
  (lane) => chrome.runtime.sendMessage({ type: 'activeTicket', lane }),
  renderTicketState,
);

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = kind;
}

async function getContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const base = {
    selection: '',
    page: '',
    title: tab.title || '',
    url: tab.url || '',
    author: '',
    wordCount: 0,
  };
  try {
    const [{ result: selection }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection() || ''),
    });
    base.selection = selection || '';
    // Selection wins (doc 177). Only extract the page when nothing is selected:
    // inject the bundled Defuddle, then call the global it exposes. Both run in
    // the same ISOLATED world, so the follow-up func sees __kryptonExtract.
    if (!base.selection) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['dist/content.bundle.js'],
      });
      const [{ result: ex }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.__kryptonExtract && globalThis.__kryptonExtract(),
      });
      if (ex) {
        base.page = ex.markdown || '';
        base.author = ex.author || '';
        base.title = ex.title || base.title;
        base.wordCount = ex.wordCount || 0;
      }
    }
  } catch {
    // restricted page (chrome://, store, PDF) or extraction failed — URL-only.
  }
  return base;
}

async function populateLanes() {
  const resp = await chrome.runtime.sendMessage({ type: 'laneList' });
  const select = $('#lane');
  if (!resp || !resp.ok) {
    setStatus(resp ? resp.error : 'bridge unavailable', 'err');
    select.disabled = true;
    return { ready: false, lanes: [] };
  }
  const lanes = resp.lanes || [];
  if (lanes.length === 0) {
    setStatus('no open lanes in Krypton', 'err');
    select.disabled = true;
    return { ready: false, lanes };
  }
  const { lastLane } = await chrome.storage.local.get('lastLane');
  select.innerHTML = '';
  for (const lane of lanes) {
    const opt = document.createElement('option');
    opt.value = lane.displayName;
    opt.textContent = `${lane.displayName} — ${lane.status}`;
    if (lane.displayName === lastLane) opt.selected = true;
    select.appendChild(opt);
  }
  return { ready: true, lanes };
}

async function send(action) {
  const lane = $('#lane').value;
  if (!lane) return;
  const note = $('#note').value;
  const text = renderTemplate(action, { ...ctx, note });
  setStatus('sending…');
  const resp = await chrome.runtime.sendMessage({ type: 'send', lane, text });
  if (resp && resp.ok) {
    await chrome.storage.local.set({ lastLane: lane });
    setStatus(`✓ ${resp.result.status} → ${lane}`, 'ok');
  } else {
    setStatus(`✗ ${resp ? resp.error : 'send failed'}`, 'err');
  }
}

async function init() {
  const contextPromise = getContext();
  const { ready } = await populateLanes();
  $('#lane').addEventListener('change', () => {
    void ticketSync.selectLane($('#lane').value);
  });
  $('#ticket-refresh').addEventListener('click', () => { void ticketSync.refresh(); });
  $('#ticket-expand').addEventListener('click', () => {
    const details = $('#ticket-details');
    details.hidden = !details.hidden;
    $('#ticket-expand').setAttribute('aria-expanded', String(!details.hidden));
    $('#ticket-expand').textContent = details.hidden ? 'Show ticket details ▾' : 'Hide ticket details ▴';
  });
  if (ready) {
    void ticketSync.selectLane($('#lane').value);
    setInterval(() => { void ticketSync.refresh(); }, 3000);
    window.addEventListener('focus', () => { void ticketSync.refresh(); });
  }

  ctx = await contextPromise;
  const sel = $('#selection');
  if (ctx.selection) {
    sel.textContent = ctx.selection;
  } else if (ctx.page) {
    const words = ctx.wordCount ? `${ctx.wordCount} words` : 'page content';
    sel.textContent = `↳ extracted ${words} — ${ctx.title}`;
  } else {
    sel.textContent = '(no text selected)';
  }

  const actions = await loadActions();
  const list = $('#action-list');

  const addButton = (action) => {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    if (action.id === 'custom') btn.className = 'secondary';
    btn.disabled = !ready;
    btn.addEventListener('click', () => {
      if (action.id === 'custom') {
        $('#note-row').classList.add('show');
        $('#note').focus();
        $('#send-custom').onclick = () => send(action);
      } else {
        send(action);
      }
    });
    list.appendChild(btn);
  };

  // Fixed wiki-ingest action, always present regardless of the saved list. It
  // renders just before the `custom` action (or last, if there is none).
  let ingestPlaced = false;
  for (const action of actions) {
    if (action.id === 'custom' && !ingestPlaced) {
      addButton(INGEST_ACTION);
      ingestPlaced = true;
    }
    addButton(action);
  }
  if (!ingestPlaced) addButton(INGEST_ACTION);
}

init();
