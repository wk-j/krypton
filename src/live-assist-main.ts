import { loadConfig } from './config';
import { FrontendThemeEngine } from './theme';
import {
  LiveAssistClient,
  streamChangesRoster,
  streamNeedsSnapshot,
  streamText,
  type LiveAssistStreamDelivery,
} from './acp/live-assist-client';
import type { LiveAssistLaneSummary, LiveAssistStreamEvent } from './acp/live-assist-types';
import { LiveAssistView } from './acp/live-assist-view';
import './styles/live-assist.css';

async function main(): Promise<void> {
  const root = document.getElementById('live-assist-root');
  if (!root) throw new Error('Live Assist root is missing');

  const theme = new FrontendThemeEngine();
  try {
    await theme.init();
  } catch (error) {
    console.warn('[live-assist] theme unavailable, using defaults', error);
  }

  await applyConfiguredTypography();

  const client = new LiveAssistClient();
  let lanes: LiveAssistLaneSummary[] = [];
  let selectedLane: string | null = null;
  let refreshGeneration = 0;
  let refreshTimer: number | null = null;
  let disposed = false;
  let hasRendered = false;

  const view = new LiveAssistView(root, {
    onSelectLane: (lane) => void selectLane(lane),
    onSubmit: (text) => void submit(text),
    onCancel: () => void cancel(),
    onResolvePermission: (action) => void resolvePermission(action),
    onHide: () => void client.hide(),
  });

  async function bootstrap(): Promise<void> {
    const generation = ++refreshGeneration;
    // On a re-summon the panel still shows the last snapshot and the refresh
    // lands in a few ms, so swapping the status to "syncing" and back is pure
    // flicker. Only announce it when there is nothing on screen yet.
    if (!hasRendered) view.showLoading();
    try {
      const result = await client.bootstrap(selectedLane);
      if (disposed || generation !== refreshGeneration) return;
      lanes = result.lanes;
      const next = result.suggestedLane;
      view.setLanes(lanes, next);
      if (!next) {
        selectedLane = null;
        view.showEmpty();
        hasRendered = true;
        return;
      }
      selectedLane = next;
      await refreshSnapshot(generation);
    } catch (error) {
      if (generation === refreshGeneration) view.showError(errorMessage(error));
    }
  }

  async function selectLane(lane: string): Promise<void> {
    if (lane === selectedLane) {
      view.focusPrimaryControl();
      return;
    }
    selectedLane = lane;
    const generation = ++refreshGeneration;
    view.setLanes(lanes, selectedLane);
    view.showLoading();
    await refreshSnapshot(generation);
    if (!disposed && generation === refreshGeneration) view.focusPrimaryControl();
  }

  async function refreshSnapshot(generation = ++refreshGeneration): Promise<void> {
    if (!selectedLane) return;
    const lane = lanes.find((candidate) => candidate.displayName === selectedLane);
    if (!lane) {
      await bootstrap();
      return;
    }
    try {
      const snapshot = await client.snapshot(lane);
      if (disposed || generation !== refreshGeneration || selectedLane !== lane.displayName) return;
      view.renderSnapshot(snapshot);
      hasRendered = true;
      lanes = lanes.map((candidate) => (
        candidate.displayName === lane.displayName
          ? { ...candidate, ...snapshot.status }
          : candidate
      ));
      view.setLanes(lanes, selectedLane);
    } catch (error) {
      if (generation !== refreshGeneration) return;
      view.showError(errorMessage(error));
      scheduleBootstrap();
    }
  }

  function scheduleSnapshot(): void {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refreshSnapshot();
    }, 60);
  }

  function scheduleBootstrap(): void {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void bootstrap();
    }, 60);
  }

  function onStream(delivery: LiveAssistStreamDelivery): void {
    const event = delivery.event;
    if (delivery.gap) {
      scheduleBootstrap();
      return;
    }
    if (streamChangesRoster(event.kind)) {
      scheduleBootstrap();
      return;
    }
    if (event.lane !== selectedLane) return;
    const text = streamText(event);
    if (text !== null) view.appendStream(event.kind, text);
    if (event.kind === 'status') {
      const next = objectString(event.payload, 'next');
      if (next) view.updateStatus(next);
    }
    if (streamNeedsSnapshot(event.kind)) scheduleSnapshot();
  }

  async function submit(text: string): Promise<void> {
    if (!selectedLane) return;
    view.setSending(true);
    try {
      const result = await client.send(selectedLane, text);
      view.clearDraft();
      view.notice(result.status === 'queued' ? 'Prompt queued' : 'Prompt sent');
      scheduleSnapshot();
    } catch (error) {
      view.showError(errorMessage(error));
    } finally {
      view.setSending(false);
      view.focusComposer();
    }
  }

  async function cancel(): Promise<void> {
    if (!selectedLane) return;
    try {
      await client.cancel(selectedLane);
      view.notice('Cancel requested');
      scheduleSnapshot();
    } catch (error) {
      view.showError(errorMessage(error));
    }
  }

  async function resolvePermission(action: 'accept' | 'reject'): Promise<void> {
    if (!selectedLane) return;
    const permission = view.currentPermission();
    if (!permission) return;
    try {
      await client.resolvePermission(selectedLane, permission.requestId, action);
      view.notice(action === 'accept' ? 'Permission accepted' : 'Permission rejected');
      scheduleSnapshot();
    } catch (error) {
      view.showError(errorMessage(error));
      scheduleSnapshot();
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      void client.hide();
      return;
    }
    if (event.metaKey && event.key === 'Enter') {
      event.preventDefault();
      const text = view.draft();
      if (text) void submit(text);
      return;
    }
    if (event.metaKey && event.key === '.') {
      event.preventDefault();
      void cancel();
      return;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      const digit = Number.parseInt(event.key, 10);
      if (digit >= 1 && digit <= Math.min(lanes.length, 9)) {
        event.preventDefault();
        void selectLane(lanes[digit - 1].displayName);
        return;
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        cycleLane(event.key === '[' ? -1 : 1);
        return;
      }
    }
    if (view.permissionHasFocus() && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key.toLowerCase() === 'a' || event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void resolvePermission(event.key.toLowerCase() === 'a' ? 'accept' : 'reject');
      }
    }
  }

  function cycleLane(delta: number): void {
    if (lanes.length === 0) return;
    const current = lanes.findIndex((lane) => lane.displayName === selectedLane);
    const next = (Math.max(current, 0) + delta + lanes.length) % lanes.length;
    void selectLane(lanes[next].displayName);
  }

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', () => {
    disposed = true;
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    document.removeEventListener('keydown', onKeyDown);
    client.dispose();
    view.dispose();
  }, { once: true });

  try {
    await client.start(onStream, () => {
      void applyConfiguredTypography();
      view.playEntrance();
      void bootstrap().then(() => view.focusPrimaryControl());
    });
    await bootstrap();
    view.focusPrimaryControl();
  } catch (error) {
    view.showError(errorMessage(error));
  }
  // The summon that created this webview left the window hidden; release it only
  // once the first snapshot has actually been laid out and painted, so the
  // window never appears empty. Harmless no-op on every later summon.
  await nextPaint();
  void client.ready();
}

/** Resolve after the browser has committed the pending render. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// Re-read on every summon so a config edit lands, but only write a custom
// property whose value actually changed: an unconditional write invalidated
// style on <html> and relaid the whole panel out right after it became visible.
async function applyConfiguredTypography(): Promise<void> {
  try {
    const config = await loadConfig();
    const families = Array.isArray(config.font.family)
      ? config.font.family
      : [config.font.family as unknown as string];
    const userFamilies = families.map((f) => `'${f}'`).join(', ');
    setCustomProperty('--krypton-font-family', `${userFamilies}, ui-monospace, monospace`);
    setCustomProperty('--krypton-font-size', `${config.font.size}px`);
    setCustomProperty('--krypton-chrome-font-size', `${Math.round(config.font.size * 0.786)}px`);
  } catch (error) {
    console.warn('[live-assist] font config unavailable, using defaults', error);
  }
}

function setCustomProperty(name: string, value: string): void {
  const rootStyle = document.documentElement.style;
  if (rootStyle.getPropertyValue(name) === value) return;
  rootStyle.setProperty(name, value);
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
