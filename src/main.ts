// Krypton — Application Entry Point
// Initializes the theme engine, compositor, input router, and which-key popup.

import '@xterm/xterm/css/xterm.css';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from './profiler/ipc';
import { Compositor } from './compositor';
import { InputRouter } from './input-router';
import { WhichKey } from './which-key';
import { CommandPalette } from './command-palette';
import { PromptDialog } from './prompt-dialog';
import { QuickFileSearch } from './quick-file-search';
import { QuickOverview } from './quick-overview';
import { loadConfig } from './config';
import { FrontendThemeEngine } from './theme';
import { createGitDashboard } from './dashboards/git';
import { createOpenCodeDashboard } from './dashboards/opencode';
import { createCursorTrail } from './cursor-trail';
import { ClaudeHookManager } from './claude-hooks';
import { NotificationController } from './notification';
import { MusicPlayer } from './music';
import { WorkspaceFooter } from './workspace-footer';
import { BackendLinkProbe } from './backend-link';
import { installGlobalCopyOnSelect } from './copy-on-select';
import { getViewBus } from './view-bus';
import { startPtyBridge } from './pty-bridge';
import { startChromeSignals } from './chrome-signals';
import { startAcpControlBridge } from './acp/control-bridge';

interface CaptureResult {
  path: string;
  data: string;
}

