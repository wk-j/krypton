import { bootPage } from '../app';
import { DashboardView } from '../surfaces/dashboard';

bootPage('dashboard', ({ main }) => {
  main.replaceChildren(new DashboardView().el);
});
