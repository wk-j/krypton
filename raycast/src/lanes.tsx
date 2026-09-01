import {
  Action,
  ActionPanel,
  Alert,
  Detail,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  open,
  showToast,
  useNavigation,
} from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';

import {
  CANCELLABLE,
  LaneRow,
  RESTARTABLE,
  SendResult,
  TranscriptEntry,
  basename,
  nextPermissionMode,
  op,
  statusIcon,
  surfaceUrl,
} from './krypton';
import { ErrorListView, usePolling } from './shared';

async function fetchLanes(): Promise<LaneRow[]> {
  return op<LaneRow[]>('lane.list');
}

async function apiToast(title: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    await showToast({
      style: Toast.Style.Failure,
      title,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function SendPromptForm({ lane, onSent }: { lane: string; onSent: () => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle={`Send Prompt — ${lane}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send Prompt"
            icon={Icon.Envelope}
            onSubmit={async (values: { text: string }) => {
              const text = values.text.trim();
              if (!text) {
                await showToast({ style: Toast.Style.Failure, title: 'Prompt is empty' });
                return;
              }
              await apiToast('Send failed', async () => {
                const result = await op<SendResult>('lane.send', { lane, text }, { mutation: true });
                await showToast({
                  style: Toast.Style.Success,
                  title: result.status === 'queued' ? `Queued (depth ${result.queueDepth ?? '?'})` : 'Started',
                  message: lane,
                });
                pop();
                onSent();
              });
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea id="text" title="Prompt" placeholder="Message for the lane…" autoFocus />
    </Form>
  );
}

function TranscriptDetail({ lane }: { lane: string }) {
  const { data, isLoading } = useCachedPromise(
    async (target: string) => op<TranscriptEntry[]>('lane.transcript', { lane: target }),
    [lane],
  );
  const entries = (data ?? []).slice(-20);
  const markdown = entries.length
    ? entries.map((e) => `**${e.kind}**\n\n${e.text || '_(empty)_'}`).join('\n\n---\n\n')
    : 'No transcript yet.';
  return <Detail navigationTitle={`Transcript — ${lane}`} isLoading={isLoading} markdown={markdown} />;
}

function LaneItem({ lane, revalidate }: { lane: LaneRow; revalidate: () => void }) {
  const accessories: List.Item.Accessory[] = [];
  if (lane.modelName) accessories.push({ tag: lane.modelName });
  if (lane.queueDepth > 0) accessories.push({ tag: `queue ${lane.queueDepth}` });
  accessories.push({ tag: { value: lane.status.replace('_', ' '), color: statusIcon(lane.status).tintColor } });

  return (
    <List.Item
      key={lane.laneId}
      icon={statusIcon(lane.status)}
      title={lane.displayName}
      accessories={accessories}
      actions={
        <ActionPanel>
          <ActionPanel.Section title={lane.displayName}>
            <Action.Push
              title="Send Prompt"
              icon={Icon.Envelope}
              target={<SendPromptForm lane={lane.displayName} onSent={revalidate} />}
            />
            {CANCELLABLE.has(lane.status) && (
              <Action
                title="Cancel Turn"
                icon={Icon.Stop}
                shortcut={{ modifiers: ['ctrl'], key: 'c' }}
                onAction={() =>
                  apiToast('Cancel failed', async () => {
                    await op('lane.cancel', { lane: lane.displayName }, { mutation: true });
                    await showToast({ style: Toast.Style.Success, title: 'Cancelled', message: lane.displayName });
                    revalidate();
                  })
                }
              />
            )}
            <Action.Push
              title="View Transcript"
              icon={Icon.Paragraph}
              shortcut={{ modifiers: ['cmd'], key: 't' }}
              target={<TranscriptDetail lane={lane.displayName} />}
            />
            <Action
              title={`Permission Mode: ${lane.permissionMode} → ${nextPermissionMode(lane.permissionMode)}`}
              icon={Icon.Shield}
              shortcut={{ modifiers: ['cmd'], key: 'p' }}
              onAction={() =>
                apiToast('Mode change failed', async () => {
                  const mode = nextPermissionMode(lane.permissionMode);
                  await op('lane.permission_mode', { lane: lane.displayName, mode }, { mutation: true });
                  await showToast({ style: Toast.Style.Success, title: `Permission mode: ${mode}` });
                  revalidate();
                })
              }
            />
            {RESTARTABLE.has(lane.status) && (
              <Action
                title="Restart Lane…"
                icon={Icon.ArrowClockwise}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ['cmd', 'shift'], key: 'r' }}
                onAction={async () => {
                  const confirmed = await confirmAlert({
                    title: `Restart ${lane.displayName}?`,
                    message: 'The lane gets a fresh session — the current conversation is gone.',
                    primaryAction: { title: 'Restart', style: Alert.ActionStyle.Destructive },
                  });
                  if (!confirmed) return;
                  await apiToast('Restart failed', async () => {
                    await op('lane.restart', { lane: lane.displayName }, { mutation: true });
                    await showToast({ style: Toast.Style.Success, title: 'Restarted', message: lane.displayName });
                    revalidate();
                  });
                }}
              />
            )}
          </ActionPanel.Section>
          <ActionPanel.Section title="Surfaces">
            <Action
              title="Open Dashboard"
              icon={Icon.Globe}
              shortcut={{ modifiers: ['cmd'], key: 'd' }}
              onAction={() => apiToast('Open failed', async () => open(await surfaceUrl('dashboard')))}
            />
            <Action
              title="Open Artifact Gallery"
              icon={Icon.Image}
              shortcut={{ modifiers: ['cmd'], key: 'g' }}
              onAction={() => apiToast('Open failed', async () => open(await surfaceUrl('gallery')))}
            />
            {lane.sessionId && (
              <Action.CopyToClipboard
                title="Copy Session ID"
                content={lane.sessionId}
                shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
              />
            )}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const { data, error, isLoading, revalidate } = useCachedPromise(fetchLanes, [], { keepPreviousData: true });
  usePolling(revalidate);

  const byHarness = new Map<string, LaneRow[]>();
  for (const lane of data ?? []) {
    const group = byHarness.get(lane.cwd) ?? [];
    group.push(lane);
    byHarness.set(lane.cwd, group);
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search lanes…" navigationTitle="Krypton — Lanes">
      {error ? (
        <ErrorListView error={error} onRetry={revalidate} />
      ) : (
        [...byHarness.entries()].map(([cwd, lanes]) => (
          <List.Section key={cwd} title={basename(cwd)} subtitle={cwd}>
            {lanes.map((lane) => (
              <LaneItem key={lane.laneId} lane={lane} revalidate={revalidate} />
            ))}
          </List.Section>
        ))
      )}
    </List>
  );
}
