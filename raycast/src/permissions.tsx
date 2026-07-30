import { Action, ActionPanel, Icon, List, Toast, showToast } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';

import {
  KryptonError,
  LaneRow,
  PermissionRequest,
  basename,
  hasAllowOption,
  op,
  statusIcon,
} from './krypton';
import { ErrorListView, usePolling } from './shared';

interface PermissionRow {
  lane: LaneRow;
  head: PermissionRequest;
  total: number;
}

async function fetchPermissions(): Promise<PermissionRow[]> {
  const lanes = await op<LaneRow[]>('lane.list');
  const waiting = lanes.filter((lane) => lane.pendingPermissions > 0);
  const rows = await Promise.all(
    waiting.map(async (lane) => {
      const requests = await op<PermissionRequest[]>('permission.list', { lane: lane.displayName });
      // permission.resolve only accepts the oldest request — offer the head only
      return requests.length > 0 ? { lane, head: requests[0], total: requests.length } : null;
    }),
  );
  return rows.filter((row): row is PermissionRow => row !== null);
}

export default function Command() {
  const { data, error, isLoading, revalidate } = useCachedPromise(fetchPermissions, [], { keepPreviousData: true });
  usePolling(revalidate);

  async function resolve(row: PermissionRow, action: 'accept' | 'reject'): Promise<void> {
    try {
      await op(
        'permission.resolve',
        { lane: row.lane.displayName, requestId: row.head.requestId, action },
        { mutation: true },
      );
    } catch (err) {
      if (err instanceof KryptonError && (err.code === 'permission_not_found' || err.code === 'conflict')) {
        // head answered elsewhere first — expected stale-snapshot race
        revalidate();
        return;
      }
      await showToast({
        style: Toast.Style.Failure,
        title: `${action === 'accept' ? 'Accept' : 'Reject'} failed`,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // The API replies { resolved: true } even when the respond failed and the
    // request was requeued — success is confirmed by re-reading and checking
    // the requestId is gone (spec 205).
    const fresh = await fetchPermissions();
    revalidate();
    const still = fresh.some((r) => r.head.requestId === row.head.requestId);
    if (still) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Request is still pending',
        message: 'Krypton did not apply the response — answer it in-app',
      });
    } else {
      await showToast({
        style: Toast.Style.Success,
        title: action === 'accept' ? 'Accepted' : 'Rejected',
        message: `${row.head.tool} — ${row.lane.displayName}`,
      });
    }
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search pending permissions…"
      navigationTitle="Krypton — Permissions"
    >
      {error ? (
        <ErrorListView error={error} onRetry={revalidate} />
      ) : (data ?? []).length === 0 ? (
        <List.EmptyView icon={Icon.CheckCircle} title="Nothing pending" description="No lane is waiting on a permission" />
      ) : (
        (data ?? []).map((row) => (
          <List.Item
            key={`${row.lane.laneId}:${row.head.requestId}`}
            icon={statusIcon(row.lane.status)}
            title={row.lane.displayName}
            subtitle={row.head.tool}
            accessories={[
              { tag: basename(row.lane.cwd) },
              ...(row.total > 1 ? [{ tag: `1 of ${row.total}` }] : []),
            ]}
            actions={
              <ActionPanel>
                {hasAllowOption(row.head) && (
                  <Action title="Accept" icon={Icon.CheckCircle} onAction={() => resolve(row, 'accept')} />
                )}
                <Action
                  title="Reject"
                  icon={Icon.XMarkCircle}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                  onAction={() => resolve(row, 'reject')}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
