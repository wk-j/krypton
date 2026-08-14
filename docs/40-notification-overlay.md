# Notification Overlay — Implementation Spec

> Status: Implemented
> Date: 2026-03-26
> Updated: 2026-08-14 — messages decay back to empty (`duration`, `.krypton-notif--empty`)
> Milestone: M8 — Polish

## Problem

Krypton has no general-purpose notification system for user-facing messages. The existing Claude Code toast system is tightly coupled to hook events. Terminal applications can emit notifications via OSC escape sequences (OSC 9, OSC 99, OSC 777), but Krypton currently ignores them. We need a standalone, futuristic notification overlay positioned at the bottom-right of the screen that:
1. Captures OSC notification sequences from terminal apps (build tools, scripts, long-running commands)
2. Provides a programmatic API callable from any frontend subsystem (config reload, errors, mode changes)

## Solution

Create a new `NotificationController` module (`src/notification.ts`) with a fixed-position container at the bottom-right corner. Notifications appear with a glitch-decode text animation (characters resolve from random cyberpunk glyphs), have per-level color coding, auto-dismiss with a shrinking timer bar, and stack upward. The overlay sits above terminal windows but below modal UI (command palette, which-key).

OSC notification sequences are intercepted via `terminal.parser.registerOscHandler()` on each xterm.js instance. This is frontend-only — no Rust VT parsing needed.

## Affected Files

| File | Change |
|------|--------|
| `src/notification.ts` | New module — controller class, decode animation, DOM management, OSC parser hooks |
| `src/styles.css` | New `.krypton-window__footer` block and `.krypton-notif` block — footer bar, notification bar/label/msg |
| `src/main.ts` | Instantiate `NotificationController`, wire to compositor |
| `src/compositor.ts` | Call `registerOscHandlers(terminal)` after each xterm.js Terminal is created; expose controller ref; build `krypton-window__footer` in all window creation paths (regular, content, Quick Terminal); `attachTo` targets footer on focus change |

## Design

### Data Structures

```typescript
type NotificationLevel = 'info' | 'success' | 'warning' | 'error' | 'system';

interface NotificationOptions {
  message: string;
  level?: NotificationLevel;       // default: 'info'
  label?: string;                  // override auto-label (e.g. 'RELOAD')
  duration?: number;               // ms, 0 = sticky, default: DEFAULT_TTL_MS (9000)
  decode?: boolean;                // glitch text reveal, default: true
}

/** undefined → default TTL; 0 or negative → sticky. */
export function resolveDismissDelay(duration?: number): number;
```

### Decay to Empty

The control lives in `.krypton-window__footer` — 28px of *permanent* chrome shared with
the spec-153 AI quotas and the spec-218 lane strip — so what sits there has to be current.
Without a TTL the last message ever fired held the rail for the rest of the session and
stopped meaning "this just happened"; the boot-time `claudeHooks.toast('Krypton
initialized')` in particular sat there indefinitely (it has been removed from `main.ts`).

- `DEFAULT_TTL_MS = 9000`. Timed from the **end** of the decode reveal, so a long message
  does not spend its dwell time animating. A new message cancels the pending timer.
- On expiry `clear()` runs: level/flash classes off, label and message text emptied,
  `krypton-notif--idle krypton-notif--empty` on. `--empty` is `display: none`, so the
  control leaves the rail entirely rather than fading in place — the quotas and the lane
  strip get the width back.
- There is no "SYS / Ready" idle text any more, and no idle text at boot: the control
  starts `--empty` and appears only when something actually fires.
- **No exit animation.** The footer's standing no-motion rule (spec 218); the message has
  been readable for nine seconds, and a fade would leave an invisible gap holding layout.
- `duration: 0` keeps a message sticky for callers that need it. Nothing uses it today.

### API / Commands

No new Tauri IPC commands. Frontend-only module.

```typescript
class NotificationController {
  show(opts: NotificationOptions): void;
  info(message: string, opts?: Partial<NotificationOptions>): void;
  success(message: string, opts?: Partial<NotificationOptions>): void;
  warn(message: string, opts?: Partial<NotificationOptions>): void;
  error(message: string, opts?: Partial<NotificationOptions>): void;
  system(message: string, opts?: Partial<NotificationOptions>): void;
  clear(): void;
  destroy(): void;
}
```

