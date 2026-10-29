import { bootPage } from '../app';
import { HomeView } from '../surfaces/home';

bootPage('home', ({ shell, main }) => {
  main.replaceChildren(new HomeView(shell).el);
});
