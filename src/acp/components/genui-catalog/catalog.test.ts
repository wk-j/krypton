import { describe, expect, it } from 'vitest';

import { COMPONENTS, COMPONENT_BY_NAME, componentSignature, tableHas } from '../../genui/catalog';
import { missingRenderers } from './index';

describe('genui catalog', () => {
  it('has a renderer for every catalog entry', () => {
    expect(missingRenderers()).toEqual([]);
  });

  it('names every component once and reaches it by name', () => {
    const names = COMPONENTS.map((component) => component.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(tableHas(COMPONENT_BY_NAME, name)).toBe(true);
    expect(tableHas(COMPONENT_BY_NAME, 'constructor')).toBe(false);
  });

  it('prints a signature a model can copy, with required params before optional ones', () => {
    for (const component of COMPONENTS) {
      const signature = componentSignature(component);
      const names = component.params.map((param) => (param.kind === 'binding' ? `$${param.name}` : param.name));
      for (const name of names) expect(signature).toContain(name);
      const required = component.params.map((param) => param.required === true);
      expect(required).toEqual([...required].sort((a, b) => Number(b) - Number(a)));
    }
  });

  it('declares exactly one binding on an input, with a holds kind', () => {
    for (const component of COMPONENTS) {
      const bindings = component.params.filter((param) => param.kind === 'binding');
      if (component.group !== 'Inputs') {
        expect(bindings).toHaveLength(0);
        continue;
      }
      if (component.name === 'Button') continue;
      expect(bindings).toHaveLength(1);
      expect(bindings[0].holds).toBeDefined();
    }
  });
});
