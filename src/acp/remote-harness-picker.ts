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
}

export function remoteHarnessPickerRows(choices: RemoteHarnessChoices): PickerRow[] {
  const rows: PickerRow[] = [];
  if (choices.focusedSsh) {
    const ssh = choices.focusedSsh;
    rows.push({
      label: 'Current SSH',
      detail: `${ssh.user}@${ssh.host}:${ssh.port}${ssh.projectDir ? ` · ${ssh.projectDir}` : ' · project path required'}`,
      launch: {
        kind: 'focused_ssh',
        terminalSessionId: ssh.terminalSessionId,
        ...(ssh.projectDir ? { projectDir: ssh.projectDir } : {}),
      },
      needsPath: !ssh.projectDir,
    });
  }
  for (const profile of choices.profiles) {
    rows.push({
      label: profile.name,
      detail: `${profile.host} · ${profile.project_dir}`,
      launch: { kind: 'profile', profile: profile.name },
      needsPath: false,
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
  const rows = remoteHarnessPickerRows(choices);
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
        picker.pathInput.focus();
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
