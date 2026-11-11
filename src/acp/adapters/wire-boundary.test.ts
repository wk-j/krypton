import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Spec 380 — the wire boundary, enforced (ADR 0031).
//
// Only `src/acp/adapters/**` and `src/acp/client.ts` read wire JSON. Every
// other module decides what to show from canonical `LaneEvent` / `ToolView` /
// `LaneSession` fields. The scan reads the TypeScript syntax tree, so a word in
// a comment, a string or a BEM class (`acp-harness__meta`) never matches.

const SRC = resolve(import.meta.dirname, '../..');
const WIRE_KEYS = new Set(['rawInput', 'rawOutput', '_meta', 'sessionUpdate']);
const WIRE_TYPES = new Set(['ToolCall', 'ToolCallUpdate', 'ToolCallContent']);
const WIRE_TYPES_MODULE = join(SRC, 'acp', 'types');

/** The surfaces that paint lane traffic; none of them may branch on the backend. */
const VIEW_LANE_EVENT_METHODS = new Set([
  'onLaneEvent',
  'renderTool',
  'addPermission',
  'addAskUser',
  'collectToolImages',
  'noteToolActivity',
]);

/**
 * Components that name the backend for what it is, not for what its traffic
 * means: the lane's logo and label, which backend's sessions the picker
 * lists, and the launch-trust chip of a backend without a working permission
 * rail (Pi, Junie). None of them
 * reads wire data. The count pins today's uses, so a new one has to be added
 * here on purpose.
 */
const COMPONENT_BACKEND_ID_ALLOWED: Readonly<Record<string, number>> = {
  'acp/components/lane-head/index.ts': 4,
  'acp/components/rail-entry/index.ts': 7,
  'acp/components/session-picker/index.ts': 4,
};

/** The pure row-payload builders the view and the spec 381 gallery share. */
const ITEM_BUILDERS: readonly string[] = ['acp/harness-transcript-items.ts', 'acp/ask-user-question.ts'];

