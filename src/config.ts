// Krypton — Configuration
// TypeScript types mirroring the Rust config structs.
// Loaded from backend via IPC on startup.

import { invoke } from './profiler/ipc';

export interface ShellConfig {
  program: string;
  args: string[];
}

export interface FontConfig {
  family: string[];
  size: number;
  line_height: number;
  ligatures: boolean;
}

export interface TerminalConfig {
  scrollback_lines: number;
  cursor_style: 'block' | 'underline' | 'bar';
  cursor_blink: boolean;
  cursor_trail: boolean;
}

export interface ThemeColors {
  foreground: string | null;
  background: string | null;
  cursor: string | null;
  selection: string | null;
  black: string | null;
  red: string | null;
  green: string | null;
  yellow: string | null;
  blue: string | null;
  magenta: string | null;
  cyan: string | null;
  white: string | null;
  bright_black: string | null;
  bright_red: string | null;
  bright_green: string | null;
  bright_yellow: string | null;
  bright_blue: string | null;
  bright_magenta: string | null;
  bright_cyan: string | null;
  bright_white: string | null;
}

export interface ThemeConfig {
  name: string;
  colors: ThemeColors;
}

export interface QuickTerminalConfig {
  width_ratio: number;
  height_ratio: number;
  backdrop_blur: number;
  animation: string;
  shell: string;
  cwd: string;
}

export interface WorkspacesScrollConfig {
  default_column_width: number;
  default_window_height: number;
  preset_column_widths: number[];
  center_focused_column: string;
  always_center_single_column: boolean;
}

export interface WorkspacesConfig {
  startup: string;
  default_layout: string;
  gap: number;
  padding: number;
  resize_step: number;
  move_step: number;
  resize_step_large: number;
  move_step_large: number;
  scroll?: WorkspacesScrollConfig;
}

export interface SoundConfig {
  enabled: boolean;
  volume: number;
  pack: string;
  keyboard_type: string;
  keyboard_volume: number;
  events: Record<string, boolean | number>;
}

export interface HintRule {
  name: string;
  regex: string;
  action: 'Copy' | 'Open' | 'Paste';
  enabled: boolean;
}

/** What selecting a `filepath` hint does. See docs/0210-quick-overview-dialog.md. */
export type HintFileAction = 'peek' | 'editor';

export interface HintsConfig {
  alphabet: string;
  rules: HintRule[];
  file_action: HintFileAction;
}

export interface TabsConfig {
  always_show_tabbar: boolean;
  default_split: 'vertical' | 'horizontal';
  close_window_on_last_tab: boolean;
}

export type ShaderPresetName = 'none' | 'crt' | 'hologram' | 'glitch' | 'bloom' | 'matrix';

export interface ShaderConfig {
  enabled: boolean;
  preset: ShaderPresetName;
  intensity: number;
  animate: boolean;
  fps_cap: number;
}

export const DEFAULT_SHADER_CONFIG: ShaderConfig = {
  enabled: false,
  preset: 'none',
  intensity: 0.5,
  animate: true,
  fps_cap: 30,
};

export interface VisualConfig {
  perspective_depth: number; // px, 0 = disabled
  perspective_tilt_x: number; // degrees, X-axis rotation (top/bottom)
  perspective_tilt_y: number; // degrees, Y-axis rotation (left/right)
  opacity: number;           // 0.0–1.0, window backdrop opacity
  blur: number;              // px, window backdrop blur radius
  glow_intensity: number;    // 0.0–3.0, top-line glow brightness boost
  window_border: boolean;    // false = hide the accent outline around windows
  progress_gauge_working: boolean; // false = hide the OSC 9;4 busy ring (spec 364)
}

/** `[keyboard_overlay]` — read-only on-screen keyboard + wireframe hands (spec 271). */
export interface KeyboardOverlayConfig {
  enabled: boolean;              // shown at startup; Leader Shift+K toggles at runtime
  layout: 'auto' | 'us' | 'de' | 'th'; // key labels; auto follows typed script (us ↔ th)
  width_ratio: number;           // keyboard width ÷ workspace width (0.2–0.8); the mouse adds to it
  opacity: number;               // whole-overlay alpha (0.1–1.0)
  mask_secure_input: boolean;    // hide keys at terminal password prompts
  idle_ghost: boolean;           // hands-only demo phrases after 5 s idle
  mouse: boolean;                // draw a mouse; the right hand grips it while you use the pointer
}

