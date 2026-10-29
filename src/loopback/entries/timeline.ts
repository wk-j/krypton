import { bootPage } from '../app';
import { TimelineView } from '../surfaces/timeline';

bootPage('timeline', ({ main }) => {
  const params = new URLSearchParams(location.search);
  const view = new TimelineView(params.get('harness') ?? '', params);
  main.replaceChildren(view.el);
  view.start();
});
