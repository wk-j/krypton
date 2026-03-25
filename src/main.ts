// Krypton — Application Entry Point
// Initializes the theme engine, compositor, input router, and which-key popup.

import '@xterm/xterm/css/xterm.css';
import { Compositor } from './compositor';
import { InputRouter } from './input-router';
import { WhichKey } from './which-key';
import { CommandPalette } from './command-palette';
import { loadConfig, KryptonConfig } from './config';
import { listen } from '@tauri-apps/api/event';
import { FrontendThemeEngine } from './theme';
import { createGitDashboard } from './dashboards/git';
import { createOpenCodeDashboard } from './dashboards/opencode';
import { CursorTrail } from './cursor-trail';
import { ClaudeHookManager } from './claude-hooks';
import { NotificationController } from './notification';

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

  // Initialize dashboard manager and register built-in dashboards
  const dashboardManager = compositor.dashboardManager;
  inputRouter.setDashboardManager(dashboardManager);
  dashboardManager.register(createGitDashboard(compositor));
  dashboardManager.register(createOpenCodeDashboard(compositor));

  // Initialize which-key popup (shows available keys per mode)
  const whichKey = new WhichKey();
  inputRouter.onModeChange((mode, contentType) => {
    whichKey.setMode(mode, contentType);
  });

  // Initialize notification overlay (bottom-right, OSC-aware)
  const notifications = new NotificationController();
  compositor.setNotificationController(notifications);

  // Initialize Claude Code hook integration
  const claudeHooks = new ClaudeHookManager();
  claudeHooks.setNotificationController(notifications);
  compositor.setClaudeHookManager(claudeHooks);
  claudeHooks.init().catch((e) => {
    console.warn('[Krypton] Claude hook integration unavailable:', e);
  });

  // Listen for config hot-reload events from backend
  await listen<KryptonConfig>('config-changed', (event) => {
    console.log('[Krypton] Config hot-reload received');
    compositor.applyConfig(event.payload);
    inputRouter.hintController.applyConfig(event.payload.hints);
  });

  // Create the first terminal window
  await compositor.createWindow();

  // Initialize cursor trail (rainbow flame effect on mouse + text cursor)
  const cursorTrail = new CursorTrail();
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
