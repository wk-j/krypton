import { Action, ActionPanel, Color, Icon, List, Toast, showToast } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';

import { AttentionItem, KryptonError, PerHarness, basename, op, opPerHarness } from './krypton';
import { ErrorListView, usePolling } from './shared';

interface AttentionRow extends AttentionItem {
  harnessId: string;
  cwd: string;
}

async function fetchAttention(): Promise<AttentionRow[]> {
  const perHarness: PerHarness<AttentionItem[]>[] = await opPerHarness<AttentionItem[]>('attention.list');
  return perHarness.flatMap(({ harnessId, cwd, result }) =>
    result
      .filter((item) => item.status !== 'resolved')
      .map((item) => ({ ...item, harnessId, cwd })),
  );
}

function reversibilityColor(value: string): Color {
  switch (value) {
    case 'irreversible':
      return Color.Red;
    case 'costly':
      return Color.Orange;
    default:
      return Color.Green;
  }
}

function detailMarkdown(item: AttentionRow): string {
  const lines = [
    `## ${item.question}`,
    '',
    `**chosen** — ${item.chosen}`,
    '',
    `**rationale** — ${item.rationale}`,
    '',
    `**traded off**`,
    ...item.tradedOff.map((t) => `- ${t}`),
    '',
    `**uncertainty** — ${item.uncertainty}`,
  ];
  if (item.diffstat) lines.push('', '```', item.diffstat, '```');
  return lines.join('\n');
}

export default function Command() {
  const { data, error, isLoading, revalidate } = useCachedPromise(fetchAttention, [], { keepPreviousData: true });
  usePolling(revalidate);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={(data ?? []).length > 0}
      searchBarPlaceholder="Search attention flags…"
      navigationTitle="Krypton — Attention"
    >
      {error ? (
        <ErrorListView error={error} onRetry={revalidate} />
      ) : (data ?? []).length === 0 ? (
        <List.EmptyView icon={Icon.CheckCircle} title="Queue is clear" description="No open attention flags" />
      ) : (
        (data ?? []).map((item) => (
          <List.Item
            key={`${item.harnessId}:${item.id}`}
            icon={{ source: Icon.Flag, tintColor: reversibilityColor(item.reversibility) }}
            title={item.question}
            accessories={[{ tag: item.lane }]}
            detail={
              <List.Item.Detail
                markdown={detailMarkdown(item)}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Lane" text={item.lane} />
                    <List.Item.Detail.Metadata.Label title="Project" text={basename(item.cwd)} />
                    <List.Item.Detail.Metadata.TagList title="Reversibility">
                      <List.Item.Detail.Metadata.TagList.Item
                        text={item.reversibility}
                        color={reversibilityColor(item.reversibility)}
                      />
                    </List.Item.Detail.Metadata.TagList>
                    <List.Item.Detail.Metadata.Label title="Created" text={String(item.createdAt)} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="Resolve"
                  icon={Icon.CheckCircle}
                  onAction={async () => {
                    try {
                      await op('attention.resolve', { itemId: item.id, harnessId: item.harnessId }, { mutation: true });
                      await showToast({ style: Toast.Style.Success, title: 'Resolved' });
                    } catch (err) {
                      if (err instanceof KryptonError && err.code === 'attention_not_found') {
                        // already discharged elsewhere — a normal stale-snapshot race
                        await showToast({ style: Toast.Style.Success, title: 'Already resolved elsewhere' });
                      } else {
                        await showToast({
                          style: Toast.Style.Failure,
                          title: 'Resolve failed',
                          message: err instanceof Error ? err.message : String(err),
                        });
                        return;
                      }
                    }
                    revalidate();
                  }}
                />
                <Action.CopyToClipboard
                  title="Copy Question"
                  content={item.question}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
