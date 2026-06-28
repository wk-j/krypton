import { loadActions, renderTemplate, INGEST_ACTION } from './actions.js';

const $ = (sel) => document.querySelector(sel);
let ctx = { selection: '', page: '', title: '', url: '', author: '', wordCount: 0 };

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
  ctx = await getContext();
  const sel = $('#selection');
  if (ctx.selection) {
    sel.textContent = ctx.selection;
  } else if (ctx.page) {
    const words = ctx.wordCount ? `${ctx.wordCount} words` : 'page content';
    sel.textContent = `↳ extracted ${words} — ${ctx.title}`;
  } else {
    sel.textContent = '(no text selected)';
  }

  const { ready } = await populateLanes();
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