export interface ExtensionsConfig {
  enabled: boolean;
  poll_interval_ms: number;
}

/** `[hooks]` — Claude Code hook ingestion only. The loopback HTTP server that
 *  hosts `/hook` (and every browser surface) is `[loopback_server]`, which the
 *  frontend reaches through the `get_hook_server_port` command. */
export interface HooksConfig {
  enabled: boolean;
}

/** One fire look (spec 0363). Unset keys are absent; `inf`/`nan` arrive as `null`. */
export interface FireLookConfig {
  height?: number | null;
  intensity?: number | null;
  speed?: number | null;
  low?: string | null;
  mid?: string | null;
  hot?: string | null;
}

/** `[fire]` — specs 0362/0363: OSC 7501 states that set a window on fire
 *  (empty = off), the shared look, and per-state overrides. */
export interface FireConfig extends FireLookConfig {
  on: string[];
  working?: FireLookConfig | null;
  blocked?: FireLookConfig | null;
  error?: FireLookConfig | null;
  done?: FireLookConfig | null;
}

export interface AcpControllerConfig {
  enabled: boolean;
}

export interface MusicConfig {
  enabled: boolean;
  volume: number;
  directory: string;
  visualizer: boolean;
  visualizer_opacity: number;
}

export interface LaneModelConfig {
  active: string;
  models: string[];
}

export interface RemoteHarnessProfile {
  name: string;
  host: string;
  project_dir: string;
  connect_timeout_seconds: number;
}

export interface AcpHarnessConfig {
  idle_flash_sound: boolean;
  memory_footer: boolean;
  /** spec 252: fading letter afterimage on harness composer insertion. */
  composer_bloom: boolean;
  composer_bloom_ms: number;
  composer_bloom_trail: number;
  /** spec 285: ghost-text word completion in the harness composer. */
  word_autocomplete: boolean;
  /** spec 298: global lane lessons (policy block, lesson_* tools, nudges). */
  lessons: boolean;
  remote_profiles: RemoteHarnessProfile[];
  /** Per-backend model selection. Keyed by backend id (`opencode`,
   * `droid`, `cursor`, `claude`, `codex`, `junie`, `omp`, `grok`, `copilot`,
   * `mimo`, `cline`, `antigravity`, `fx`).
   * Empty `active` means use the adapter default. Junie/OMP/Grok/Copilot/Cline are
   * display-only in v1 (their model-selection paths under native ACP mode are
   * unverified; Copilot's and Cline's ACP servers document no model flag). */
  lane_models: Record<string, LaneModelConfig>;
  /** spec 306: cheap-model turn sidecar. Absent when the TOML omits it. */
  assist?: AcpHarnessAssistConfig;
  /** spec 337: Rails verifier. Absent when the TOML omits it. */
  rails?: AcpHarnessRailsConfig;
}

/** `[acp_harness.assist.tasks.<id>]`. Every generic key is optional and falls
 *  back to `[acp_harness.assist]`; any other scalar key is a task-specific knob
 *  that `resolveAssistConfig` hands to the task as `options`. */
export interface AcpHarnessAssistTaskOverride {
  mode?: string;
  backend?: string;
  model?: string;
  timeout_ms?: number;
  max_input_chars?: number;
  /** Passthrough task options — Krypton never interprets these. */
  [key: string]: string | number | boolean | undefined;
}

/** `[acp_harness.assist]`. Clamps (timeout_ms 1000–20000, max_input_chars
 *  500–20000) are applied in the frontend. `backend` is an ACP backend id and
 *  `model` the id/alias sent with `session/set_model` ('' = backend default). */
export interface AcpHarnessAssistConfig {
  mode?: string;
  backend?: string;
  model?: string;
  timeout_ms?: number;
  max_input_chars?: number;
  tasks?: Record<string, AcpHarnessAssistTaskOverride>;
}

/** `[acp_harness.rails]` (spec 337). Clamps (timeout_ms 10000–180000,
 *  max_input_chars 4000–80000, debounce_ms 1000–60000, min_interval_ms
 *  0–3600000) are applied in the frontend by `resolveRailsConfig`. `mode` is
 *  `off | manual | auto`; auto still needs a trusted `.krypton/rails.toml`. */
