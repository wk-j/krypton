import { describe, expect, it } from 'vitest';

import { BACKEND_LOGO_SVG_DEFS } from './acp/harness-icons';
import { CODEX_LOGO_MARK, GROK_LOGO_MARK, codeAgentLogoSvg } from './code-agent-logos';

describe('official code-agent logo marks', () => {
  it('uses the official OpenAI blossom for every Codex symbol reference', () => {
    expect(CODEX_LOGO_MARK.viewBox).toBe('0 0 721 721');
    expect(CODEX_LOGO_MARK.body).toContain('M304.246 295.411V249.828');
    expect(BACKEND_LOGO_SVG_DEFS).toContain(
      `<symbol id="krypton-logo-codex" viewBox="${CODEX_LOGO_MARK.viewBox}">${CODEX_LOGO_MARK.body}</symbol>`,
    );
    expect(BACKEND_LOGO_SVG_DEFS).not.toContain(
      '<symbol id="krypton-logo-codex" viewBox="0 0 16 16"><polygon',
    );
  });

  it('uses the official Grok foreground mark instead of the placeholder bolt', () => {
    expect(GROK_LOGO_MARK.viewBox).toBe('0 0 512 512');
    expect(GROK_LOGO_MARK.body).toContain('M210.484 312.759L343.465 210.383');
    expect(BACKEND_LOGO_SVG_DEFS).toContain(
      `<symbol id="krypton-logo-grok" viewBox="${GROK_LOGO_MARK.viewBox}">${GROK_LOGO_MARK.body}</symbol>`,
    );
    expect(BACKEND_LOGO_SVG_DEFS).not.toContain('M9.2 1.5 L3.8 8.8');
  });

  it('wraps shared geometry without changing its source viewBox or paths', () => {
    expect(codeAgentLogoSvg(CODEX_LOGO_MARK, 'logo')).toBe(
      `<svg class="logo" viewBox="${CODEX_LOGO_MARK.viewBox}" aria-hidden="true">${CODEX_LOGO_MARK.body}</svg>`,
    );
    expect(codeAgentLogoSvg(GROK_LOGO_MARK, 'logo')).toBe(
      `<svg class="logo" viewBox="${GROK_LOGO_MARK.viewBox}" aria-hidden="true">${GROK_LOGO_MARK.body}</svg>`,
    );
  });
});
