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
import { loadConfig } from './config';
import { FrontendThemeEngine } from './theme';
import { createGitDashboard } from './dashboards/git';
import { createOpenCodeDashboard } from './dashboards/opencode';
import { createCursorTrail } from './cursor-trail';
import { ClaudeHookManager } from './claude-hooks';
import { NotificationController } from './notification';
import { MusicPlayer } from './music';
import { installGlobalCopyOnSelect } from './copy-on-select';

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

  // Initialize smart prompt dialog (Cmd+Shift+K → dispatch prompt to Claude tab)
  const promptDialog = new PromptDialog(compositor, () => inputRouter.exitPromptDialog());
  inputRouter.setPromptDialog(promptDialog);

  // Initialize quick file search (Cmd+O → fff-search-backed picker, copies to clipboard)
  const quickFileSearch = new QuickFileSearch(compositor, () => inputRouter.exitQuickFileSearch());
  inputRouter.setQuickFileSearch(quickFileSearch);

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
  await musicPlayer.init(workspace, compositor);
  dashboardManager.register(musicPlayer.createDashboard());
  inputRouter.setMusicPlayer(musicPlayer);

  // Apply music config if loaded
  if (config?.music) {
    musicPlayer.applyConfig(config.music);
  }

  // Re-apply music config on hot-reload
  compositor.onConfigReload((newConfig) => {
    if (newConfig.music) {
      musicPlayer.applyConfig(newConfig.music);
    }
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

  // Initialize cursor trail (rainbow flame effect on mouse + text cursor)
  const cursorTrail = createCursorTrail();
  cursorTrail.setCompositor(compositor);
  cursorTrail.init();

  // Play startup sound after first window is ready
  compositor.soundEngine.play('startup');

  // Show startup toast for testing (no hook setup required)
  claudeHooks.toast('Krypton initialized', 'notification');

  // Diagnostic logging — remove after root cause is identified
  compositor.soundEngine.startDiagnostics();
}

main().catch(console.error);
