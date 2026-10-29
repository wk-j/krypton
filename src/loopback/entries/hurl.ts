import { bootPage } from '../app';
import { HurlView, hurlToken } from '../surfaces/hurl';

bootPage('hurl', async ({ main }) => {
  const view = new HurlView(hurlToken(location.pathname));
  main.replaceChildren(view.el);
  await view.start();
});
