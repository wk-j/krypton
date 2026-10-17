// Krypton — generative UI validator (spec 309).
// Turns a parsed program into every `Diagnostic` the catalog implies: unknown
// names, arity, enums, literal kinds, bindings and their `holds`, declaration
// order and cycles, arrow placement, forbidden properties, actions and roots.
// Fail-closed is the caller's job (`compile.ts`): one error means no panel.

import { childExprs } from './ast';
import type { Arg, ArrowExpr, CallExpr, Expr, LetStmt, MethodExpr, Pos, Program, StateStmt } from './ast';
import {
  ACTIONS,
  ACTION_BY_NAME,
  COMPONENTS,
  COMPONENT_BY_NAME,
  FORBIDDEN_PROPERTIES,
  FUNCTIONS,
  LAMBDA_METHODS,
  LIST_METHODS,
  MAX_ARROW_PARAMS,
  NUMBER_METHODS,
  STRING_METHODS,
  tableHas,
  type ParamSpec,
  type StateKind,
} from './catalog';
import { LIMITS } from './limits';
import type { Diagnostic } from './types';

/** What a literal-ish expression is worth without evaluating anything. */
type LiteralKind = 'string' | 'number' | 'boolean' | 'null' | 'list' | 'object';

interface Ctx {
  readonly diagnostics: Diagnostic[];
  /** `$name` → its declaration. */
  readonly states: Record<string, StateStmt>;
  /** `$name` → position in initialisation order. */
  readonly stateOrder: Record<string, number>;
  /** `name` → its declaration. */
  readonly lets: Record<string, LetStmt>;
  /** Named values read from somewhere other than their own body. */
  readonly used: Set<string>;
  /** The named value being checked, so a self-reference does not count as a use. */
  current: string | null;
}

function report(ctx: Ctx, pos: Pos, message: string, severity: 'error' | 'warning' = 'error'): void {
  ctx.diagnostics.push({ severity, line: pos.line, column: pos.column, message });
}

// ── Name suggestions ────────────────────────────────────────────────────────

