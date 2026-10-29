// Spec 313 — one example's live preview: the production compiler, evaluator and
// catalog renderer, with local input state and demo-only action feedback.

import type { Program } from '../../../acp/genui/ast';
import { compile } from '../../../acp/genui/compile';
import { evaluate, initialState } from '../../../acp/genui/evaluate';
import type { UiAction, UiState, UiStateValue } from '../../../acp/genui/types';
import { toStateValue } from '../../../acp/genui/types';
import { renderChildren } from '../../../acp/components/genui-catalog';
import type { GenUiContext } from '../../../acp/components/genui-catalog';
import { disposeList } from '../../../ui/list';
import { copyText } from '../../kit';

export class GalleryPreview {
  private program: Program | null | undefined;
  private state: UiState = {};
  private readonly views = new Map<string, Record<string, unknown>>();
  private mounted = false;
  private readonly context: GenUiContext;

  constructor(
    private readonly source: string,
    private readonly host: HTMLElement,
    private readonly status: HTMLElement,
  ) {
    const preview = this;
    this.context = {
      run: (actions: readonly UiAction[]): void => this.run(actions),
      setInput: (name: string, value: UiStateValue): void => this.setInput(name, value),
      get state(): UiState { return preview.state; },
      view: (key: string): Record<string, unknown> => this.view(key),
      repaint: (): void => this.render(),
    };
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    if (this.program === undefined) {
      const result = compile(`version 2\n${this.source}`);
      this.program = result.program;
      if (result.program === null) {
        this.status.textContent = result.diagnostics.map((diagnostic) => `line ${diagnostic.line}: ${diagnostic.message}`).join(' · ');
        return;
      }
      this.state = initialState(result.program);
    }
    this.render();
  }

  /** Tear the rendered components down; the example's input and view state survive. */
  dispose(): void {
    if (!this.mounted) return;
    this.mounted = false;
    disposeList(this.host);
  }

  reset(): void {
    if (this.program === null || this.program === undefined) return;
    this.state = initialState(this.program);
    this.views.clear();
    this.status.textContent = '';
    if (this.mounted) {
      disposeList(this.host);
      this.render();
    }
  }

  private render(): void {
    if (!this.mounted || this.program === null || this.program === undefined) return;
    const result = evaluate(this.program, this.state);
    renderChildren(this.host, result.roots, this.context);
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (error !== undefined) this.status.textContent = `line ${error.line}: ${error.message}`;
  }

  private setInput(name: string, value: UiStateValue): void {
    if (!Object.prototype.hasOwnProperty.call(this.state, name)) return;
    this.state[name] = value;
    this.render();
  }

  private view(key: string): Record<string, unknown> {
    let value = this.views.get(key);
    if (value === undefined) {
      value = {};
      this.views.set(key, value);
    }
    return value;
  }

  private run(actions: readonly UiAction[]): void {
    for (const action of actions) {
      if (action.type === 'set' && action.name !== undefined) {
        this.setInput(action.name, toStateValue(action.value ?? null) ?? null);
      } else if (action.type === 'copy') {
        void copyText(action.text ?? '').then((ok) => {
          this.status.textContent = ok ? 'Copied' : 'Copy failed';
        });
      } else if (action.type === 'draft') {
        this.status.textContent = `Demo only · draft: ${action.text ?? ''}`;
      } else if (action.type === 'openUrl') {
        this.status.textContent = `Demo only · link: ${action.text ?? ''}`;
      }
    }
  }
}
