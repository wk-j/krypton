// Spec 309 — the generative UI catalog renderers.
//
// One directory owns the whole catalog and the single block `acp-genui`: a
// component here is a node renderer, not a harness surface, and 40 of them in
// 40 directories would be registry noise. Group modules carry the renderers,
// this file assembles the registry and imports every sheet (the ownership test
// requires each sheet to be imported by its directory's `index.ts`).

import { COMPONENTS } from '../../genui/catalog';
import { el } from '../../../ui/dom';
import type { ComponentDef } from '../types';
import { CONTENT_RENDERERS } from './content';
import { DATA_RENDERERS } from './data';
import { FORM_RENDERERS } from './form';
import { INPUT_RENDERERS } from './inputs';
import { LAYOUT_RENDERERS } from './layout';
import { BLOCK, GenUiComponent, registerRenderers } from './renderer';
import type { GenUiFactory, GenUiProps } from './renderer';

import './catalog.css';
import './layout.css';
import './content.css';
import './data.css';
import './inputs.css';
import './form.css';

/** Emitted by the interpreter in place of a node whose evaluation failed. */
class ErrorNode extends GenUiComponent {
  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.message];
  }

  protected paint(next: GenUiProps): void {
    const message = next.node.props.message;
    this.el.replaceChildren(el('span', {
      class: `${BLOCK}__error`,
      text: typeof message === 'string' ? message : 'this part could not be rendered',
    }));
  }
}

const INTERNAL_RENDERERS: Readonly<Record<string, GenUiFactory>> = {
  Error: (host) => new ErrorNode(host),
};

registerRenderers(LAYOUT_RENDERERS);
registerRenderers(CONTENT_RENDERERS);
registerRenderers(DATA_RENDERERS);
registerRenderers(INPUT_RENDERERS);
registerRenderers(FORM_RENDERERS);

const RENDERED: Readonly<Record<string, GenUiFactory>> = {
  ...LAYOUT_RENDERERS,
  ...CONTENT_RENDERERS,
  ...DATA_RENDERERS,
  ...INPUT_RENDERERS,
  ...FORM_RENDERERS,
};

/** Every catalog entry that has no renderer in this build. Asserted empty by the test. */
export function missingRenderers(): readonly string[] {
  return COMPONENTS
    .filter((component) => !Object.prototype.hasOwnProperty.call(RENDERED, component.name))
    .map((component) => component.name);
}

export { BLOCK } from './renderer';
export type { GenUiContext, GenUiProps } from './renderer';
export { renderChildren } from './renderer';

export const def: ComponentDef = { id: 'genui-catalog', blocks: [BLOCK] };
