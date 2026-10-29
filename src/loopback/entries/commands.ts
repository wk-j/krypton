import { bootPage } from '../app';
import { CommandsView } from '../surfaces/commands';

bootPage('commands', async ({ main }) => {
  const view = new CommandsView();
  main.replaceChildren(view.el);
  await view.load();
});
