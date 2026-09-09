import { describe, expect, it } from 'vitest';

import { BACKEND_LOGO_SVG_DEFS } from './acp/harness-icons';
import {
  CODEX_LOGO_MARK,
  GROK_LOGO_MARK,
  codeAgentLogoSvg,
  codeAgentLogoSymbol,
} from './code-agent-logos';

describe('official code-agent logo marks', () => {
  it('uses the official OpenAI blossom for every Codex symbol reference', () => {
    expect(CODEX_LOGO_MARK.viewBox).toBe('118.5 118.5 484 484');
    expect(CODEX_LOGO_MARK.body).toContain('M304.246 295.411V249.828');
    expect(BACKEND_LOGO_SVG_DEFS).toContain(
      codeAgentLogoSymbol(CODEX_LOGO_MARK, 'krypton-logo-codex'),
    );
    expect(BACKEND_LOGO_SVG_DEFS).not.toContain(
      '<symbol id="krypton-logo-codex" viewBox="0 0 16 16"><polygon',
    );
  });

  it('uses the official Grok foreground mark instead of the placeholder bolt', () => {
    expect(GROK_LOGO_MARK.viewBox).toBe('56 56 400 400');
    expect(GROK_LOGO_MARK.body).toContain('M210.484 312.759L343.465 210.383');
    expect(BACKEND_LOGO_SVG_DEFS).toContain(
      codeAgentLogoSymbol(GROK_LOGO_MARK, 'krypton-logo-grok'),
    );
    expect(BACKEND_LOGO_SVG_DEFS).not.toContain('M9.2 1.5 L3.8 8.8');
  });

  it('fits official marks into the 16×16 slot the footer and rail already use', () => {
    expect(codeAgentLogoSymbol(GROK_LOGO_MARK, 'krypton-logo-grok')).toBe(
      `<symbol id="krypton-logo-grok" viewBox="0 0 16 16">` +
        `<g transform="translate(0 0) scale(0.04) translate(-56 -56)">${GROK_LOGO_MARK.body}</g>` +
        `</symbol>`,
    );
    expect(BACKEND_LOGO_SVG_DEFS).toContain('id="krypton-logo-grok" viewBox="0 0 16 16"');
    expect(BACKEND_LOGO_SVG_DEFS).toContain('id="krypton-logo-codex" viewBox="0 0 16 16"');
    expect(BACKEND_LOGO_SVG_DEFS).toContain('scale(0.04) translate(-56 -56)');
    expect(BACKEND_LOGO_SVG_DEFS).not.toContain('viewBox="0 0 512 512"');
    expect(BACKEND_LOGO_SVG_DEFS).not.toContain('viewBox="0 0 721 721"');
  });

  it('wraps shared geometry without changing its ink viewBox or paths', () => {
    expect(codeAgentLogoSvg(CODEX_LOGO_MARK, 'logo')).toBe(
      `<svg class="logo" viewBox="${CODEX_LOGO_MARK.viewBox}" aria-hidden="true">${CODEX_LOGO_MARK.body}</svg>`,
    );
    expect(codeAgentLogoSvg(GROK_LOGO_MARK, 'logo')).toBe(
      `<svg class="logo" viewBox="${GROK_LOGO_MARK.viewBox}" aria-hidden="true">${GROK_LOGO_MARK.body}</svg>`,
    );
  });
});
