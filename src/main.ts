// Krypton — Application Entry Point
// Initializes the compositor, input router, and which-key popup.

import '@xterm/xterm/css/xterm.css';
import { Compositor } from './compositor';
import { InputRouter } from './input-router';
import { WhichKey } from './which-key';

async function main(): Promise<void> {
  const workspace = document.getElementById('krypton-workspace');
  if (!workspace) {
    console.error('Workspace element not found');
    return;
  }

  // Clear any static HTML windows (we'll create them dynamically)
  workspace.innerHTML = '';

  // Initialize compositor
  const compositor = new Compositor(workspace);

  // Initialize input router
  const inputRouter = new InputRouter(compositor);

  // Wire the custom key handler so xterm.js yields control to InputRouter
  compositor.setCustomKeyHandler(inputRouter.customKeyHandler);

  // Initialize which-key popup (shows available keys per mode)
  const whichKey = new WhichKey();
  inputRouter.onModeChange((mode) => {
    whichKey.setMode(mode);
  });

  // Create the first terminal window
  await compositor.createWindow();
}

main().catch(console.error);