### OSC Detection

Terminal apps send notifications via escape sequences. We register handlers on each xterm.js terminal instance using `terminal.parser.registerOscHandler()`.

**Supported sequences:**

| OSC | Protocol | Format | Used by |
|-----|----------|--------|---------|
| 9 | iTerm2/ConEmu | `\e]9;message\a` | notify-send wrappers, build tools |
| 777 | rxvt-unicode | `\e]777;notify;title;body\a` | urxvt scripts, some CLI tools |
| 99 | kitty | `\e]99;i=id:d=0;title\e\\` then `\e]99;i=id:d=1;body\e\\` | kitty-native apps |

**Registration (called per terminal):**

```typescript
class NotificationController {
  /** Register OSC handlers on an xterm.js terminal instance */
  registerOscHandlers(terminal: Terminal): void {
    // OSC 9: simple message
    terminal.parser.registerOscHandler(9, (data: string) => {
      this.show({ message: data, level: 'info', label: 'TERM' });
      return true; // handled, don't pass through
    });

    // OSC 777: notify;title;body
    terminal.parser.registerOscHandler(777, (data: string) => {
      const parts = data.split(';');
      if (parts[0] === 'notify' && parts.length >= 3) {
        const title = parts[1];
        const body = parts.slice(2).join(';');
        this.show({ message: body, level: 'info', label: title.toUpperCase() });
      }
      return true;
    });

    // OSC 99: kitty notification protocol
    terminal.parser.registerOscHandler(99, (data: string) => {
      this.handleKittyNotification(data);
      return true;
    });
  }
}
```

**Kitty protocol (OSC 99) state machine:**

Kitty notifications are multi-part — `d=0` sends the title, `d=1` sends the body, keyed by `i=<id>`. We hold a `Map<string, { title: string }>` of pending notifications. When `d=1` arrives (or `d=0` with no follow-up after 500ms timeout), we fire the notification.

```typescript
private pendingKitty = new Map<string, { title: string; timer: number }>();

private handleKittyNotification(data: string): void {
  // Parse key=value pairs before semicolon, message after semicolon
  const semiIdx = data.indexOf(';');
  const meta = semiIdx >= 0 ? data.slice(0, semiIdx) : data;
  const payload = semiIdx >= 0 ? data.slice(semiIdx + 1) : '';

  const params = new Map<string, string>();
  for (const part of meta.split(':')) {
    const eq = part.indexOf('=');
    if (eq >= 0) params.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const id = params.get('i') ?? 'default';
  const done = params.get('d') ?? '0';  // 0 = title/only, 1 = body

  if (done === '0') {
    // Title part — wait for body
    const timer = window.setTimeout(() => {
      // No body arrived — show title-only notification
      this.pendingKitty.delete(id);
      this.show({ message: payload, level: 'info', label: 'TERM' });
    }, 500);
    this.pendingKitty.set(id, { title: payload, timer });
  } else if (done === '1') {
    // Body part — combine with pending title
    const pending = this.pendingKitty.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingKitty.delete(id);
      this.show({ message: payload, level: 'info', label: pending.title.toUpperCase() || 'TERM' });
    } else {
      this.show({ message: payload, level: 'info', label: 'TERM' });
    }
  }
}
```

### Data Flow — OSC Path

```
1. Terminal app writes OSC 9/777/99 sequence to PTY
2. Rust backend forwards raw bytes via pty-output event (no parsing)
3. xterm.js parser encounters OSC, fires registered handler
4. Handler calls NotificationController.show() with parsed message
5. (continues with standard notification rendering flow below)
```

### Data Flow — Programmatic Path

```
1. Any module calls notificationController.info('Config reloaded')
2. NotificationController creates DOM element with BEM classes
3. Element inserted into fixed container (prepend — newest at bottom)
4. requestAnimationFrame triggers enter transition (slide + fade from right)
5. Decode animation runs: glitch glyphs → final text (left-to-right wave)
6. Timer bar shrinks over duration via CSS animation
7. After duration, exit transition plays (slide right + fade out)
8. Element removed from DOM after transition completes
```