/** Levenshtein distance, abandoned once it passes `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous: number[] = [];
  for (let j = 0; j <= b.length; j++) previous.push(j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

function unknownName(name: string, candidates: readonly string[], what: string): string {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate, 2);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return `unknown ${what} '${name}'${best === null ? '' : ` — did you mean ${best}?`}`;
}

// ── Literal kinds ───────────────────────────────────────────────────────────

function literalKind(expr: Expr): LiteralKind | null {
  switch (expr.t) {
    case 'lit':
      if (expr.v === null) return 'null';
      if (typeof expr.v === 'string') return 'string';
      if (typeof expr.v === 'number') return 'number';
      return 'boolean';
    case 'tpl':
      return 'string';
    case 'list':
      return 'list';
    case 'obj':
      return 'object';
    case 'unary':
      return expr.op === '!' ? 'boolean' : 'number';
    default:
      return null;
  }
}

function describeKind(kind: LiteralKind): string {
  if (kind === 'null') return 'null';
  if (kind === 'object') return 'an object';
  return `a ${kind}`;
}

// ── Declarations ────────────────────────────────────────────────────────────

function checkPropertyName(ctx: Ctx, pos: Pos, name: string): void {
  if (tableHas(FORBIDDEN_PROPERTIES, name)) report(ctx, pos, `'${name}' is not allowed`);
}

function collect(program: Program): Ctx {
  const ctx: Ctx = {
    diagnostics: [],
    states: Object.create(null) as Record<string, StateStmt>,
    stateOrder: Object.create(null) as Record<string, number>,
    lets: Object.create(null) as Record<string, LetStmt>,
    used: new Set(),
    current: null,
  };
  let inputs = 0;
  for (const stmt of program.stmts) {
    if (stmt.t === 'state') {
      checkPropertyName(ctx, stmt, stmt.name);
      if (tableHas(ctx.states, stmt.name)) {
        report(ctx, stmt, `$${stmt.name} is already declared`);
        continue;
      }
      inputs++;
      if (inputs > LIMITS.inputs) {
        report(ctx, stmt, `a spec may declare at most ${LIMITS.inputs} inputs`);
        continue;
      }
      ctx.stateOrder[stmt.name] = inputs - 1;
      ctx.states[stmt.name] = stmt;
    } else if (stmt.t === 'let') {
      checkPropertyName(ctx, stmt, stmt.name);
      if (tableHas(ctx.lets, stmt.name)) {
        report(ctx, stmt, `'${stmt.name}' is already declared`);
        continue;
      }
      if (tableHas(COMPONENT_BY_NAME, stmt.name) || tableHas(ACTION_BY_NAME, stmt.name) || tableHas(FUNCTIONS, stmt.name)) {
        report(ctx, stmt, `'${stmt.name}' shadows a built-in`);
      }
      ctx.lets[stmt.name] = stmt;
    }
  }
  return ctx;
}

// ── Expressions ─────────────────────────────────────────────────────────────

function checkExpr(ctx: Ctx, expr: Expr, locals: readonly string[]): void {
  switch (expr.t) {
    case 'lit':
      return;
    case 'tpl':
      for (const part of expr.parts) if (typeof part !== 'string') checkExpr(ctx, part, locals);
      return;
    case 'list':
      for (const item of expr.items) checkExpr(ctx, item, locals);
      return;
    case 'obj':
      for (const entry of expr.entries) {
        checkPropertyName(ctx, expr, entry.key);
        checkExpr(ctx, entry.value, locals);
      }
      return;
    case 'state':
      if (!tableHas(ctx.states, expr.name)) {
        report(ctx, expr, unknownName(`$${expr.name}`, Object.keys(ctx.states).map((name) => `$${name}`), 'input'));
      }
      return;
    case 'ref':
      if (locals.includes(expr.name)) return;
      if (tableHas(ctx.lets, expr.name)) {
        if (expr.name !== ctx.current) ctx.used.add(expr.name);
        return;
      }
      report(ctx, expr, unknownName(expr.name, [...locals, ...Object.keys(ctx.lets)], 'name'));
      return;
    case 'member':
      checkPropertyName(ctx, expr, expr.name);
      checkExpr(ctx, expr.obj, locals);
      return;
    case 'index':
      if (expr.index.t === 'lit' && typeof expr.index.v === 'string') checkPropertyName(ctx, expr, expr.index.v);
      checkExpr(ctx, expr.obj, locals);
      checkExpr(ctx, expr.index, locals);
      return;
    case 'call':
      checkCall(ctx, expr, locals);
      return;
    case 'method':
      checkMethod(ctx, expr, locals);
      return;
    case 'unary':
      checkExpr(ctx, expr.arg, locals);
      return;
    case 'bin':
      checkExpr(ctx, expr.left, locals);
      checkExpr(ctx, expr.right, locals);
      return;
    case 'cond':
      checkExpr(ctx, expr.test, locals);
      checkExpr(ctx, expr.then, locals);
      checkExpr(ctx, expr.other, locals);
      return;
    case 'arrow':
      report(ctx, expr, 'an arrow is only allowed as a named function or as the first argument of map, filter, find, some or every');
      checkArrow(ctx, expr, locals);
      return;
  }
}

function checkArrow(ctx: Ctx, arrow: ArrowExpr, locals: readonly string[]): void {
  if (arrow.params.length > MAX_ARROW_PARAMS) {
    report(ctx, arrow, `an arrow takes at most ${MAX_ARROW_PARAMS} parameters`);
  }
  for (const param of arrow.params) checkPropertyName(ctx, arrow, param);
  checkExpr(ctx, arrow.body, [...locals, ...arrow.params]);
}

function checkArity(ctx: Ctx, pos: Pos, label: string, count: number, min: number, max: number): void {
  if (count < min) report(ctx, pos, `${label} takes at least ${min} argument${min === 1 ? '' : 's'}, got ${count}`);
  else if (count > max) report(ctx, pos, `${label} takes at most ${max} argument${max === 1 ? '' : 's'}, got ${count}`);
}

function checkMethod(ctx: Ctx, method: MethodExpr, locals: readonly string[]): void {
  checkPropertyName(ctx, method, method.name);
  checkExpr(ctx, method.obj, locals);
  const arities = [LIST_METHODS, STRING_METHODS, NUMBER_METHODS]
    .filter((table) => tableHas(table, method.name))
    .map((table) => table[method.name]);
  const lambda = tableHas(LAMBDA_METHODS, method.name);
  if (arities.length === 0) {
    const known = [...Object.keys(LIST_METHODS), ...Object.keys(STRING_METHODS), ...Object.keys(NUMBER_METHODS)];
    report(ctx, method, unknownName(method.name, known, 'method'));
  } else {
    const min = Math.min(...arities.map(([low]) => low));
    const max = Math.max(...arities.map(([, high]) => high));
    checkArity(ctx, method, `.${method.name}()`, method.args.length, min, max);
  }
  for (let index = 0; index < method.args.length; index++) {
    const arg = method.args[index];
    if (arg.t === 'arrow' && lambda && index === 0) checkArrow(ctx, arg, locals);
    else checkExpr(ctx, arg, locals);
  }
  if (lambda && (method.args.length === 0 || method.args[0].t !== 'arrow')) {
    report(ctx, method, `.${method.name}() takes an arrow, e.g. .${method.name}(row => row.name)`);
  }
}

function checkCall(ctx: Ctx, call: CallExpr, locals: readonly string[]): void {
  const component = tableHas(COMPONENT_BY_NAME, call.callee) ? COMPONENT_BY_NAME[call.callee] : null;
  if (component !== null) {
    checkParams(ctx, call, component.params, locals);
    return;
  }
  const action = tableHas(ACTION_BY_NAME, call.callee) ? ACTION_BY_NAME[call.callee] : null;
  if (action !== null) {
    checkParams(ctx, call, action.params, locals);
    return;
  }
  for (const arg of call.args) checkExpr(ctx, arg.value, locals);
  const named = call.args.find((arg) => arg.name !== null);
  const positional = call.args.filter((arg) => arg.name === null).length;
  const global = tableHas(FUNCTIONS, call.callee) ? FUNCTIONS[call.callee] : null;
  if (global !== null) {
    if (named !== undefined) report(ctx, named, `${call.callee}() takes no named arguments`);
    checkArity(ctx, call, `${call.callee}()`, positional, global[0], global[1]);
    return;
  }
  const declared = tableHas(ctx.lets, call.callee) ? ctx.lets[call.callee].value : null;
  if (declared !== null && declared.t === 'arrow') {
    if (call.callee !== ctx.current) ctx.used.add(call.callee);
    if (named !== undefined) report(ctx, named, `${call.callee}() takes no named arguments`);
    checkArity(ctx, call, `${call.callee}()`, positional, declared.params.length, declared.params.length);
    return;
  }
  if (tableHas(ctx.lets, call.callee)) {
    ctx.used.add(call.callee);
    report(ctx, call, `'${call.callee}' is a named value, not a function`);
    return;
  }
  if (locals.includes(call.callee)) {
    report(ctx, call, `'${call.callee}' is a value, not a function`);
    return;
  }
  const known = [
    ...COMPONENTS.map((entry) => entry.name),
    ...ACTIONS.map((entry) => entry.name),
    ...Object.keys(FUNCTIONS),
    ...Object.keys(ctx.lets),
  ];
  report(ctx, call, unknownName(call.callee, known, 'name'));
}

// ── Parameters ──────────────────────────────────────────────────────────────

function checkParams(ctx: Ctx, call: CallExpr, params: readonly ParamSpec[], locals: readonly string[]): void {
  const covered: Record<string, true> = Object.create(null) as Record<string, true>;
  let next = 0;
  for (const arg of call.args) {
    if (arg.name === null) {
      const param = params[next];
      next++;
      if (param === undefined) {
        report(ctx, arg, `${call.callee} takes at most ${params.length} argument${params.length === 1 ? '' : 's'}`);
        checkExpr(ctx, arg.value, locals);
        continue;
      }
      covered[param.name] = true;
      checkArg(ctx, call.callee, param, arg, locals);
      continue;
    }
    const param = params.find((entry) => entry.name === arg.name);
    if (param === undefined) {
      report(ctx, arg, `${call.callee} has no parameter '${arg.name}'`);
      checkExpr(ctx, arg.value, locals);
      continue;
    }
    if (tableHas(covered, param.name)) {
      report(ctx, arg, `${call.callee}: '${param.name}' is given twice`);
      checkExpr(ctx, arg.value, locals);
      continue;
    }
    covered[param.name] = true;
    checkArg(ctx, call.callee, param, arg, locals);
  }
  for (const param of params) {
    if (param.required === true && !tableHas(covered, param.name)) {
      report(ctx, call, `${call.callee} requires '${param.name}'`);
    }
  }
}

function checkArg(ctx: Ctx, owner: string, param: ParamSpec, arg: Arg, locals: readonly string[]): void {
  if (param.kind === 'binding') {
    checkBinding(ctx, owner, param, arg);
    return;
  }
  checkExpr(ctx, arg.value, locals);
  if (param.kind === 'actions') {
    checkActionArg(ctx, owner, param, arg.value);
    return;
  }
  if (arg.value.t === 'call' && tableHas(ACTION_BY_NAME, arg.value.callee)) {
    report(ctx, arg, `${owner}: '${param.name}' cannot be an action`);
    return;
  }
  const kind = literalKind(arg.value);
  if (kind === null) return;
  if (param.kind === 'enum') {
    const values = param.values ?? [];
    if (kind !== 'string' || arg.value.t !== 'lit' || !values.includes(String(arg.value.v))) {
      report(ctx, arg, `${owner}: '${param.name}' must be one of ${values.join(', ')}`);
    }
    return;
  }
  const wanted = wantedKinds(param.kind);
  if (wanted !== null && !wanted.includes(kind)) {
    report(ctx, arg, `${owner}: '${param.name}' must be ${describeParamKind(param.kind)}, got ${describeKind(kind)}`);
  }
}

function wantedKinds(kind: ParamSpec['kind']): readonly LiteralKind[] | null {
  switch (kind) {
    case 'number':
      return ['number'];
    case 'boolean':
      return ['boolean'];
    case 'list':
    case 'series':
      return ['list'];
    case 'object':
      return ['object'];
    case 'string':
    case 'text':
      return ['string', 'number'];
    case 'nodes':
      return ['list', 'string', 'null'];
    default:
      return null;
  }
}

function describeParamKind(kind: ParamSpec['kind']): string {
  if (kind === 'series') return 'a list of numbers or series';
  if (kind === 'nodes') return 'a child list';
  if (kind === 'text') return 'text';
  if (kind === 'object') return 'an object';
  return `a ${kind}`;
}

function checkActionArg(ctx: Ctx, owner: string, param: ParamSpec, expr: Expr): void {
  if (expr.t === 'list') {
    for (const item of expr.items) checkActionArg(ctx, owner, param, item);
    return;
  }
  if (expr.t === 'lit' && expr.v === null) return;
  const isAction = expr.t === 'call' && tableHas(ACTION_BY_NAME, expr.callee);
  if (isAction) return;
  if (expr.t === 'call' || literalKind(expr) !== null) {
    report(ctx, expr, `${owner}: '${param.name}' must be an action — ${ACTIONS.map((entry) => entry.name).join(', ')}`);
  }
}

// ── Bindings ────────────────────────────────────────────────────────────────

function checkBinding(ctx: Ctx, owner: string, param: ParamSpec, arg: Arg): void {
  const expr = arg.value;
  if (expr.t !== 'state') {
    const hint = expr.t === 'ref' ? ` — write $${expr.name}` : '';
    report(ctx, arg, `${owner}: '${param.name}' must be an input written as $name${hint}`);
    return;
  }
  if (!tableHas(ctx.states, expr.name)) {
    report(ctx, expr, unknownName(`$${expr.name}`, Object.keys(ctx.states).map((name) => `$${name}`), 'input'));
    return;
  }
  if (param.holds !== undefined) checkHolds(ctx, param.holds, expr.name, arg);
}

/** `$name = <literal>` against the kind the control writes back. */
function checkHolds(ctx: Ctx, holds: StateKind, name: string, pos: Pos): void {
  const initial = ctx.states[name].value;
  const kind = literalKind(initial);
  if (kind === null) return;
  if (kind === 'object') {
    report(ctx, pos, `$${name} is ${holds === 'scalar' ? 'a value' : `a ${holds}`} input; its initial value is an object`);
    return;
  }
  const literal = initial.t === 'lit' ? initial.v : null;
  if (holds === 'number') {
    if (kind === 'number') return;
    if (kind === 'string' && typeof literal === 'string' && literal.trim() !== '' && Number.isFinite(Number(literal))) {
      report(ctx, pos, `$${name} is a number input; ${JSON.stringify(literal)} is read as ${Number(literal)}`, 'warning');
      return;
    }
  } else if (holds === 'text') {
    if (kind === 'string') return;
    if (kind === 'number' && typeof literal === 'number') {
      report(ctx, pos, `$${name} is a text input; ${literal} is read as ${JSON.stringify(String(literal))}`, 'warning');
      return;
    }
  } else if (holds === 'boolean') {
    if (kind === 'boolean') return;
  } else if (holds === 'scalar') {
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return;
  } else {
    if (kind === 'list') return;
    if (kind === 'string' && typeof literal === 'string') {
      const coerced = literal === '' ? [] : [literal];
      report(ctx, pos, `$${name} is a list input; ${JSON.stringify(literal)} is read as ${JSON.stringify(coerced)}`, 'warning');
      return;
    }
  }
  const wanted = holds === 'scalar' ? 'a value' : holds === 'text' ? 'a text' : `a ${holds}`;
  report(ctx, pos, `$${name} is ${wanted} input; its initial value is ${describeKind(kind)}`);
}

