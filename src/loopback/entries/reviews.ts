import { bootPage } from '../app';
import { mountReviews } from '../surfaces/reviews';

bootPage('reviews', ({ shell, main }) => {
  mountReviews(shell, main);
});
