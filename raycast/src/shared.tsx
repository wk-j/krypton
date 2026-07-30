import { useEffect } from 'react';

import { Action, ActionPanel, Icon, List } from '@raycast/api';

import { KryptonError, isNotRunning, launchKrypton } from './krypton';

// Open views poll: useCachedPromise is stale-while-revalidate, not periodic —
// without this timer a held-open view never refreshes (spec 205).
export function usePolling(revalidate: () => void, intervalMs = 2000): void {
  useEffect(() => {
    const timer = setInterval(revalidate, intervalMs);
    return () => clearInterval(timer);
  }, [revalidate, intervalMs]);
}

export function errorTitle(err: unknown): string {
  if (err instanceof KryptonError) {
    switch (err.kind) {
      case 'not-running':
        return 'Krypton is not running';
      case 'version-mismatch':
        return 'Incompatible Krypton version';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function ErrorListView({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const notRunning = isNotRunning(error);
  return (
    <List.EmptyView
      icon={Icon.Terminal}
      title={errorTitle(error)}
      description={
        notRunning
          ? 'controller.json is missing or stale — launch the app and try again'
          : 'Retry once Krypton is reachable'
      }
      actions={
        <ActionPanel>
          {notRunning && (
            <Action
              title="Launch Krypton"
              icon={Icon.Power}
              onAction={() => {
                launchKrypton();
                setTimeout(onRetry, 1500);
              }}
            />
          )}
          <Action title="Retry" icon={Icon.ArrowClockwise} onAction={onRetry} />
        </ActionPanel>
      }
    />
  );
}
