import { loadActions, renderTemplate, parseIssueRef } from './actions.js';

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
  // The issue-fixing picker can target a brand-new lane, so it is usable even
  // with zero open lanes — populate it regardless of the send-action gate.
  populateIssueLanes(lanes);
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

function setIssueStatus(text, kind = '') {
  const el = $('#issue-status');
  el.textContent = text;
  el.className = kind;
}

// Populate the issue-fixing lane picker from lane.list, prepending the
// "＋ New lane" sentinel (-> targetLane "__new__"). Reuses the already-fetched
// lane list so we don't round-trip twice.
function populateIssueLanes(lanes) {
  const select = $('#issue-lane');
  select.innerHTML = '';
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '＋ New lane';
  select.appendChild(newOpt);
  for (const lane of lanes || []) {
    const opt = document.createElement('option');
    opt.value = lane.displayName;
    opt.textContent = `${lane.displayName} — ${lane.status}`;
    select.appendChild(opt);
  }
}

async function dispatchIssue() {
  const ref = parseIssueRef($('#issue-ref').value);
  if (!ref) {
    setIssueStatus('enter a valid issue URL or owner/repo#123', 'err');
    return;
  }
  const targetLane = $('#issue-lane').value || '__new__';
  setIssueStatus('dispatching…');
  const params = {
    issueKey: ref.issueKey,
    issueUrl: ref.issueUrl,
    repo: ref.repo,
    number: ref.number,
    targetLane,
  };
  const resp = await chrome.runtime.sendMessage({ type: 'dispatchIssue', params });
  if (resp && resp.ok) {
    const lane = resp.result && resp.result.lane ? resp.result.lane : targetLane;
    setIssueStatus(`✓ dispatched ${ref.issueKey} → ${lane}`, 'ok');
  } else {
    setIssueStatus(`✗ ${resp ? resp.error : 'dispatch failed'}`, 'err');
  }
}

async function init() {
  ctx = await getContext();
  // Prefill the issue field when the active tab is a GitHub issue page.
  if (ctx.url) {
    const ref = parseIssueRef(ctx.url);
    if (ref) $('#issue-ref').value = ref.issueUrl;
  }
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
  for (const action of actions) {
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
  }

  // Issue fixing works even with no open lanes (it can spawn "__new__"), so its
  // button is wired regardless of `ready`.
  $('#issue-send').addEventListener('click', dispatchIssue);
}

init();