// ── Declaration order, cycles, use ──────────────────────────────────────────

/** Every input a named value reads, directly or through another named value. */
function statesOf(ctx: Ctx, name: string, memo: Map<string, ReadonlySet<string>>, seen: Set<string>): ReadonlySet<string> {
  const cached = memo.get(name);
  if (cached !== undefined) return cached;
  if (seen.has(name) || !tableHas(ctx.lets, name)) return new Set();
  seen.add(name);
  const found = new Set<string>();
  collectStates(ctx, ctx.lets[name].value, found, memo, seen);
  seen.delete(name);
  memo.set(name, found);
  return found;
}

function collectStates(ctx: Ctx, expr: Expr, into: Set<string>, memo: Map<string, ReadonlySet<string>>, seen: Set<string>): void {
  if (expr.t === 'state') into.add(expr.name);
  if (expr.t === 'ref') for (const state of statesOf(ctx, expr.name, memo, seen)) into.add(state);
  if (expr.t === 'call') for (const state of statesOf(ctx, expr.callee, memo, seen)) into.add(state);
  for (const child of childExprs(expr)) collectStates(ctx, child, into, memo, seen);
}

function checkInitOrder(ctx: Ctx, program: Program): void {
  const memo = new Map<string, ReadonlySet<string>>();
  for (const stmt of program.stmts) {
    if (stmt.t !== 'state' || !tableHas(ctx.stateOrder, stmt.name) || ctx.states[stmt.name] !== stmt) continue;
    const order = ctx.stateOrder[stmt.name];
    const reads = new Set<string>();
    collectStates(ctx, stmt.value, reads, memo, new Set());
    for (const read of reads) {
      if (read === stmt.name) {
        report(ctx, stmt, `$${stmt.name} reads itself`);
      } else if (tableHas(ctx.stateOrder, read) && ctx.stateOrder[read] > order) {
        report(ctx, stmt, `$${stmt.name} reads $${read}, which is declared later`);
      }
    }
  }
}

