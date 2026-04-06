// Krypton — SSH Session Utilities
// Probes remote CWD via invisible OSC escape sequences.

import { invoke } from './profiler/ipc';
import { listen } from '@tauri-apps/api/event';

/** SSH connection metadata returned by detect_ssh_session */
export interface SshConnectionInfo {
  user: string;
  host: string;
  port: number;
  control_socket: string | null;
  extra_args: string[];
}

/**
 * Probe the remote CWD by injecting a command into the active PTY.
 *
 * The probe output is embedded inside a private-use OSC escape
 * sequence (OSC 7337) that xterm.js silently discards — the printf
 * output itself is completely invisible to the user.
 *
 * To hide the *command echo* (the shell repeating what we typed),
 * we wrap the payload in a compound command that:
 *   1. Saves the cursor position  (ESC 7)
 *   2. Turns off terminal echo    (stty -echo)
 *   3. Runs the printf            (produces the invisible OSC)
 *   4. Restores echo              (stty echo)
 *   5. Restores the cursor        (ESC 8) and erases the line
 *
 * Because `stty -echo` is set before the newline is echoed back
 * by the remote TTY driver, and cursor save/restore brackets the
 * whole thing, the terminal buffer is left untouched.
 *
 * Falls back to `null` if no response arrives within the timeout.
 */
export function probeRemoteCwd(sessionId: number): Promise<string | null> {
  const marker = `__KR_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}__`;
  const TIMEOUT_MS = 3000;

  // What we look for in the raw pty-output stream.
  // The printf will emit: ESC ] 7337 ; <marker> ; <cwd> BEL
  const oscStart = `\x1b]7337;${marker};`;
  const oscEnd = '\x07';

  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';

    // eslint-disable-next-line prefer-const
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
    };

    const finish = (cwd: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(cwd);
    };

    timer = setTimeout(() => finish(null), TIMEOUT_MS);

    // Listen for the OSC response in raw pty-output
    listen<[number, number[]]>('pty-output', (event) => {
      const [sid, data] = event.payload;
      if (sid !== sessionId || settled) return;

      buffer += new TextDecoder().decode(new Uint8Array(data));

      const si = buffer.indexOf(oscStart);
      if (si === -1) return;
      const payloadStart = si + oscStart.length;
      const ei = buffer.indexOf(oscEnd, payloadStart);
      if (ei === -1) return;

      const cwd = buffer.slice(payloadStart, ei).trim();
      finish(cwd || null);
    }).then((fn) => {
      if (settled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    // Inject the probe command.
    //
    // The command we send (as keystrokes into the PTY):
    //   <CR><ESC[2K> — move to column 0, erase the current line
    //                   (wipes the visible prompt so our command
    //                    doesn't appear next to stale text)
    //   <space>      — leading space: most shells skip history
    //   stty -echo;  — disable TTY echo so the command + output
    //                   are not displayed
    //   printf '\033]7337;<marker>;%s\007' "$(pwd)";
    //                — emit the CWD inside an invisible OSC sequence
    //   stty echo    — re-enable TTY echo
    //   <\n>         — execute the compound command
    //
    // After execution the shell prints a fresh prompt.  Because
    // echo was off during execution, neither the command text
    // nor the printf output were visible.  The fresh prompt
    // naturally replaces the erased line.
    const cmd = [
      '\r\x1b[2K',                                                    // CR + erase line
      ` stty -echo; printf '\\033]7337;${marker};%s\\007' "$(pwd)";`, // probe (no echo)
      ' stty echo\n',                                                  // restore echo + exec
    ].join('');

    const encoded = new TextEncoder().encode(cmd);
    invoke('write_to_pty', { sessionId, data: Array.from(encoded) })
      .catch(() => finish(null));
  });
}
