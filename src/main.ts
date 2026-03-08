// Krypton — Application Entry Point
// Initializes the theme engine, compositor, input router, and which-key popup.

import '@xterm/xterm/css/xterm.css';
import { Compositor } from './compositor';
import { InputRouter } from './input-router';
import { WhichKey } from './which-key';
import { loadConfig } from './config';
import { FrontendThemeEngine } from './theme';

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

  // Initialize which-key popup (shows available keys per mode)
  const whichKey = new WhichKey();
  inputRouter.onModeChange((mode) => {
    whichKey.setMode(mode);
  });

  // Create the first terminal window
  await compositor.createWindow();

  // Play startup sound after first window is ready
  compositor.soundEngine.play('startup');
}

main().catch(console.error);
