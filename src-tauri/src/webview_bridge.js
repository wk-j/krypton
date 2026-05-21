// Krypton webview bridge — injected into every child webview.
// Forwards leader chords + title changes to the host, and provides a
// Vimium-lite in-page keyboard navigation layer (j/k scroll, f hint mode,
// / find-in-page). __KRYPTON_ID__ is substituted by the Rust caller.
(function () {
  'use strict';
  const tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  const ID = __KRYPTON_ID__;

  // ─── Chord forwarding (host shortcuts) ─────────────────────────────
  // Match by e.code (physical key) rather than e.key — on macOS, shifted
  // brackets/digits produce '{', '}', '!', etc. so e.key-based matching
  // misses Cmd+Shift+[ / Cmd+Shift+<digit>. The host input router
  // similarly keys off e.code for these chords. Forward every Cmd/Ctrl
  // chord (and bare Escape) so the webview behaves like any other view —
  // the host input-router decides what to do with the synthesized event.
  const PUNCT_CODE_TO_CHORD = {
    BracketLeft: '[', BracketRight: ']',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    Backquote: '`', Minus: '-', Equal: '=', Backslash: '\\',
    Space: ' ', Tab: 'Tab', Enter: 'Enter', Escape: 'Escape',
    Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  };
  function codeToChord(code) {
    if (code.length === 4 && code.indexOf('Key') === 0) return code.charAt(3).toLowerCase();
    if (code.length === 6 && code.indexOf('Digit') === 0) return code.charAt(5);
    if (code.length === 2 && code.charAt(0) === 'F') return code; // F1..F9
    if (code.length === 3 && code.charAt(0) === 'F') return code; // F10..F12
    return PUNCT_CODE_TO_CHORD[code] || null;
  }
  function modsMask(e) {
    let mods = 0;
    if (e.metaKey) mods |= 1;
    if (e.shiftKey) mods |= 2;
    if (e.altKey) mods |= 4;
    if (e.ctrlKey) mods |= 8;
    return mods;
  }
  window.addEventListener('keydown', function (e) {
    const isEscape = e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const isModChord = (e.metaKey || e.ctrlKey) && e.code !== 'MetaLeft' && e.code !== 'MetaRight'
      && e.code !== 'ControlLeft' && e.code !== 'ControlRight';
    if (!isEscape && !isModChord) return;
    const chord = codeToChord(e.code);
    if (!chord) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try { tauri.invoke('forward_chord', { id: ID, key: chord, mods: modsMask(e) }); } catch (err) {}
  }, true);

  // ─── Title forwarding ──────────────────────────────────────────────
  function reportTitle() {
    try { tauri.invoke('forward_title', { id: ID, title: document.title || '' }); } catch (err) {}
  }
  (function attach() {
    const t = document.querySelector('title');
    if (!t) { setTimeout(attach, 100); return; }
    reportTitle();
    new MutationObserver(reportTitle).observe(t, { childList: true });
  })();

  // ─── Vimium-lite in-page navigation ────────────────────────────────
  const SCROLL_STEP = 60;
  const HALF_PAGE = 0.5;
  const HINT_CHARS = 'asdfgjklqweruiopzxcvbnm';

  let mode = 'normal'; // 'normal' | 'hint' | 'find'
  let hintState = null;
  let findState = null;
  let lastG = 0;
  let lastFindQuery = '';

  function activeIsEditable() {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  const CLICKABLE_SELECTOR = [
    'a[href]', 'button', '[role="button"]',
    'input:not([type="hidden"]):not([disabled])',
    'select', 'textarea', '[contenteditable=""]', '[contenteditable="true"]',
    '[onclick]', '[tabindex]',
  ].join(',');

  function collectTargets() {
    const all = document.querySelectorAll(CLICKABLE_SELECTOR);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const results = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom <= 0 || r.top >= vh) continue;
      if (r.right <= 0 || r.left >= vw) continue;
      const cs = window.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      results.push({ el: el, rect: r, area: r.width * r.height });
    }
    results.sort(function (a, b) { return b.area - a.area; });
    return results;
  }

  function generateLabels(n) {
    const chars = HINT_CHARS.split('');
    const labels = [];
    if (n <= chars.length) {
      for (let i = 0; i < n; i++) labels.push(chars[i]);
      return labels;
    }
    // Two-letter labels for everything once we exceed single-letter pool.
    for (let i = 0; i < chars.length; i++) {
      for (let j = 0; j < chars.length; j++) {
        labels.push(chars[i] + chars[j]);
        if (labels.length >= n) return labels;
      }
    }
    return labels;
  }

  function enterHintMode(openInNewPane) {
    const targets = collectTargets();
    if (targets.length === 0) return;
    const labels = generateLabels(targets.length);

    const overlay = document.createElement('div');
    overlay.id = '__krypton_hints__';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

    const items = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const label = labels[i];
      const tag = document.createElement('div');
      tag.textContent = label.toUpperCase();
      const accent = openInNewPane ? '#7aaaff' : '#7aff7a';
      tag.style.cssText = [
        'position:fixed',
        'left:' + Math.max(0, Math.floor(t.rect.left)) + 'px',
        'top:' + Math.max(0, Math.floor(t.rect.top)) + 'px',
        'background:#0a0e0a',
        'color:' + accent,
        'border:1px solid ' + accent,
        'padding:1px 4px',
        'font:bold 11px ui-monospace,monospace',
        'line-height:1',
        'box-shadow:0 0 6px rgba(122,255,122,0.6)',
        'border-radius:2px',
        'pointer-events:none',
        'white-space:nowrap',
      ].join(';');
      overlay.appendChild(tag);
      items.push({ label: label, el: t.el, tag: tag });
    }
    document.body.appendChild(overlay);

    hintState = { items: items, typed: '', openInNewPane: openInNewPane };
    mode = 'hint';
  }

  function exitHintMode() {
    if (hintState) {
      const o = document.getElementById('__krypton_hints__');
      if (o) o.remove();
      hintState = null;
    }
    mode = 'normal';
  }

  function updateHintFilter(ch) {
    if (!hintState) return;
    hintState.typed += ch;
    const t = hintState.typed;
    let remaining = 0;
    let exact = null;
    for (let i = 0; i < hintState.items.length; i++) {
      const it = hintState.items[i];
      if (it.label.startsWith(t)) {
        it.tag.style.opacity = '1';
        remaining++;
        if (it.label === t) exact = it;
      } else {
        it.tag.style.opacity = '0.15';
      }
    }
    if (exact) {
      activateHint(exact);
    } else if (remaining === 0) {
      exitHintMode();
    }
  }

  function activateHint(item) {
    const el = item.el;
    const newPane = hintState.openInNewPane;
    exitHintMode();
    if (newPane && el.tagName === 'A' && el.href) {
      try {
        tauri.invoke('forward_action', {
          id: ID,
          kind: 'open_url',
          url: el.href,
          target: 'new_pane',
        });
      } catch (err) {}
      return;
    }
    try { el.focus({ preventScroll: true }); } catch (err) {}
    try { el.click(); } catch (err) {}
  }

  // ── Find mode ──
  function enterFindMode() {
    const prompt = document.createElement('div');
    prompt.id = '__krypton_find__';
    prompt.style.cssText = [
      'position:fixed', 'bottom:8px', 'left:8px', 'z-index:2147483647',
      'background:#0a0e0a', 'color:#7aff7a', 'border:1px solid #7aff7a',
      'padding:4px 8px', 'font:12px ui-monospace,monospace',
      'box-shadow:0 0 8px rgba(122,255,122,0.6)',
      'display:flex', 'align-items:center', 'gap:4px',
    ].join(';');
    const slash = document.createElement('span');
    slash.textContent = '/';
    const input = document.createElement('input');
    input.type = 'text';
    input.style.cssText = 'background:transparent;border:none;outline:none;color:#7aff7a;font:inherit;width:240px;caret-color:#7aff7a;';
    prompt.appendChild(slash);
    prompt.appendChild(input);
    document.body.appendChild(prompt);
    setTimeout(function () { input.focus(); }, 0);

    findState = { prompt: prompt, input: input };
    mode = 'find';

    input.addEventListener('keydown', function (e) {
      e.stopImmediatePropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = input.value;
        exitFindMode();
        if (q && typeof window.find === 'function') {
          lastFindQuery = q;
          window.find(q, false, false, true, false, true, false);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        exitFindMode();
      }
    }, true);
  }

  function exitFindMode() {
    if (findState) {
      findState.prompt.remove();
      findState = null;
    }
    mode = 'normal';
    try { window.focus(); } catch (err) {}
  }

  // ── Main vim-nav keydown handler ──
  window.addEventListener('keydown', function (e) {
    // Escape always exits hint mode.
    if (e.key === 'Escape' && mode === 'hint') {
      e.preventDefault();
      e.stopImmediatePropagation();
      exitHintMode();
      return;
    }
    if (mode === 'find') return; // find input owns its keys
    if (mode === 'hint') {
      const ch = e.key.toLowerCase();
      if (HINT_CHARS.indexOf(ch) >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        updateHintFilter(ch);
      }
      return;
    }

    // Normal mode below — skip if modifiers or editable focus.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (activeIsEditable()) return;

    const key = e.key;
    switch (key) {
      case 'j':
        e.preventDefault(); e.stopImmediatePropagation();
        window.scrollBy({ top: SCROLL_STEP, behavior: 'auto' });
        return;
      case 'k':
        e.preventDefault(); e.stopImmediatePropagation();
        window.scrollBy({ top: -SCROLL_STEP, behavior: 'auto' });
        return;
      case 'h':
        e.preventDefault(); e.stopImmediatePropagation();
        window.scrollBy({ left: -SCROLL_STEP, behavior: 'auto' });
        return;
      case 'l':
        e.preventDefault(); e.stopImmediatePropagation();
        window.scrollBy({ left: SCROLL_STEP, behavior: 'auto' });
        return;
      case 'H':
        e.preventDefault(); e.stopImmediatePropagation();
        try { history.back(); } catch (err) {}
        return;
      case 'L':
        e.preventDefault(); e.stopImmediatePropagation();
        try { history.forward(); } catch (err) {}
        return;
      case 'd':
        e.preventDefault(); e.stopImmediatePropagation();
        window.scrollBy({ top: window.innerHeight * HALF_PAGE, behavior: 'auto' });
        return;
      case 'u':
        e.preventDefault(); e.stopImmediatePropagation();
        window.scrollBy({ top: -window.innerHeight * HALF_PAGE, behavior: 'auto' });
        return;
      case 'g': {
        const now = Date.now();
        if (now - lastG < 500) {
          e.preventDefault(); e.stopImmediatePropagation();
          window.scrollTo({ top: 0, behavior: 'auto' });
          lastG = 0;
        } else {
          lastG = now;
        }
        return;
      }
      case 'G':
        e.preventDefault(); e.stopImmediatePropagation();
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        return;
      case 'f':
        e.preventDefault(); e.stopImmediatePropagation();
        enterHintMode(false);
        return;
      case 'F':
        e.preventDefault(); e.stopImmediatePropagation();
        enterHintMode(true);
        return;
      case '/':
        e.preventDefault(); e.stopImmediatePropagation();
        enterFindMode();
        return;
      case 'n':
        if (lastFindQuery && typeof window.find === 'function') {
          e.preventDefault(); e.stopImmediatePropagation();
          window.find(lastFindQuery, false, e.shiftKey, true, false, true, false);
        }
        return;
      case 'N':
        if (lastFindQuery && typeof window.find === 'function') {
          e.preventDefault(); e.stopImmediatePropagation();
          window.find(lastFindQuery, false, true, true, false, true, false);
        }
        return;
    }
  }, true);
})();
