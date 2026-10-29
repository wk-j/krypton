import { bootPage } from '../app';
import { E2eView } from '../surfaces/e2e';

bootPage('e2e', ({ shell, main }) => {
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
  main.replaceChildren(new E2eView({ token, setTitle: (title) => shell.setTitle(title) }).el);
});