export interface AcpHarnessRailsConfig {
  mode?: string;
  backend?: string;
  model?: string;
  timeout_ms?: number;
  max_input_chars?: number;
  debounce_ms?: number;
  /** spec 339: shortest time between auto run starts; `0` = off. */
  min_interval_ms?: number;
}

/** spec 212/213: Xenon resource server. The bearer token is deliberately absent
 *  — it lives in the OS credential vault, never in TOML. */
export interface XenonConfig {
  enabled: boolean;
  base_url: string;
  project: string;
  auto_push: string[];
  /** Backend link-probe cadence in seconds. `0` disables the interval, leaving
   *  the footer segment to update only on `⌘P X` and after a `#push`. */
  probe_interval_secs: number;
}

/** spec 333: `[inline_ai]` — the ACP backend behind the terminal `Cmd+K`
 *  overlay. `model` and `mode` are applied after `session/new`; '' keeps the
 *  backend's own. `context` (spec 334) attaches the pane snapshot.
 *  `follow_up` (spec 335) proposes a fix when an accepted command fails.
 *  `remote_checks` (spec 336) lets an SSH pane's Cmd+K run read-only checks
 *  on that host. */
export interface InlineAiConfig {
  backend: string;
  model: string;
  mode: string;
  context: boolean;
  follow_up: boolean;
  remote_checks: boolean;
}

/** spec 351: `[native_output]` — native cards over command output.
 *  `default_view` is `"native"` or `"raw"`; Rust passes any string through. */
export interface NativeOutputConfig {
  enabled: boolean;
  default_view: string;
}

export interface KryptonConfig {
  shell: ShellConfig;
  font: FontConfig;
  terminal: TerminalConfig;
  theme: ThemeConfig;
  quick_terminal: QuickTerminalConfig;
  workspaces: WorkspacesConfig;
  sound: SoundConfig;
  hints: HintsConfig;
  tabs: TabsConfig;
  shader: ShaderConfig;
  visual: VisualConfig;
  extensions: ExtensionsConfig;
  hooks: HooksConfig;
  fire: FireConfig;
  acp_controller: AcpControllerConfig;
  music: MusicConfig;
  acp_harness: AcpHarnessConfig;
  inline_ai: InlineAiConfig;
  native_output: NativeOutputConfig;
  xenon: XenonConfig;
  keyboard_overlay?: KeyboardOverlayConfig;
  knowledge?: KnowledgeConfig;
}

/** spec 0375/0376: where explainers are stored, their prose language, and the
 *  background ACP job that writes them for the Commit Browser. */
export interface KnowledgeConfig {
  dir: string;
  language: string;
  /** ACP backend id of an explainer job. */
  backend: string;
  /** An id the backend advertises; empty keeps the backend default. */
  model: string;
  /** Agent-side session mode; must sandbox writes to the job's working dir. */
  mode: string;
  /** Jobs that run at once (clamped 1–4 by the runner). */
  parallel: number;
}

/** Load configuration from the Rust backend */
export async function loadConfig(): Promise<KryptonConfig> {
  return invoke<KryptonConfig>('get_config');
}

/** A reusable ACP Harness directive (spec 124). Mirrors the Rust
 * `HarnessDirective` shape in `acp-harness.toml`. */
export interface HarnessDirective {
  id: string;
  title: string;
  icon: string;
  description: string;
  /** Free-form task key (implementation/review/research/...). */
  task: string;
  system_prompt: string;
  enabled: boolean;
  /** Legacy spec-129 metadata. Since spec 130, attention_flag is default-on for
   * every harness-memory-capable lane and this no longer controls tool visibility. */
  triage_equipped: boolean;
}

export interface AcpHarnessUserConfig {
  version: number;
  directives: HarnessDirective[];
}

/** Load the ACP Harness directive config (`~/.config/krypton/acp-harness.toml`),
 * creating an empty default file when missing. */
export async function getAcpHarnessConfig(): Promise<AcpHarnessUserConfig> {
  return invoke<AcpHarnessUserConfig>('get_acp_harness_config');
}

/** Absolute path to `acp-harness.toml`. Surfaced to the `#directive` command so
 * the agent edits the real file (resolving `~` / `XDG_CONFIG_HOME`). */
export async function getAcpHarnessConfigPath(): Promise<string> {
  return invoke<string>('get_acp_harness_config_path');
}
