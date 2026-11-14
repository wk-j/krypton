import { bootPage } from '../app';
import { TrailPage } from '../surfaces/trail';

// Spec 400: `/trail?project=<id>` is the project's trail index (the Home
// tile); with `&issue=<owner/repo/n>` it is that issue's trail.
bootPage('trail', TrailPage);
