import { bootPage } from '../app';
import { mountAnalyses } from '../surfaces/analyses';

bootPage('analyses', ({ shell, main }) => {
  mountAnalyses(shell, main);
});
