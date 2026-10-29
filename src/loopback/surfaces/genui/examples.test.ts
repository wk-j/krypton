import { describe, expect, it } from 'vitest';

import { COMPONENTS } from '../../../acp/genui/catalog';
import { compile } from '../../../acp/genui/compile';
import { evaluate, initialState } from '../../../acp/genui/evaluate';
import type { UiNode, Value } from '../../../acp/genui/types';
import { isList, isNode } from '../../../acp/genui/types';
import { EXAMPLES } from './examples';

function containsComponent(value: Value, name: string): boolean {
  if (isNode(value)) {
    return value.component === name || Object.values(value.props).some((prop) => containsComponent(prop, name));
  }
  if (isList(value)) return value.some((item) => containsComponent(item, name));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => containsComponent(item, name));
  }
  return false;
}

describe('GenUI gallery examples', () => {
  it('covers every shipped component exactly once with a valid live example', () => {
    expect(EXAMPLES.map((example) => example.component).sort())
      .toEqual(COMPONENTS.map((component) => component.name).sort());

    for (const example of EXAMPLES) {
      const { program, diagnostics } = compile(`version 2\n${example.source}`);
      expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), example.component).toEqual([]);
      expect(program, example.component).not.toBeNull();
      if (program === null) continue;
      const result = evaluate(program, initialState(program));
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), example.component).toEqual([]);
      expect(result.roots.some((root: UiNode) => containsComponent(root, example.component)), example.component).toBe(true);
    }
  });
});