/** Named values that reference each other in a loop, including a function calling itself. */
function checkCycles(ctx: Ctx): void {
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (name: string): void => {
    if (done.has(name)) return;
    const cycle = onStack.has(name);
    if (cycle) {
      const start = stack.indexOf(name);
      const path = [...stack.slice(start), name];
      const stmt = ctx.lets[name];
      if (path.length === 2) report(ctx, stmt, `'${name}' refers to itself; recursion is not allowed`);
      else report(ctx, stmt, `cycle among named values: ${path.join(' → ')}`);
      done.add(name);
      return;
    }
    stack.push(name);
    onStack.add(name);
    for (const referenced of referencesOf(ctx, ctx.lets[name].value)) visit(referenced);
    onStack.delete(name);
    stack.pop();
    done.add(name);
  };
  for (const name of Object.keys(ctx.lets)) visit(name);
}

function referencesOf(ctx: Ctx, expr: Expr): readonly string[] {
  const found: string[] = [];
  const walk = (current: Expr, locals: readonly string[]): void => {
    if (current.t === 'ref' && !locals.includes(current.name) && tableHas(ctx.lets, current.name)) found.push(current.name);
    if (current.t === 'call' && tableHas(ctx.lets, current.callee)) found.push(current.callee);
    const scope = current.t === 'arrow' ? [...locals, ...current.params] : locals;
    for (const child of childExprs(current)) walk(child, scope);
  };
  walk(expr, []);
  return found;
}