### UI Changes

**DOM structure — notification lives inside the window footer:**
```html
<div class="krypton-window">
  <div class="krypton-window__chrome">...</div>       <!-- titlebar + header accent -->
  <div class="krypton-window__tabbar">...</div>
  <div class="krypton-window__perspective">...</div>   <!-- terminal content -->
  <div class="krypton-window__footer">                 <!-- footer bar -->
    <div class="krypton-notif krypton-notif--info">    <!-- notification (moved on focus) -->
      <div class="krypton-notif__bar"></div>            <!-- left accent line -->
      <span class="krypton-notif__label">INFO</span>   <!-- level badge -->
      <span class="krypton-notif__msg">message</span>  <!-- decode-animated text -->
    </div>
  </div>
</div>
```

**Footer positioning:**
- `krypton-window__footer` is a structural child of every window element (regular, content, Quick Terminal)
- 24px height, flex row, faint accent-colored top border and tinted background
- Notification is inline (`margin-left: auto` for right-alignment), not absolutely positioned
- `attachTo(windowEl)` finds `.krypton-window__footer` inside the target window and appends the notification element there. Called on focus change to move the single notification control between windows
- A decayed control is `display: none`, so it pushes nothing. The spec-218 lane strip keys its
  own right-alignment off `.krypton-window__footer:has(.krypton-notif:not(.krypton-notif--empty))`
  and takes `margin-left: auto` back when the rail is quiet

**Visual style per level:**

| Level | Left bar color | Label color | Glow accent |
|-------|---------------|-------------|-------------|
| info | cyan | cyan | cyan |
| success | green (#00ff88) | green | green |
| warning | amber (#ffaa00) | amber | amber |
| error | red (#ff3355) | red | red |
| system | magenta (#cc44ff) | magenta | magenta |

**Item styling (integrated into window chrome):**
- Transparent background (inherits from window footer)
- Left accent bar: 2px, colored by level, with subtle glow
- Monospace font (project font family var `--krypton-font-family`)
- Font size: 12px for message, 11px uppercase for label
- Bar and label colors use `--krypton-window-accent` as fallback — automatically matches the window's accent color
- Scan-line sweep on new message (`krypton-notif--flash` triggers `krypton-notif-scanline` keyframe)

**Animations:**
- **Decode:** probabilistic heat-based reveal, left-to-right bias with neighbour boost, 40 FPS
- **Scan-line flash:** 2px gradient line sweeps top-to-bottom on new message, 400ms
- **Idle/active:** opacity transition (0.4 idle → 1.0 active), 300ms ease

**Single transient control:** One notification at a time; new messages replace the current one in-place (no stacking), and the control decays back to empty when the TTL expires.

## Edge Cases

- **Rapid fire:** New messages replace the current one in-place (single control, no stacking); each replacement cancels the previous message's TTL and re-arms after its own decode.
- **Decode interrupted by a new message:** The old decode interval and its pending TTL are both cleared before the new message renders, so an abandoned reveal can never dismiss the message that replaced it.
- **Nothing has fired yet:** The control starts `--empty` and is absent from the rail — a fresh window's footer shows only quotas and the lane strip.
- **Empty message:** Render the label only; skip decode animation.
- **Long messages:** `max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`
- **OSC with empty payload:** Ignore silently (return true to consume the sequence).
- **Kitty orphaned title:** If OSC 99 `d=0` arrives but no `d=1` within 500ms, show title as the message.
- **Multiple terminals:** Each terminal registers its own OSC handlers, all route to the same controller. No dedup — if two terminals send the same notification, both show.
- **Malicious/huge OSC payload:** Truncate message to 256 characters before rendering.

## Out of Scope

- Sound effects on notification (can be added later via sound engine).
- Notification history/log panel.
- Grouping/deduplication of identical messages.
- Backend-originated notifications (this is frontend-only; backend can emit events that frontend handles).
- Replacing the existing Claude Code toast system (they coexist).
