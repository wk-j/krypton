// Content script injected across https://github.com/* (doc 178). Plain JS —
// content scripts cannot import bundled deps here. It:
//   1. parses the canonical issueKey (owner/repo#number) from the URL,
//   2. scrapes the title/body from the authenticated DOM (no token),
//   3. injects a compact "Krypton" status card into the issue sidebar,
//   4. opens a long-lived Port to background.js for live SSE relays,
//   5. re-fetches a full github.issue-status snapshot on every load (refresh-safe)
//      and re-renders the card in place as live frames arrive.
//
// It matches all of github.com — not just issue URLs — and self-gates to issue
// pages at runtime (parseIssue + handleLocation). GitHub is a single-page app
// (Turbo + a React router): soft navigation never reloads the document, so a
// narrow match would (a) miss the issues-list page entirely, meaning clicking an
// issue from the list never injects the script, and (b) never re-run on issue→
// issue navigation. Instead the script lives for the tab's lifetime and watches
// for client-side URL changes, mounting/tearing down the card to match the page.
//
// Defensive throughout: GitHub's DOM varies across the classic and React issue
// pages, so every selector has fallbacks and missing pieces degrade gracefully.

(() => {
  'use strict';

  const ROOT_CLASS = 'krypton-issue-card';
  const BODY_CAP = 8000;

  // ── parse owner/repo/number from /<owner>/<repo>/issues/<n> ────────────────
  function parseIssue(pathname) {
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/);
    if (!m) return null; // ignore /issues, /issues/new, label filters, etc.
    const owner = m[1];
    const repo = m[2];
    const number = parseInt(m[3], 10);
    if (!Number.isFinite(number)) return null;
    return {
      owner,
      repo: `${owner}/${repo}`,
      number,
      issueKey: `${owner}/${repo}#${number}`,
      issueUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
    };
  }

  // The issue this page currently shows, or null on a non-issue page. Mutable:
  // handleLocation() re-points it as the user navigates within GitHub's SPA.
  let issue = null;

  // ── scrape title + body from the DOM ───────────────────────────────────────
  function scrapeTitle() {
    const sels = ['bdi.js-issue-title', '.js-issue-title', 'h1 .markdown-title', 'h1 bdi', 'h1'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      const text = el && el.textContent && el.textContent.trim();
      if (text) return text;
    }
    return document.title.replace(/ · Issue #\d+.*$/, '').trim();
  }

  function scrapeBody() {
    const sels = ['.comment-body', '.js-comment-body', '.markdown-body'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      const text = el && el.textContent && el.textContent.trim();
      if (text) return text.slice(0, BODY_CAP);
    }
    return '';
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function phaseClass(phase) {
    switch (phase) {
      case 'testing':
      case 'review':
        return 'phase-testing';
      case 'pr_opened':
      case 'done':
        return 'phase-done';
      default:
        return 'phase-fixing';
    }
  }

  function dotClass(laneStatus) {
    switch (laneStatus) {
      case 'needs_permission':
        return 'needs';
      case 'idle':
        return 'done';
      case 'busy':
        return 'busy';
      default:
        return 'off'; // stopped | error | unknown
    }
  }

  // ── card host: inline on the classic page, else a fixed floating card ───────
  // We only mount inline on the classic, server-rendered issue page, whose sidebar
  // (#partial-discussion-sidebar) is in normal document flow and present at load.
  // The new React issue page exposes only a position:sticky metadata container
  // ([data-testid="issue-metadata-sticky"]): appending into it pins our card to the
  // viewport top and clips it under GitHub's header, and it hydrates late so the
  // mount point races the content script — together these made the card render
  // inconsistently (sometimes floating, sometimes clipped). On that page we use the
  // predictable floating card instead, which never clips and never races.
  function mountCard(card) {
    const sidebar = document.querySelector('#partial-discussion-sidebar');
    if (sidebar) {
      sidebar.appendChild(card);
    } else {
      card.classList.add(`${ROOT_CLASS}--floating`);
      document.body.appendChild(card);
    }
  }

  // ── card lifecycle ──────────────────────────────────────────────────────────
  let cardEl = null;
  let lanes = []; // [{ displayName, status }]

  function getCard() {
    if (cardEl && cardEl.isConnected) return cardEl;
    cardEl = el('section', ROOT_CLASS);
    mountCard(cardEl);
    return cardEl;
  }

  // Default to the first existing lane when one exists, so a dispatch reuses a
  // running lane rather than always spawning a new fix/#<n> lane; fall back to
  // the "＋ New lane" sentinel only when there are no lanes.
  function defaultLaneSelection() {
    return lanes.length ? lanes[0].displayName : '__new__';
  }

  function laneOptionsHtml(selected) {
    const sel = selected || defaultLaneSelection();
    const newSel = sel === '__new__' ? ' selected' : '';
    let html = `<option value="__new__"${newSel}>＋ New lane (fix/#${issue.number})</option>`;
    for (const lane of lanes) {
      const name = escapeHtml(lane.displayName);
      const optSel = lane.displayName === sel ? ' selected' : '';
      html += `<option value="${name}"${optSel}>${name}</option>`;
    }
    return html;
  }

  // Render one of: offline | unbound | working | needs-permission | done | stale.
  // The snapshot is the github.issue-status result; null/undefined = no data yet.
  function render(state) {
    const card = getCard();
    const online = state.kind !== 'offline';
    const head =
      `<header class="${ROOT_CLASS}__head">` +
      `<span class="${ROOT_CLASS}__brand">▰ KRYPTON</span>` +
      (online ? `<span class="${ROOT_CLASS}__host">127.0.0.1:8766</span>` : '') +
      '</header>';

    let bodyHtml = '';
    if (state.kind === 'offline') {
      bodyHtml =
        `<p class="${ROOT_CLASS}__msg ${ROOT_CLASS}__off">◌ Krypton is not running.</p>` +
        `<p class="${ROOT_CLASS}__hint">Open Krypton, then refresh — the card reconnects automatically.</p>`;
    } else if (state.kind === 'unbound') {
      bodyHtml =
        `<p class="${ROOT_CLASS}__msg">No lane is fixing this issue yet.</p>` +
        `<label class="${ROOT_CLASS}__pick">Lane` +
        `<select class="${ROOT_CLASS}__lane-select">${laneOptionsHtml()}</select>` +
        '</label>' +
        `<button class="${ROOT_CLASS}__primary" type="button">Fix in Krypton ▸</button>`;
    } else if (state.kind === 'stale') {
      // Lane gone (Krypton restarted) mid-fix: show the last known phase/PR, then
      // offer re-dispatch — never a completion card (spec 178).
      const b = state.binding || {};
      const laneName = escapeHtml(b.laneDisplayName || 'lane');
      const phase = b.phase || 'paused';
      bodyHtml =
        `<div class="${ROOT_CLASS}__row">` +
        `<span class="${ROOT_CLASS}__dot ${ROOT_CLASS}__dot--off"></span>` +
        `<span class="${ROOT_CLASS}__lane">${laneName} · stopped</span>` +
        `<span class="${ROOT_CLASS}__phase ${ROOT_CLASS}__${phaseClass(b.phase)}">${escapeHtml(phase)}</span>` +
        '</div>';
      if (b.summary) bodyHtml += `<p class="${ROOT_CLASS}__summary">${escapeHtml(b.summary)}</p>`;
      if (b.prUrl) {
        bodyHtml += `<a class="${ROOT_CLASS}__pr" href="${escapeHtml(b.prUrl)}" target="_blank" rel="noopener">⎘ View pull request →</a>`;
      }
      bodyHtml +=
        `<p class="${ROOT_CLASS}__hint">Krypton was restarted — the lane is gone. Re-dispatch to continue.</p>` +
        `<label class="${ROOT_CLASS}__pick">Lane` +
        `<select class="${ROOT_CLASS}__lane-select">${laneOptionsHtml()}</select>` +
        '</label>' +
        `<button class="${ROOT_CLASS}__primary" type="button">Re-dispatch ▸</button>` +
        `<div class="${ROOT_CLASS}__actions">` +
        `<button class="${ROOT_CLASS}__btn" data-action="unlink" type="button">Unlink</button>` +
        '</div>';
    } else {
      // bound + lane alive: working | needs-permission | done
      const b = state.binding || {};
      const laneName = escapeHtml(b.laneDisplayName || 'lane');
      const phase = b.phase || (state.kind === 'done' ? 'done' : 'fixing');
      const laneStatus = state.laneStatus || (state.kind === 'done' ? 'stopped' : 'busy');
      const dot = dotClass(laneStatus);
      const phaseLabel =
        state.kind === 'done' ? `✓ ${escapeHtml(phase)}` : escapeHtml(phase);

      bodyHtml =
        `<div class="${ROOT_CLASS}__row">` +
        `<span class="${ROOT_CLASS}__dot ${ROOT_CLASS}__dot--${dot}"></span>` +
        `<span class="${ROOT_CLASS}__lane">${laneName}</span>` +
        `<span class="${ROOT_CLASS}__phase ${ROOT_CLASS}__${phaseClass(phase)}">${phaseLabel}</span>` +
        '</div>';

      if (b.summary) {
        bodyHtml += `<p class="${ROOT_CLASS}__summary">${escapeHtml(b.summary)}</p>`;
      }

      if (state.kind === 'needs-permission') {
        const last = state.lastMessage || 'Waiting for permission — approve in Krypton';
        bodyHtml = bodyHtml.replace(
          `<p class="${ROOT_CLASS}__summary">`,
          `<p class="${ROOT_CLASS}__summary ${ROOT_CLASS}__warn">`
        );
        if (!b.summary) {
          bodyHtml += `<p class="${ROOT_CLASS}__summary ${ROOT_CLASS}__warn">⚠ ${escapeHtml(last)}</p>`;
        }
      } else if (state.lastMessage) {
        bodyHtml += `<p class="${ROOT_CLASS}__last">${escapeHtml(state.lastMessage)}</p>`;
      }

      if (state.kind === 'done' && b.prUrl) {
        bodyHtml += `<a class="${ROOT_CLASS}__pr" href="${escapeHtml(b.prUrl)}" target="_blank" rel="noopener">⎘ View pull request →</a>`;
      }

      // actions: only operations the browser can actually perform (no "open lane" —
      // there is no control op to focus a Krypton lane from the browser).
      bodyHtml += `<div class="${ROOT_CLASS}__actions">`;
      if (state.kind === 'done') {
        bodyHtml += `<button class="${ROOT_CLASS}__btn" data-action="unlink" type="button">Unlink</button>`;
      } else if (state.kind === 'working') {
        bodyHtml += `<button class="${ROOT_CLASS}__btn ${ROOT_CLASS}__btn--danger" data-action="cancel" type="button">Cancel</button>`;
      }
      bodyHtml += '</div>';
    }

    card.setAttribute('data-state', state.kind);
    card.innerHTML = head + bodyHtml;
    wireActions(card, state);
  }

  function wireActions(card, state) {
    const primary = card.querySelector(`.${ROOT_CLASS}__primary`);
    if (primary) {
      primary.addEventListener('click', () => {
        const select = card.querySelector(`.${ROOT_CLASS}__lane-select`);
        const targetLane = select ? select.value : '__new__';
        dispatch(targetLane);
      });
    }
    card.querySelectorAll(`.${ROOT_CLASS}__btn[data-action]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const binding = (state && state.binding) || {};
        if (action === 'unlink') {
          unlink();
        } else if (action === 'cancel') {
          cancelLane(binding.laneDisplayName);
        }
      });
    });
  }

  function setBusy(text) {
    const card = getCard();
    const btn =
      card.querySelector(`.${ROOT_CLASS}__primary`) ||
      card.querySelector(`.${ROOT_CLASS}__btn`);
    if (btn) {
      btn.disabled = true;
      if (text) btn.textContent = text;
    }
  }

  // ── background round-trips ──────────────────────────────────────────────────
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, offline: true, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: 'no response' });
          }
        });
      } catch (e) {
        resolve({ ok: false, offline: true, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  // Map a snapshot + lane status into one of the render states:
  // unbound | working | needs-permission | done | stale (+ offline, set elsewhere).
  function snapshotToState(snapshot) {
    if (!snapshot || !snapshot.bound || !snapshot.binding) {
      return { kind: 'unbound' };
    }
    const b = snapshot.binding;
    const laneStatus = snapshot.laneStatus;
    const phase = b.phase;
    // A genuinely finished fix stays "done" even after the lane stops.
    if (phase === 'done' || phase === 'pr_opened') {
      return { kind: 'done', binding: b, laneStatus, lastMessage: snapshot.lastMessage };
    }
    // Lane gone but the fix wasn't finished (e.g. Krypton was restarted): keep the
    // last phase/PR visible but offer re-dispatch, NOT a completion card (spec 178).
    if (laneStatus === 'stopped' || laneStatus === 'error') {
      return { kind: 'stale', binding: b, laneStatus, lastMessage: snapshot.lastMessage };
    }
    if (laneStatus === 'needs_permission' || (snapshot.pendingPermissions || 0) > 0) {
      return { kind: 'needs-permission', binding: b, laneStatus, lastMessage: snapshot.lastMessage };
    }
    return { kind: 'working', binding: b, laneStatus, lastMessage: snapshot.lastMessage };
  }

  let fetching = false;
  async function refresh() {
    if (fetching || !issue) return;
    fetching = true;
    const reqKey = issue.issueKey;
    try {
      const resp = await send({ type: 'issueStatus', issueKey: reqKey });
      // Bail if the user navigated to a different issue (or off issues) mid-fetch;
      // this snapshot is for reqKey, which is no longer what the card shows.
      if (!issue || issue.issueKey !== reqKey) return;
      if (!resp.ok) {
        if (resp.offline) render({ kind: 'offline' });
        else render({ kind: 'unbound' }); // a non-offline error → treat as unbound
        return;
      }
      applySnapshot(resp.result);
    } finally {
      fetching = false;
    }
  }

  function applySnapshot(snapshot) {
    learnWatchedLane(snapshot);
    render(snapshotToState(snapshot));
  }

  async function dispatch(targetLane) {
    setBusy('Dispatching…');
    const params = {
      issueKey: issue.issueKey,
      issueUrl: issue.issueUrl,
      repo: issue.repo,
      number: issue.number,
      title: scrapeTitle(),
      body: scrapeBody(),
      targetLane: targetLane || '__new__',
    };
    const resp = await send({ type: 'dispatchIssue', params });
    if (!resp.ok) {
      if (resp.offline) render({ kind: 'offline' });
      else {
        // Re-render unbound but surface the error inline.
        render({ kind: 'unbound' });
        const card = getCard();
        const msg = card.querySelector(`.${ROOT_CLASS}__msg`);
        if (msg) {
          msg.textContent = `✗ ${resp.error || 'dispatch failed'}`;
          msg.classList.add(`${ROOT_CLASS}__off`);
        }
      }
      return;
    }
    // success: re-snapshot to render the bound state.
    await refresh();
  }

  async function unlink() {
    setBusy('Unlinking…');
    const resp = await send({ type: 'unlinkIssue', issueKey: issue.issueKey });
    if (!resp.ok && resp.offline) {
      render({ kind: 'offline' });
      return;
    }
    await refresh();
  }

  async function cancelLane(laneName) {
    setBusy('Cancelling…');
    const resp = await send({ type: 'cancelLane', lane: laneName });
    if (!resp.ok && resp.offline) {
      render({ kind: 'offline' });
      return;
    }
    await refresh();
  }

  async function loadLanes() {
    const resp = await send({ type: 'laneList' });
    if (resp.ok && Array.isArray(resp.lanes)) {
      lanes = resp.lanes;
      return true;
    }
    if (resp.offline) return false;
    return true; // a non-offline error just means no lanes; still render unbound
  }

  // ── live port to background.js ──────────────────────────────────────────────
  let livePort = null;
  // The lane this issue is bound to, learned from snapshots. Sent to background so
  // it can route lane-scoped `status` frames to this port by { harnessId, lane }
  // instead of broadcasting; `issue_status` frames still match on issueKey.
  let watchedLane = null; // { harnessId, lane } | null while unbound

  function sendWatch() {
    if (!livePort) return;
    try {
      livePort.postMessage({
        type: 'watch',
        // null issueKey when off an issue page → background stops routing frames.
        issueKey: issue ? issue.issueKey : null,
        harnessId: watchedLane ? watchedLane.harnessId : null,
        lane: watchedLane ? watchedLane.lane : null,
      });
    } catch {
      /* port closed */
    }
  }

  // Pull the bound lane out of a snapshot; re-arm the background watch when it changes.
  function learnWatchedLane(snapshot) {
    const binding = snapshot && snapshot.binding;
    const harnessId = binding ? binding.harnessId || null : null;
    const lane = binding ? binding.laneDisplayName || null : null;
    const prev = watchedLane;
    if ((prev && prev.harnessId) === harnessId && (prev && prev.lane) === lane) return;
    watchedLane = harnessId || lane ? { harnessId, lane } : null;
    sendWatch();
  }

  function connectPort() {
    try {
      livePort = chrome.runtime.connect({ name: 'github-issue' });
    } catch {
      return; // background unavailable; the snapshot path still works on refresh
    }
    sendWatch();
    livePort.onMessage.addListener((msg) => {
      if (!msg || !issue) return; // ignore late frames after navigating off an issue
      if (msg.type === 'issueStatus' && msg.snapshot) {
        applySnapshot(msg.snapshot);
      } else if (msg.type === 'resnapshot') {
        refresh();
      }
    });
    livePort.onDisconnect.addListener(() => {
      livePort = null;
      // Background recycled — re-snapshot, then reconnect on next tick. Keep the
      // port alive across navigations (the page lives for the whole tab), so only
      // reconnect while a tab still exists; handleLocation re-arms the watch.
      if (issue) refresh();
      setTimeout(connectPort, 2000);
    });
  }

  // ── load (re)load the card for the current issue ────────────────────────────
  async function loadIssue() {
    fetching = false; // abandon any refresh in flight for a previous issue
    render({ kind: 'unbound' }); // immediate placeholder while we fetch
    const online = await loadLanes();
    if (!online) {
      render({ kind: 'offline' });
    }
    await refresh(); // refresh-safe: full snapshot every load
  }

  // Drop the card and stop watching — used when navigating off any issue page.
  function teardownCard() {
    if (cardEl) {
      cardEl.remove();
      cardEl = null;
    }
    watchedLane = null;
    sendWatch(); // tell background to stop routing the old issue's frames
  }

  // ── SPA navigation ──────────────────────────────────────────────────────────
  // GitHub never reloads the document on soft navigation, so the content script
  // is injected once and must react to client-side URL changes itself. Mount,
  // re-key, or tear down the card to match whatever page is now showing.
  let portConnected = false;

  function handleLocation() {
    const next = parseIssue(location.pathname);
    if (!next) {
      if (issue) {
        issue = null;
        teardownCard();
      }
      return;
    }
    const sameIssue = issue && issue.issueKey === next.issueKey;
    if (sameIssue && cardEl && cardEl.isConnected) return; // already showing it
    issue = next;
    // A Turbo swap detaches the previous card; drop the stale handle so getCard()
    // re-mounts into the freshly rendered sidebar.
    if (cardEl && !cardEl.isConnected) cardEl = null;
    loadIssue();
    if (!portConnected) {
      portConnected = true;
      connectPort(); // subscribe to live deltas (kept alive for the tab's life)
    } else {
      sendWatch(); // re-arm the live watch for the new issue
    }
  }

  // The Navigation API fires for every same-document navigation regardless of
  // framework (Turbo or GitHub's React router) — the most reliable signal. Keep
  // Turbo/pjax/popstate as fallbacks for engines without it.
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigatesuccess', handleLocation);
  }
  window.addEventListener('popstate', handleLocation);
  document.addEventListener('turbo:load', handleLocation);
  document.addEventListener('pjax:end', handleLocation);

  handleLocation(); // mount for the page we were injected on (if it's an issue)
})();
