import { bootPage } from '../app';
import { ToolsView } from '../surfaces/tools';

bootPage('tools', async ({ main }) => {
  const view = new ToolsView();
  main.replaceChildren(view.el);
  await view.load();
});
