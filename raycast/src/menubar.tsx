import { Color, Icon, LaunchType, MenuBarExtra, launchCommand, open } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';

import {
  AttentionItem,
  LaneRow,
  basename,
  launchKrypton,
  op,
  opPerHarness,
  surfaceUrl,
} from './krypton';

interface Status {
  busy: LaneRow[];
  needsPermission: LaneRow[];
  attention: Array<AttentionItem & { cwd: string }>;
  fetchedAt: Date;
}

async function fetchStatus(): Promise<Status> {
  const [lanes, perHarness] = await Promise.all([
    op<LaneRow[]>('lane.list'),
    opPerHarness<AttentionItem[]>('attention.list'),
  ]);
  return {
    busy: lanes.filter((l) => l.status === 'busy' || l.status === 'awaiting_peer'),
    needsPermission: lanes.filter((l) => l.status === 'needs_permission'),
    attention: perHarness.flatMap(({ cwd, result }) =>
      result.filter((item) => item.status !== 'resolved').map((item) => ({ ...item, cwd })),
    ),
    fetchedAt: new Date(),
  };
}

function badge(status: Status): string | undefined {
  const parts: string[] = [];
  if (status.busy.length > 0) parts.push(`${status.busy.length}▸`);
  if (status.needsPermission.length > 0) parts.push(`✋${status.needsPermission.length}`);
  if (status.attention.length > 0) parts.push(`⚑${status.attention.length}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function view(name: 'lanes' | 'permissions' | 'attention'): () => void {
  return () => {
    // best-effort: background menu-bar runs must stay silent
    launchCommand({ name, type: LaunchType.UserInitiated }).catch(() => undefined);
  };
}

export default function Command() {
  // keepPreviousData: false — error/not-running must take precedence over a
  // cached healthy badge; a silent background failure may not masquerade as
  // fresh data (spec 205).
  const { data, error, isLoading } = useCachedPromise(fetchStatus, [], { keepPreviousData: false });

  if (error || !data) {
    return (
      <MenuBarExtra
        icon={{ source: Icon.Terminal, tintColor: Color.SecondaryText }}
        tooltip="Krypton — unavailable"
        isLoading={isLoading}
      >
        <MenuBarExtra.Item title="Krypton is not reachable" icon={Icon.Terminal} onAction={() => launchKrypton()} />
        <MenuBarExtra.Item title="Launch Krypton" icon={Icon.Power} onAction={() => launchKrypton()} />
      </MenuBarExtra>
    );
  }

  return (
    <MenuBarExtra
      icon={Icon.Terminal}
      title={badge(data)}
      tooltip={`Krypton — updated ${data.fetchedAt.toLocaleTimeString()}`}
      isLoading={isLoading}
    >
      {data.needsPermission.length > 0 && (
        <MenuBarExtra.Section title="Needs permission">
          {data.needsPermission.map((lane) => (
            <MenuBarExtra.Item
              key={lane.laneId}
              title={`${lane.displayName} — ${basename(lane.cwd)}`}
              icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
              onAction={view('permissions')}
            />
          ))}
        </MenuBarExtra.Section>
      )}
      {data.busy.length > 0 && (
        <MenuBarExtra.Section title="Busy">
          {data.busy.map((lane) => (
            <MenuBarExtra.Item
              key={lane.laneId}
              title={`${lane.displayName}${lane.queueDepth > 0 ? ` · queue ${lane.queueDepth}` : ''}`}
              icon={{ source: Icon.CircleFilled, tintColor: Color.Orange }}
              onAction={view('lanes')}
            />
          ))}
        </MenuBarExtra.Section>
      )}
      {data.attention.length > 0 && (
        <MenuBarExtra.Section title={`Attention (${data.attention.length})`}>
          {data.attention.slice(0, 8).map((item) => (
            <MenuBarExtra.Item
              key={item.id}
              title={item.question.length > 60 ? `${item.question.slice(0, 60)}…` : item.question}
              icon={{ source: Icon.Flag, tintColor: Color.Yellow }}
              onAction={view('attention')}
            />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Open Lanes" icon={Icon.List} onAction={view('lanes')} />
        <MenuBarExtra.Item
          title="Open Dashboard"
          icon={Icon.Globe}
          onAction={() => {
            open(surfaceUrl('dashboard')).catch(() => undefined);
          }}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
