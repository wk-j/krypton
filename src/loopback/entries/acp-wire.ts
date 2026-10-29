import { bootPage } from '../app';
import { AcpWireView } from '../surfaces/acp-wire';

bootPage('acp-wire', ({ shell, main }) => {
  main.replaceChildren(new AcpWireView(shell).el);
});
