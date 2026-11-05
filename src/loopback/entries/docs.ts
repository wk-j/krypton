import { bootPage } from '../app';
import { DocsPage } from '../surfaces/docs';

// `/journal` and `/doc` share this entry; the journal index is its own surface.
bootPage(location.pathname === '/journal' ? 'journal' : 'docs', DocsPage);