/** An input holds data only: a node or an action anywhere in its initializer is an error. */
function checkStateInitializer(ctx: Ctx, stmt: StateStmt): void {
  const stack: Expr[] = [stmt.value];
  while (stack.length > 0) {
    const expr = stack.pop() as Expr;
    if (expr.t === 'call') {
      if (tableHas(COMPONENT_BY_NAME, expr.callee)) report(ctx, expr, `$${stmt.name} cannot hold a component`);
      else if (tableHas(ACTION_BY_NAME, expr.callee)) report(ctx, expr, `$${stmt.name} cannot hold an action`);
    }
    for (const child of childExprs(expr)) stack.push(child);
  }
}

// ── Roots ───────────────────────────────────────────────────────────────────

function checkRootShape(ctx: Ctx, expr: Expr): void {
  if (expr.t === 'call' && !tableHas(COMPONENT_BY_NAME, expr.callee)) {
    report(ctx, expr, `a root must be a component, not a call to ${expr.callee}`);
    return;
  }
  if (expr.t === 'call' || expr.t === 'list') return;
  const kind = literalKind(expr);
  if (kind !== null) report(ctx, expr, `a root must be a component, not ${describeKind(kind)}`);
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function validate(program: Program): Diagnostic[] {
  const ctx = collect(program);
  let roots = 0;
  for (const stmt of program.stmts) {
    ctx.current = stmt.t === 'let' ? stmt.name : null;
    if (stmt.t === 'let' && stmt.value.t === 'arrow') checkArrow(ctx, stmt.value, []);
    else checkExpr(ctx, stmt.value, []);
    if (stmt.t === 'state') checkStateInitializer(ctx, stmt);
    if (stmt.t === 'root') {
      roots++;
      checkRootShape(ctx, stmt.value);
    }
  }
  ctx.current = null;
  const rootLet = tableHas(ctx.lets, 'root') ? ctx.lets.root : null;
  if (rootLet !== null) {
    roots++;
    ctx.used.add('root');
    checkRootShape(ctx, rootLet.value);
  }
  if (roots === 0) {
    report(ctx, { line: 1, column: 1 }, 'nothing to render: add an expression on its own line, or name one `root`');
  }
  checkInitOrder(ctx, program);
  checkCycles(ctx);
  for (const name of Object.keys(ctx.lets)) {
    if (!ctx.used.has(name)) report(ctx, ctx.lets[name], `'${name}' is never used`, 'warning');
  }
  return ctx.diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
}
