import { bootPage } from '../app';
import { TermctrlView, tokenFromPath } from '../surfaces/termctrl';

bootPage('termctrl', ({ main }) => {
  main.replaceChildren(new TermctrlView(tokenFromPath(location.pathname)).el);
});