function posix(path: string): string {
  return path.split(sep).join('/');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function where(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${posix(relative(SRC, source.fileName))}:${line + 1}`;
}

function stringKey(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function importsWireTypes(source: ts.SourceFile, specifier: ts.Expression | undefined): boolean {
  const module = specifier && stringKey(specifier);
  if (!module || !module.startsWith('.')) return false;
  const target = resolve(dirname(source.fileName), module).replace(/\.ts$/, '');
  return target === WIRE_TYPES_MODULE;
}

/** Wire reads and wire-type imports in one module. */
function wireReads(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && WIRE_KEYS.has(node.name.text)) {
      found.push(`${where(source, node)} .${node.name.text}`);
    } else if (ts.isElementAccessExpression(node)) {
      const key = stringKey(node.argumentExpression);
      if (key && WIRE_KEYS.has(key)) found.push(`${where(source, node)} ['${key}']`);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && WIRE_KEYS.has(key.text)) found.push(`${where(source, node)} { ${key.text} }`);
    } else if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && importsWireTypes(source, node.moduleSpecifier)
    ) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (WIRE_TYPES.has(name)) found.push(`${where(source, element)} import ${name}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function identifiersNamed(source: ts.SourceFile, root: ts.Node, name: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) found.push(where(source, node));
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

interface ModuleRef {
  readonly module: string;
  readonly at: string;
}

/** Modules a file loads at runtime: static and dynamic imports and re-exports; type-only ones are erased. */
function runtimeImports(source: ts.SourceFile): ModuleRef[] {
  const found: ModuleRef[] = [];
  const visit = (node: ts.Node): void => {
    let module: string | null = null;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = !!clause && (clause.isTypeOnly || (
        !clause.name && !!bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
      ));
      if (!typeOnly) module = stringKey(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      module = stringKey(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      module = arg ? stringKey(arg) : null;
    }
    if (module) found.push({ module, at: where(source, node) });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const FILES = sourceFiles(SRC).map((path) => {
  const rel = posix(relative(SRC, path));
  return { rel, source: parse(path, readFileSync(path, 'utf8')) };
});
const BY_PATH = new Map(FILES.map((file) => [file.source.fileName, file]));

function resolveLocal(source: ts.SourceFile, module: string): (typeof FILES)[number] | undefined {
  if (!module.startsWith('.')) return undefined;
  const base = resolve(dirname(source.fileName), module);
  return BY_PATH.get(base.endsWith('.ts') ? base : `${base}.ts`) ?? BY_PATH.get(join(base, 'index.ts'));
}

/**
 * Every `@tauri-apps` import reachable at runtime from `entries`, each with the
 * import chain that reaches it.
 */
function reachableTauriImports(entries: readonly (typeof FILES)[number][]): string[] {
  const found: string[] = [];
  const via = new Map<string, string>(entries.map((file) => [file.rel, file.rel]));
  const queue = [...entries];
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const ref of runtimeImports(file.source)) {
      if (ref.module.startsWith('@tauri-apps')) {
        found.push(`${ref.at} ${ref.module} (via ${via.get(file.rel)})`);
        continue;
      }
      const next = resolveLocal(file.source, ref.module);
      if (!next || via.has(next.rel)) continue;
      via.set(next.rel, `${via.get(file.rel)} → ${next.rel}`);
      queue.push(next);
    }
  }
  return found;
}

function isBoundaryOwner(rel: string): boolean {
  return rel.startsWith('acp/adapters/') || rel === 'acp/client.ts';
}

describe('wire boundary (spec 380)', () => {
  it('scans the source tree', () => {
    const rels = FILES.map((file) => file.rel);
    expect(rels).toContain('acp/acp-harness-view.ts');
    expect(rels).toContain('acp/adapters/tool.ts');
    expect(rels.some((rel) => rel.endsWith('.test.ts'))).toBe(false);
  });

  it('reads wire JSON only in the adapters and the client', () => {
    const violations = FILES
      .filter((file) => !isBoundaryOwner(file.rel))
      .flatMap((file) => wireReads(file.source));
    expect(violations).toEqual([]);
  });

  it('keeps the backend id out of components that paint lane traffic', () => {
    const violations: string[] = [];
    for (const file of FILES.filter((entry) => entry.rel.startsWith('acp/components/'))) {
      const hits = identifiersNamed(file.source, file.source, 'backendId');
      const allowed = COMPONENT_BACKEND_ID_ALLOWED[file.rel] ?? 0;
      if (hits.length !== allowed) violations.push(`${file.rel}: ${hits.length} backendId (allowed ${allowed}): ${hits.join(', ')}`);
    }
    expect(violations).toEqual([]);
  });

  it('keeps the backend id out of the view methods that paint lane events', () => {
    const view = FILES.find((file) => file.rel === 'acp/acp-harness-view.ts');
    expect(view).toBeDefined();
    const seen = new Set<string>();
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && VIEW_LANE_EVENT_METHODS.has(node.name.text)) {
        seen.add(node.name.text);
        if (node.body) violations.push(...identifiersNamed(view!.source, node.body, 'backendId'));
      }
      ts.forEachChild(node, visit);
    };
    visit(view!.source);
    expect([...seen].sort()).toEqual([...VIEW_LANE_EVENT_METHODS].sort());
    expect(violations).toEqual([]);
  });

  it('keeps the decoder and the item builders free of Tauri, directly or through any import (spec 381 runs them in a browser)', () => {
    const entries = FILES.filter(
      (file) => file.rel.startsWith('acp/adapters/') || ITEM_BUILDERS.includes(file.rel),
    );
    expect(entries.filter((file) => ITEM_BUILDERS.includes(file.rel))).toHaveLength(ITEM_BUILDERS.length);
    expect(entries.length).toBeGreaterThan(10);
    expect(reachableTauriImports(entries)).toEqual([]);
  });

  it('finds a Tauri import behind a chain of imports, but not behind a type-only one', () => {
    const view = FILES.find((file) => file.rel === 'acp/acp-harness-view.ts');
    expect(view).toBeDefined();
    expect(reachableTauriImports([view!]).length).toBeGreaterThan(0);
    const probe = parse(join(SRC, 'acp', 'adapters', 'probe.ts'), [
      "import type { HarnessImage } from '../harness-view-types';",
      "import { type LaneActivity } from '../harness-view-types';",
      "export type { ImageFileResult } from '../harness-images';",
    ].join('\n'));
    expect(runtimeImports(probe)).toEqual([]);
    const reaching = parse(join(SRC, 'acp', 'adapters', 'probe.ts'), "import { makeId } from '../harness-format';");
    expect(reachableTauriImports([{ rel: 'acp/adapters/probe.ts', source: reaching }])).toEqual([
      expect.stringMatching(/^acp\/harness-format\.ts:\d+ @tauri-apps\/api\/core \(via acp\/adapters\/probe\.ts → acp\/harness-format\.ts\)$/),
    ]);
  });

  it('catches every wire read form and ignores look-alikes', () => {
    const probe = parse(join(SRC, 'acp', 'probe.ts'), [
      "import type { ToolCall, PlanEntry } from './types';",
      "export type { ToolCallUpdate as Wire } from './types';",
      'const a = call.rawInput;',
      'const b = call?.rawOutput;',
      "const c = update['_meta'];",
      'const { sessionUpdate } = update;',
      '// call.rawInput in a comment',
      "const d = 'acp-harness__meta .rawInput';",
      'const e = view.commandLine;',
    ].join('\n'));
    expect(wireReads(probe)).toEqual([
      'acp/probe.ts:1 import ToolCall',
      'acp/probe.ts:2 import ToolCallUpdate',
      'acp/probe.ts:3 .rawInput',
      'acp/probe.ts:4 .rawOutput',
      "acp/probe.ts:5 ['_meta']",
      'acp/probe.ts:6 { sessionUpdate }',
    ]);
  });
});
