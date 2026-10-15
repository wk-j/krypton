import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HARNESS_COMPONENTS } from './registry';

// Spec 301 §UI changes and style ownership.
//
// A component directory is a self-contained unit you can add or delete in one
// move. That only holds if its stylesheet declares selectors for the blocks
// that directory owns and nothing else — otherwise deleting the directory
// leaves orphan rules behind, and restyling one component silently restyles
// another (the collision the review card, the four palettes and the forked
// caret all were).

const COMPONENTS_DIR = join(import.meta.dirname, '.');

/**
 * Classes composed at runtime, which a static read cannot attribute to a
 * directory: markdown output comes from `md.parse`/`smd` (the parser names
 * those classes, not us), and modifiers like `acp-harness__lane--${status}` or
 * `acp-harness__msg--${kind}` are built from state.
 */
const SHARED_PREFIXES = ['hljs', 'language-', 'mermaid', 'katex'];

/**
 * Does `cls` belong to `block`?
 *
 * BEM ownership splits on `__` and `--`. The `-` suffix form is allowed only
 * when the block is already element-level (`acp-harness__tool` owning
 * `acp-harness__tool-head`); at top level it would let `acp-ticket` claim
 * `acp-ticket-dock__pill`, which is a different component.
 */
function ownsClass(block: string, cls: string): boolean {
  if (cls === block) return true;
  if (cls.startsWith(`${block}__`) || cls.startsWith(`${block}--`)) return true;
  return block.includes('__') && cls.startsWith(`${block}-`);
}

/** Selector text only: comments and declaration bodies removed. */
function selectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const match of withoutComments.matchAll(/(^|[}{;])([^{}};]*?)\{/g)) {
    const head = match[2].trim();
    if (!head || head.startsWith('@')) continue;
    for (const part of head.split(',')) {
      const selector = part.trim();
      if (selector) out.push(selector);
    }
  }
  return out;
}