async function main(): Promise<void> {
  const workspace = document.getElementById('krypton-workspace');
  if (!workspace) {
    console.error('Workspace element not found');
    return;
  }

  // Clear any static HTML windows (we'll create them dynamically)
  workspace.innerHTML = '';

  // Initialize theme engine — loads the active theme from backend and
  // sets CSS custom properties. Also starts listening for hot-reload events.
  const themeEngine = new FrontendThemeEngine();
  try {
    const theme = await themeEngine.init();
    console.log('[Krypton] Theme loaded:', theme.meta.display_name);
  } catch (e) {
    console.error('[Krypton] Failed to load theme, using CSS defaults:', e);
  }

  // Load configuration from backend
  let config;
  try {
    config = await loadConfig();
    console.log('[Krypton] Config loaded:', config);
  } catch (e) {
    console.error('[Krypton] Failed to load config, using defaults:', e);
  }

  // Global copy-on-select: any text selection in a DOM view auto-copies to
  // the clipboard. Editable elements and xterm canvases are skipped — the
  // terminal pane keeps its own xterm-side handler. See docs/81-global-copy-on-select.md.
  installGlobalCopyOnSelect();

  // Initialize compositor
  const compositor = new Compositor(workspace);

  // Connect theme engine to compositor (updates terminals on theme change)
  compositor.setThemeEngine(themeEngine);

  // ViewBus — pub/sub channel for cross-view state and intents.
  // Attached *before* applyConfig so the bus catches the first focus/relayout
  // signals emitted while the initial window is created. See docs/105-view-protocol.md.
  const bus = getViewBus();
  compositor.attachToBus(bus);
  startChromeSignals(bus, compositor);
  try {
    await startAcpControlBridge(compositor);
  } catch (e) {
    console.error('[Krypton] Failed to start ACP control bridge:', e);
  }
  try {
    await startPtyBridge(bus, compositor);
  } catch (e) {
    console.error('[Krypton] Failed to start PTY bridge:', e);
  }

  // Apply config if loaded
  if (config) {
    compositor.applyConfig(config);
  }

  // Initialize input router
  const inputRouter = new InputRouter(compositor);

  // Apply hints config if loaded
  if (config) {
    inputRouter.hintController.applyConfig(config.hints);
  }

  // Wire the custom key handler so xterm.js yields control to InputRouter
  compositor.setCustomKeyHandler(inputRouter.customKeyHandler);

  // Initialize command palette
  const commandPalette = new CommandPalette(compositor);
  inputRouter.setCommandPalette(commandPalette);

  // Shared workspace footer: mode/focus/project status plus music segment.
  const workspaceFooter = new WorkspaceFooter({
    workspace,
    compositor,
    inputRouter,
    bus,
  });
  workspaceFooter.start();
  inputRouter.setWorkspaceFooter(workspaceFooter);
  commandPalette.setWorkspaceFooter(workspaceFooter);

  // Initialize smart prompt dialog (Cmd+Shift+K → dispatch prompt to Claude tab)
  const promptDialog = new PromptDialog(compositor, () => inputRouter.exitPromptDialog());
  inputRouter.setPromptDialog(promptDialog);

  // Initialize quick file search (Cmd+O → fff-search-backed picker, copies to clipboard)
  const quickFileSearch = new QuickFileSearch(compositor, () => inputRouter.exitQuickFileSearch());
  inputRouter.setQuickFileSearch(quickFileSearch);

  // Initialize the quick overview dialog (read-only peek modal; first consumer
  // is hint mode's filepath action — see docs/210-quick-overview-dialog.md)
  const quickOverview = new QuickOverview(compositor, () => inputRouter.exitQuickOverview());
  inputRouter.setQuickOverview(quickOverview);

  // Global shortcut events emitted from Rust (Ctrl+Shift+K / Ctrl+Shift+S).
  // These fire even when Krypton is not focused.
  void listen('capture-requested', () => {
    if (compositor.getFocusedContentType() !== 'acp_harness') {
      void promptDialog.captureAndStage();
      return;
    }
    void (async (): Promise<void> => {
      try {
        const result = await invoke<CaptureResult | null>('capture_screen');
        if (result === null) return;
        compositor.stageCapturedImageOnFocusedContent({
          path: result.path,
          data: result.data,
          mimeType: 'image/png',
        });
      } catch (e) {
        console.error('[Krypton] capture_screen failed:', e);
      }
    })();
  });
  void listen('prompt-dialog-requested', async () => {
    if (promptDialog.isVisible) {
      promptDialog.close();
    } else {
      await getCurrentWindow().setFocus();
      inputRouter.enterPromptDialog();
    }
  });

  // Initialize dashboard manager and register built-in dashboards
  const dashboardManager = compositor.dashboardManager;
  inputRouter.setDashboardManager(dashboardManager);
  dashboardManager.register(createGitDashboard(compositor));
  dashboardManager.register(createOpenCodeDashboard(compositor));

  // Initialize music player
  const musicPlayer = new MusicPlayer();
  musicPlayer.setWorkspaceFooter(workspaceFooter);
  await musicPlayer.init(workspace, compositor);
  dashboardManager.register(musicPlayer.createDashboard());
  inputRouter.setMusicPlayer(musicPlayer);

  // Apply music config if loaded
  if (config?.music) {
    musicPlayer.applyConfig(config.music);
  }

  // spec 213: backend link indicator — a periodic authenticated probe of the
  // Xenon server, published to the ViewBus for the workspace footer. Without
  // it a dead server, a revoked token, and a healthy link are indistinguishable
  // until a `#push` fails.
  const backendLink = new BackendLinkProbe(bus);
  backendLink.setIntervalSecs(config?.xenon?.probe_interval_secs ?? 60);
  inputRouter.setBackendLinkProbe(backendLink);
  void backendLink.start();

  // Re-apply music config on hot-reload
  compositor.onConfigReload((newConfig) => {
    if (newConfig.music) {
      musicPlayer.applyConfig(newConfig.music);
    }
    backendLink.setIntervalSecs(newConfig.xenon?.probe_interval_secs ?? 60);
    // `[xenon].enabled` / `base_url` are read per-probe in Rust, so one probe
    // now is all a hot-reload needs to reflect a config change in the footer.
    void backendLink.probeNow();
  });

  // Initialize which-key popup (shows available keys per mode)
  const whichKey = new WhichKey();
  inputRouter.onModeChange((mode, contentType, leaderKeys) => {
    whichKey.setMode(mode, contentType, leaderKeys);
  });

  // Initialize notification overlay (bottom-right, OSC-aware)
  const notifications = new NotificationController();
  compositor.setNotificationController(notifications);

  // Surface unhandled promise rejections and uncaught errors as visible notifications
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? 'Unknown error');
    notifications.error(msg, { label: 'ERROR' });
  });
  window.addEventListener('error', (e) => {
    notifications.error(e.message || 'Unknown error', { label: 'ERROR' });
  });

  // Initialize Claude Code hook integration
  const claudeHooks = new ClaudeHookManager();
  claudeHooks.setNotificationController(notifications);
  compositor.setClaudeHookManager(claudeHooks);
  claudeHooks.init().catch((e) => {
    console.warn('[Krypton] Claude hook integration unavailable:', e);
  });

  // Create the first terminal window
  await compositor.createWindow();

  // Initialize cursor trail (rainbow flame effect on mouse + text cursor).
  // Disabled via [terminal] cursor_trail = false; hot-reload toggles it live.
  const cursorTrail = createCursorTrail();
  cursorTrail.setCompositor(compositor);
  if (config?.terminal.cursor_trail !== false) {
    cursorTrail.init();
  }
  compositor.onConfigReload((newConfig) => {
    cursorTrail.setEnabled(newConfig.terminal.cursor_trail);
  });

  // Play startup sound after first window is ready
  compositor.soundEngine.play('startup');

  // Diagnostic logging — remove after root cause is identified
  compositor.soundEngine.startDiagnostics();
}

main().catch(console.error);
