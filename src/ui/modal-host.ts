/** Place an app-level modal in the focused DOM window, or in the source view's window. */
export function mountModalInActiveWindow(modal: HTMLElement, source?: HTMLElement): void {
  const window = source?.closest<HTMLElement>('.krypton-window')
    ?? document.querySelector<HTMLElement>('.krypton-window--focused');
  (window ?? document.body).appendChild(modal);
}