function classesIn(selector: string): string[] {
  return [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((match) => match[1]);
}

function layerBlocks(css: string): string[] {
  return [...css.matchAll(/@layer\s+([\w.]+)\s*\{/g)].map((match) => match[1]);
}

interface Sheet {
  readonly dir: string;
  readonly file: string;
  readonly css: string;
}

function componentSheets(): Sheet[] {
  const out: Sheet[] = [];
  for (const dir of readdirSync(COMPONENTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(COMPONENTS_DIR, dir.name);
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.css')) continue;
      out.push({ dir: dir.name, file, css: readFileSync(join(dirPath, file), 'utf8') });
    }
  }
  return out;
}

describe('component style ownership', () => {
  const sheets = componentSheets();

  it('finds component stylesheets to check', () => {
    expect(sheets.length).toBeGreaterThan(10);
  });

  it('registers every directory that ships a stylesheet', () => {
    const registered = new Set(HARNESS_COMPONENTS.map((def) => def.id));
    const unregistered = [...new Set(sheets.map((sheet) => sheet.dir))].filter(
      (dir) => !registered.has(dir),
    );
    expect(unregistered).toEqual([]);
  });

  it('declares every rule inside a krypton.* layer', () => {
    const offenders: string[] = [];
    for (const sheet of sheets) {
      const layers = layerBlocks(sheet.css);
      if (layers.length === 0) {
        offenders.push(`${sheet.dir}/${sheet.file}: no @layer block`);
        continue;
      }
      for (const layer of layers) {
        if (!layer.startsWith('krypton.')) offenders.push(`${sheet.dir}/${sheet.file}: @layer ${layer}`);
      }
      // Anything outside a layer block outranks every layered rule in the same
      // origin (CSS Cascade 5), which would silently defeat the carve-out.
      const outsideLayers = sheet.css.replace(/@layer\s+[\w.]+\s*\{[\s\S]*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/[^\s]/.test(outsideLayers.replace(/@layer[^;]*;/g, ''))) {
        offenders.push(`${sheet.dir}/${sheet.file}: rules outside a layer`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gates every rule on a block its directory owns', () => {
    const blocksByDir = new Map(HARNESS_COMPONENTS.map((def) => [def.id, def.blocks]));
    const offenders: string[] = [];
    for (const sheet of sheets) {
      const owned = blocksByDir.get(sheet.dir) ?? [];
      for (const selector of selectors(sheet.css)) {
        const classes = classesIn(selector);
        if (classes.length === 0) continue;
        if (classes.every((cls) => SHARED_PREFIXES.some((prefix) => cls.startsWith(prefix)))) continue;
        // A rule may name another component's block — as an ancestor that
        // scopes it, or as the subject it modifies in this component's
        // context. What it may NOT do is apply with no owned class in play:
        // such a rule would outlive the directory's deletion.
        if (classes.some((cls) => owned.some((block) => ownsClass(block, cls)))) continue;
        offenders.push(`${sheet.dir}/${sheet.file}: ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps a stylesheet next to the component that imports it', () => {
    const missingImport: string[] = [];
    for (const sheet of sheets) {
      const index = join(COMPONENTS_DIR, sheet.dir, 'index.ts');
      if (!existsSync(index)) {
        missingImport.push(`${sheet.dir}: no index.ts`);
        continue;
      }
      const src = readFileSync(index, 'utf8');
      if (!src.includes(`'./${sheet.file}'`)) missingImport.push(`${sheet.dir}/${sheet.file}`);
    }
    expect(missingImport).toEqual([]);
  });

  // Regression: an unlayered `* { padding: 0 }` in base.css outranked every
  // `@layer krypton.component` rule in the app and silently zeroed the padding
  // and margin of all 54 component sheets at once. Layer membership beats
  // specificity, so a 0-specificity selector is the worst offender: it looks
  // harmless and wins everything. base.css moved into `@layer krypton.reset`.
  it('leaves no unlayered zero-specificity rule in the main window stylesheets', () => {
    const stylesDir = join(COMPONENTS_DIR, '../../styles');
    const index = readFileSync(join(stylesDir, 'index.css'), 'utf8');
    const imported = [...index.matchAll(/@import\s+'\.\/([\w.-]+\.css)'/g)].map((m) => m[1]);
    expect(imported.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of imported) {
      const css = readFileSync(join(stylesDir, file), 'utf8');
      // Rules inside a layer are safe; strip every layer block before looking.
      const unlayered = css.replace(/@layer\s+[\w.]+\s*\{[\s\S]*\}/g, '');
      for (const selector of selectors(unlayered)) {
        // `@keyframes` steps read as selectors but target nothing.
        if (/^(from|to|-?\d+(\.\d+)?%)$/.test(selector)) continue;
        // A pseudo-ELEMENT adds no class-level specificity, so `*::before` is
        // just as dangerous as `*`; a pseudo-CLASS does, so it stays.
        const parts = selector.replace(/::[\w-]+/g, '').split(/\s|>|\+|~/).filter(Boolean);
        if (parts.some((part) => /[.#[:]/.test(part))) continue;
        offenders.push(`${file}: ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Regression: `OverlayShell` hides a shell with the `hidden` ATTRIBUTE, both
  // when its owner closes it and when another shell claims the single open
  // slot. The UA's `[hidden] { display: none }` has lower precedence than any
  // author `display:`, so a shell whose sheet sets `display: grid` stays on
  // screen while the component believes it is closed. The inline palettes shipped
  // with exactly that bug: four empty bordered bars above the composer input.
  it('lets every overlay root be hidden by its own stylesheet', () => {
    // An overlay root is recognised from the CSS rather than from the TS, which
    // passes its class as a template literal: it is the rule that covers the
    // view (`position: absolute|fixed` + `inset: 0`) and gives itself a layout
    // `display`. That is exactly the shape that defeats `[hidden]`.
    const offenders: string[] = [];
    for (const sheet of sheets) {
      for (const m of sheet.css.matchAll(/(?<=^|[}{;])\s*\.([\w-]+)\s*\{([^{}]*)\}/g)) {
        const [, root, body] = m;
        if (!/position\s*:\s*(absolute|fixed)/.test(body)) continue;
        if (!/inset\s*:\s*0/.test(body)) continue;
        const display = body.match(/(?:^|[;\s])display\s*:\s*([\w-]+)/);
        if (!display || display[1] === 'none') continue;
        const guarded = new RegExp(`\\.${root}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`, 'u');
        if (!guarded.test(sheet.css)) offenders.push(`${sheet.dir}/${sheet.file}: .${root}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
