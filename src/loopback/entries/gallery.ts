import { bootPage } from '../app';
import { GalleryView } from '../surfaces/gallery';

bootPage('gallery', ({ shell, main }) => {
  main.replaceChildren(new GalleryView(shell).el);
});
