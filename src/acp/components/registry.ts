// Spec 301 §Registry — the mounted set, one line per component.
//
// Adding a component is creating its directory plus one import and one array
// entry here. Removing it is deleting the directory and those two lines: the
// CSS, the scheme override and the listeners go with it, because `dispose()`
// and the stylesheet both belong to the directory.
//
// Rejected — `import.meta.glob` auto-discovery: zero registration lines, but
// the mounted set stops being greppable, tree-shaking is defeated, and every
// vitest file would load every component. One explicit line is cheaper.
//
// `styles-ownership.test.ts` reads this array: a directory that ships a
// stylesheet and is not listed here fails the build.

import { def as actionButton } from './action-button';
import { def as annotationRail } from './annotation-rail';
import { def as assistantRow } from './assistant-row';
import { def as backgroundTasks } from './background-tasks';
import { def as card } from './card';
import { def as caret } from './caret';
import { def as chip } from './chip';
import { def as composer } from './composer';
import { def as composerMeta } from './composer-meta';
import { def as decisionComposer } from './decision-composer';
import { def as dictationControl } from './dictation-control';
import { def as diffBlock } from './diff-block';
import { def as directiveDiffRow } from './directive-diff-row';
import { def as directivePicker } from './directive-picker';
import { def as docCardRow } from './doc-card-row';
import { def as draftLine } from './draft-line';
import { def as emptyState } from './empty-state';
import { def as executionCard } from './execution-card';
import { def as executionDialog } from './execution-dialog';
import { def as followUpRail } from './follow-up-rail';
import { def as fsActivityRow } from './fs-activity-row';
import { def as fsWriteReviewRow } from './fs-write-review-row';
import { def as genuiCard } from './genui-card';
import { def as genuiCatalog } from './genui-catalog';
import { def as genuiPanel } from './genui-panel';
import { def as handoffPicker } from './handoff-picker';
import { def as heatPanel } from './heat-panel';
import { def as helpOverlay } from './help-overlay';
import { def as imageStrip } from './image-strip';
import { def as imageViewer } from './image-viewer';
import { def as inlinePalette } from './inline-palette';
import { def as interLaneRow } from './inter-lane-row';
import { def as keyHintBar } from './key-hint-bar';
import { def as laneHead } from './lane-head';
import { def as lanePicker } from './lane-picker';
import { def as laneRail } from './lane-rail';
import { def as laneShell } from './lane-shell';
import { def as laneStats } from './lane-stats';
import { def as laneSymbol } from './lane-symbol';
import { def as listPicker } from './list-picker';
import { def as liveVoiceStrip } from './live-voice-strip';
import { def as memoryDrawer } from './memory-drawer';
import { def as meter } from './meter';
import { def as metricsOverlay } from './metrics-overlay';
import { def as modelPicker } from './model-picker';
import { def as orchestratorConsole } from './orchestrator-console';
import { def as overlayShell } from './overlay-shell';
import { def as peekCard } from './peek-card';
import { def as peerStrip } from './peer-strip';
import { def as permissionRow } from './permission-row';
import { def as planPanel } from './plan-panel';
import { def as providerErrorRow } from './provider-error-row';
import { def as questionRow } from './question-row';
import { def as queueCard } from './queue-card';
import { def as railEntry } from './rail-entry';
import { def as remotePicker } from './remote-picker';
import { def as resourceRail } from './resource-rail';
import { def as reviewLoopRows } from './review-loop-rows';
import { def as reviewMatrixOverlay } from './review-matrix-overlay';
import { def as reviewPriorityOverlay } from './review-priority-overlay';
import { def as reviewThreadDialog } from './review-thread-dialog';
import { def as sessionPicker } from './session-picker';
import { def as spinner } from './spinner';
import { def as stagingStrip } from './staging-strip';
import { def as statList } from './stat-list';
import { def as subagentCard } from './subagent-card';
import { def as systemRow } from './system-row';
import { def as tabStrip } from './tab-strip';
import { def as grammarPanel } from './grammar-panel';
import { def as thoughtCard } from './thought-card';
import { def as thoughtRow } from './thought-row';
import { def as ticketDock } from './ticket-dock';
import { def as ticketPicker } from './ticket-picker';
import { def as toolRow } from './tool-row';
import { def as transcript } from './transcript';
import { def as transcriptRow } from './transcript-row';
import { def as triageOverlay } from './triage-overlay';
import { def as usageRow } from './usage-row';
import { def as userRow } from './user-row';
import type { ComponentDef } from './types';

export const HARNESS_COMPONENTS: readonly ComponentDef[] = [
  // layer 1 — leaf primitives
  chip,
  spinner,
  meter,
  statList,
  emptyState,
  actionButton,
  keyHintBar,
  tabStrip,
  caret,
  // layer 2 — composite primitives
  card,
  overlayShell,
  listPicker,
  inlinePalette,
  diffBlock,
  // layer 3 — transcript rows
  transcriptRow,
  transcript,
  assistantRow,
  genuiCard,
  thoughtRow,
  userRow,
  toolRow,
  executionCard,
  subagentCard,
  permissionRow,
  questionRow,
  fsActivityRow,
  fsWriteReviewRow,
  providerErrorRow,
  interLaneRow,
  docCardRow,
  usageRow,
  systemRow,
  directiveDiffRow,
  imageStrip,
  resourceRail,
  followUpRail,
  // layer 4 — lane chrome
  laneShell,
  laneHead,
  laneSymbol,
  laneStats,
  railEntry,
  laneRail,
  // layer 5 — right rail
  peekCard,
  reviewLoopRows,
  heatPanel,
  thoughtCard,
  queueCard,
  planPanel,
  ticketDock,
  annotationRail,
  // layer 6 — composer
  composer,
  composerMeta,
  draftLine,
  stagingStrip,
  peerStrip,
  grammarPanel,
  dictationControl,
  liveVoiceStrip,
  decisionComposer,
  // layer 7 — overlays
  lanePicker,
  directivePicker,
  modelPicker,
  sessionPicker,
  ticketPicker,
  remotePicker,
  triageOverlay,
  reviewMatrixOverlay,
  reviewPriorityOverlay,
  orchestratorConsole,
  memoryDrawer,
  handoffPicker,
  helpOverlay,
  metricsOverlay,
  backgroundTasks,
  imageViewer,
  executionDialog,
  genuiPanel,
  genuiCatalog,
  reviewThreadDialog,
];
