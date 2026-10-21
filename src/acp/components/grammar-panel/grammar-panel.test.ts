import { describe, expect, it } from 'vitest';

import { GrammarPanel, type GrammarPanelProps } from './index';

const FIXES: GrammarPanelProps = {
  laneName: 'claude-1',
  state: {
    kind: 'ready',
    taskId: 'grammar',
    original: 'What curent changes in git?',
    check: { corrected: 'What are the current changes in git?', fixes: ['curent → current', 'What → What are'] },
  },
};

function text(panel: GrammarPanel, cls: string): string[] {
  return [...panel.el.querySelectorAll(`.acp-harness__grammar-${cls}`)].map((node) => node.textContent ?? '');
}

describe('GrammarPanel', () => {
  it('paints the fixes, the corrected prompt and the keys', () => {
    const panel = new GrammarPanel();
    panel.update(FIXES);
    expect(panel.el.dataset.phase).toBe('fixes');
    expect(text(panel, 'name')).toEqual(['claude-1']);
    expect(text(panel, 'label')).toEqual(['grammar · 2 fixes']);
    expect(text(panel, 'fix')).toEqual(['curent → current', 'What → What are']);
    expect(text(panel, 'corrected')).toEqual(['What are the current changes in git?']);
    expect(text(panel, 'hint')).toEqual(['cmd+g use · cmd+0 dismiss']);
  });

  it('shows the checked prompt while pending', () => {
    const panel = new GrammarPanel();
    panel.update({ laneName: 'claude-1', state: { kind: 'pending', taskId: 'grammar', original: 'fix it now' } });
    expect(panel.el.dataset.phase).toBe('pending');
    expect(text(panel, 'label')).toEqual(['grammar · checking']);
    expect(text(panel, 'original')).toEqual(['fix it now']);
  });

  it('confirms a clean prompt', () => {
    const panel = new GrammarPanel();
    panel.update({ ...FIXES, state: { ...FIXES.state, kind: 'ready', check: { corrected: null, fixes: [] } } as GrammarPanelProps['state'] });
    expect(panel.el.dataset.phase).toBe('ok');
    expect(text(panel, 'label')).toEqual(['grammar · ok']);
    expect(text(panel, 'ok')).toEqual(['✓ no grammar issues']);
  });

  it('does not repaint an unchanged review', () => {
    const panel = new GrammarPanel();
    panel.update(FIXES);
    const body = panel.el.querySelector('.acp-harness__grammar-corrected');
    panel.update({ ...FIXES });
    expect(panel.el.querySelector('.acp-harness__grammar-corrected')).toBe(body);
  });
});

describe('GrammarPanel — colour hooks', () => {
  it('splits each fix into wrong / right spans and the keys into kbd chips', () => {
    const panel = new GrammarPanel();
    panel.update(FIXES);
    expect(text(panel, 'wrong')).toEqual(['curent', 'What']);
    expect(text(panel, 'right')).toEqual(['current', 'What are']);
    expect(text(panel, 'key')).toEqual(['cmd+g', 'cmd+0']);
  });
});
