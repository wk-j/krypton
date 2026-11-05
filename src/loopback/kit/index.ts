// Spec 341 — the loopback kit. Surfaces import from here; a component's own
// sheet is imported by its module, so importing the barrel brings every kit
// style along (release builds merge all CSS into one `app.css` anyway).
// Spec 361: components are React function components; `lib/*` stays framework-free.

export { Chip, Dot, Pill, statusTone } from './badge';
export type { ChipProps, DotProps, DotState, PillProps, Tone } from './badge';
export { Banner, useBanner } from './banner';
export type { BannerController, BannerProps, BannerTone } from './banner';
export { Button } from './button';
export type { ButtonProps } from './button';
export { Card } from './card';
export type { CardOptions, CardProps } from './card';
export { DataTable } from './data-table';
export type { Column, DataTableOptions } from './data-table';
export { EmptyState } from './empty-state';
export type { EmptyStateProps } from './empty-state';
export { FeedbackOverlay } from './feedback-overlay';
export type { DocPin, FeedbackOverlayProps } from './feedback-overlay';
export { Island } from './island';
export type { IslandProps } from './island';
export { KbdHints } from './kbd-hints';
export type { KbdHintsProps } from './kbd-hints';
export { KeyValue } from './key-value';
export type { KeyValueProps } from './key-value';
export { PROSE_CLASS } from './prose';
export { RosterList } from './roster';
export type { RosterHandle, RosterOptions } from './roster';
export { SearchFilter } from './search-filter';
export type { SearchFilterOptions } from './search-filter';
export { AppShell, ShellProvider, useShell } from './shell';
export type { ShellApi } from './shell';
export { StatBar } from './stat-bar';
export type { Stat, StatBarProps } from './stat-bar';
export { Tabs } from './tabs';
export type { TabItem, TabsOptions } from './tabs';
export { hydrateTreeNav } from './tree-nav';
export { useKeyFallback, useKeymap, useLatest, useModal, usePoll } from './hooks';
export type { PollState, UsePollOptions } from './hooks';

export { copyText } from './lib/clipboard';
export { fetchJson, fetchText, HttpError, postJson } from './lib/fetch-json';
export {
  formatAgo,
  formatBytes,
  formatClock,
  formatDateTime,
  formatDuration,
  localizeTimes,
  matchesQuery,
  pad2,
} from './lib/format';
export { isEditableTarget, Keymap, keymap } from './lib/keymap';
export type { HelpEntry, KeyBinding } from './lib/keymap';
export { poll } from './lib/poll';
export type { Poller, PollOptions, PollStatus } from './lib/poll';
