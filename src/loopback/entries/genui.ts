import { bootPage } from '../app';
import { GenuiGallery } from '../surfaces/genui';

bootPage('genui', async ({ shell, main }) => {
  const gallery = new GenuiGallery(shell);
  main.replaceChildren(gallery.el);
  await gallery.start();
});
