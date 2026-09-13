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

export function showRemoteHarnessPicker(
  host: HTMLElement,
  choices: RemoteHarnessChoices,
): Promise<RemoteHarnessLaunch | null> {
  const rows = remoteHarnessPickerRows(choices);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'remote-harness-picker';
    overlay.tabIndex = 0;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Open Remote ACP Harness');

    let cursor = 0;
    let pathMode = false;
    const panel = document.createElement('section');
    panel.className = 'remote-harness-picker__panel';
    const head = document.createElement('header');
    head.className = 'remote-harness-picker__head';
    head.textContent = 'REMOTE ACP HARNESS';
    const list = document.createElement('div');
    list.className = 'remote-harness-picker__list';
    const pathInput = document.createElement('input');
    pathInput.className = 'remote-harness-picker__path';
    pathInput.placeholder = '/absolute/remote/project/path';
    pathInput.hidden = true;
    const hint = document.createElement('footer');
    hint.className = 'remote-harness-picker__hint';
    hint.textContent = rows.length > 0 ? 'j/k select · Enter connect · Esc cancel' : 'No SSH session or remote profiles · Esc close';
    panel.append(head, list, pathInput, hint);
    overlay.appendChild(panel);
    host.appendChild(overlay);

    const finish = (value: RemoteHarnessLaunch | null): void => {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve(value);
    };
    const render = (): void => {
      list.replaceChildren(...rows.map((row, index) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `remote-harness-picker__row${index === cursor ? ' remote-harness-picker__row--active' : ''}`;
        el.innerHTML = `<strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.detail)}</span>`;
        el.addEventListener('click', () => {
          cursor = index;
          void choose();
        });
        return el;
      }));
    };
    const choose = async (): Promise<void> => {
      const row = rows[cursor];
      if (!row) return;
      if (row.needsPath && row.launch.kind === 'focused_ssh') {
        pathMode = true;
        pathInput.hidden = false;
        hint.textContent = 'Enter connect · Esc back · absolute path required';
        pathInput.focus();
        return;
      }
      finish(row.launch);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (pathMode) {
        if (event.key === 'Escape') {
          event.preventDefault();
          pathMode = false;
          pathInput.hidden = true;
          pathInput.value = '';
          hint.textContent = 'j/k select · Enter connect · Esc cancel';
          overlay.focus();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const path = pathInput.value.trim();
          const row = rows[cursor];
          if (!path.startsWith('/') || row?.launch.kind !== 'focused_ssh') {
            hint.textContent = 'Enter an absolute path beginning with /';
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
        if (rows.length > 0) cursor = (cursor + 1) % rows.length;
        render();
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (rows.length > 0) cursor = (cursor - 1 + rows.length) % rows.length;
        render();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void choose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    render();
    overlay.focus();
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] ?? char));
}
