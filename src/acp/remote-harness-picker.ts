import { nextCursor, prevCursor } from './components/list-picker';
import { RemotePicker } from './components/remote-picker';
import type { RemoteHarnessProfile } from '../config';

export interface FocusedSshCandidate {
  terminalSessionId: number;
  user: string;
  host: string;
  port: number;
  projectDir: string | null;
}

export interface RemoteHarnessChoices {
  focusedSsh: FocusedSshCandidate | null;
  profiles: RemoteHarnessProfile[];
}

export type RemoteHarnessLaunch =
  | { kind: 'profile'; profile: string }
  | { kind: 'focused_ssh'; terminalSessionId: number; projectDir?: string };

export interface RemoteHarnessWorkspace {
  runtimeId: string;
  source: 'profile' | 'focused_ssh';
  profile: string | null;
  user: string;
  host: string;
  port: number;
  path: string;
  borrowedMaster: boolean;
}

interface PickerRow {
  label: string;
  detail: string;
  launch: RemoteHarnessLaunch;
  needsPath: boolean;
  /** What the path input starts with when the row needs one ('' = empty). */
  pathPrefill: string;
}

/** Spec 247: the last project path a Current SSH Harness connected with, per destination. */
function lastProjectDirKey(ssh: FocusedSshCandidate): string {
  return `krypton:remote-harness:last-project-dir:${ssh.user}@${ssh.host}:${ssh.port}`;
}

function lastProjectDir(ssh: FocusedSshCandidate): string | null {
  try {
    return localStorage.getItem(lastProjectDirKey(ssh));
  } catch {
    return null; // localStorage unavailable — nothing to prefill
  }
}

/** Spec 247: remember the canonical path a Current SSH Harness connected with,
 *  so the next launch to that destination without an OSC 7 cwd prefills it. */
export function rememberLastProjectDir(ssh: FocusedSshCandidate, path: string): void {
  try {
    localStorage.setItem(lastProjectDirKey(ssh), path);
  } catch {
    // localStorage unavailable — the path simply won't be prefilled next time
  }
}

/** `lastDir` is the remembered path for `choices.focusedSsh`; the live OSC 7
 *  cwd wins over it, and it is only ever offered in the editable path input. */
export function remoteHarnessPickerRows(choices: RemoteHarnessChoices, lastDir: string | null): PickerRow[] {
  const rows: PickerRow[] = [];
  if (choices.focusedSsh) {
    const ssh = choices.focusedSsh;
    const where = ssh.projectDir
      ? ` · ${ssh.projectDir}`
      : lastDir ? ` · last used ${lastDir}` : ' · project path required';
    rows.push({
      label: 'Current SSH',
      detail: `${ssh.user}@${ssh.host}:${ssh.port}${where}`,
      launch: {
        kind: 'focused_ssh',
        terminalSessionId: ssh.terminalSessionId,
        ...(ssh.projectDir ? { projectDir: ssh.projectDir } : {}),
      },
      needsPath: !ssh.projectDir,
      pathPrefill: ssh.projectDir ? '' : lastDir ?? '',
    });
  }
  for (const profile of choices.profiles) {
    rows.push({
      label: profile.name,
      detail: `${profile.host} · ${profile.project_dir}`,
      launch: { kind: 'profile', profile: profile.name },
      needsPath: false,
      pathPrefill: '',
    });
  }
  return rows;
}

/**
 * The dialog. `RemotePicker` (spec 302 §7.6) owns the markup and the selection
 * state it draws; the promise, the `document`-level key capture and what Enter
 * means stay here (CLAUDE.md constraint 1).
 */
export function showRemoteHarnessPicker(
  host: HTMLElement,
  choices: RemoteHarnessChoices,
): Promise<RemoteHarnessLaunch | null> {
  const rows = remoteHarnessPickerRows(
    choices,
    choices.focusedSsh ? lastProjectDir(choices.focusedSsh) : null,
  );
  return new Promise((resolve) => {
    const picker = new RemotePicker();
    let cursor = 0;
    let pathMode = false;
    let pathInvalid = false;

    const render = (): void => {
      picker.update({
        rows,
        cursor,
        pathMode,
        pathInvalid,
        onChoose: (index: number): void => {
          cursor = index;
          choose();
        },
      });
    };
    const finish = (value: RemoteHarnessLaunch | null): void => {
      document.removeEventListener('keydown', onKeyDown, true);
      picker.el.remove();
      picker.dispose();
      resolve(value);
    };
    const choose = (): void => {
      const row = rows[cursor];
      if (!row) return;
      if (row.needsPath && row.launch.kind === 'focused_ssh') {
        pathMode = true;
        pathInvalid = false;
        render();
        // Selected, so Enter accepts the remembered path and typing replaces it.
        picker.pathInput.value = row.pathPrefill;
        picker.pathInput.focus();
        picker.pathInput.select();
        return;
      }
      finish(row.launch);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (pathMode) {
        if (event.key === 'Escape') {
          event.preventDefault();
          pathMode = false;
          pathInvalid = false;
          picker.pathInput.value = '';
          render();
          picker.el.focus();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const path = picker.pathInput.value.trim();
          const row = rows[cursor];
          if (!path.startsWith('/') || row?.launch.kind !== 'focused_ssh') {
            pathInvalid = true;
            render();
            return;
          }
          finish({ ...row.launch, projectDir: path });
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      } else if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        cursor = nextCursor(cursor, rows.length);
        render();
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        cursor = prevCursor(cursor, rows.length);
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose();
      }
    };

    host.appendChild(picker.el);
    render();
    document.addEventListener('keydown', onKeyDown, true);
    picker.el.focus();
  });
}
