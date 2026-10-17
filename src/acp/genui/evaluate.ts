// Krypton — generative UI interpreter (spec 309).
//
// A tree-walking evaluator: no `eval`, no `new Function`. Steps, recursion
// depth, produced nodes, list length and string length are all on a budget
// from `limits.ts`; exceeding one stops the run and leaves a diagnostic. A
// runtime fault inside one component replaces that node alone, so its siblings
// still render, and nothing ever throws out of `evaluate()`.
//
// Node keys are the path taken through the tree (root index · parameter name ·
// position in a list · iteration index inside a lambda), so the same logical
// node keeps its key across re-evaluation and `reconcile()` patches in place.

import type { ArrowExpr, CallExpr, Expr, Pos, Program } from './ast';
import type { ComponentSpec, ParamSpec } from './catalog';
import {
  ACTION_BY_NAME,
  COMPONENT_BY_NAME,
  FORBIDDEN_PROPERTIES,
  FUNCTIONS,
  LAMBDA_METHODS,
  LIST_METHODS,
  NUMBER_METHODS,
  STRING_METHODS,
  tableHas,
} from './catalog';
import { LIMITS } from './limits';
import type {
  Diagnostic,
  UiAction,
  UiNode,
  UiState,
  Value,
  ValueList,
  ValueObject,
} from './types';
import { isAction, isBinding, isList, isNode, isPlainObject, toStateValue } from './types';

/** `toFixed` and friends refuse more than this; the catalog clamps rather than throws. */
const MAX_DIGITS = 20;

/** A fault in one expression: the enclosing component becomes an `Error` node. */
class RuntimeFault extends Error {
  readonly pos: Pos;

  constructor(message: string, pos: Pos) {
    super(message);
    this.name = 'RuntimeFault';
    this.pos = pos;
  }
}

/** A budget was exhausted: the run stops and the remaining roots are dropped. */
class BudgetFault extends Error {
  readonly pos: Pos;

  constructor(message: string, pos: Pos) {
    super(message);
    this.name = 'BudgetFault';
    this.pos = pos;
  }
}

/** Arrow parameters only; named values are re-evaluated at each reference. */
interface Scope {
  readonly vars: Record<string, Value>;
  readonly parent: Scope | null;
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function truthy(value: Value): boolean {
  return value !== null && value !== false && value !== 0 && value !== '';
}

function typeName(value: Value): string {
  if (value === null) return 'null';
  if (isList(value)) return 'a list';
  if (isNode(value)) return 'a component';
  if (isAction(value)) return 'an action';
  if (isBinding(value)) return 'an input';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

function numberOf(value: Value, what: string, pos: Pos): number {
  if (typeof value !== 'number') throw new RuntimeFault(`${what} expects a number, got ${typeName(value)}`, pos);
  return value;
}

function listOf(value: Value, what: string, pos: Pos): ValueList {
  if (!isList(value)) throw new RuntimeFault(`${what} expects a list, got ${typeName(value)}`, pos);
  return value;
}

function stringOf(value: Value, what: string, pos: Pos): string {
  if (typeof value !== 'string') throw new RuntimeFault(`${what} expects text, got ${typeName(value)}`, pos);
  return value;
}

function objectOf(value: Value, what: string, pos: Pos): ValueObject {
  if (!isPlainObject(value)) throw new RuntimeFault(`${what} expects an object, got ${typeName(value)}`, pos);
  return value;
}

/** Arithmetic that overflows or divides by zero yields `null`, never `NaN`. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function clampDigits(value: Value, pos: Pos): number {
  if (value === undefined || value === null) return 0;
  const digits = numberOf(value, 'digits', pos);
  if (!Number.isFinite(digits)) return 0;
  return Math.min(MAX_DIGITS, Math.max(0, Math.trunc(digits)));
}

function textOf(value: Value, pos: Pos): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new RuntimeFault(`cannot use ${typeName(value)} as text`, pos);
}

class Interpreter {
  private readonly program: Program;
  private readonly state: UiState;
  private readonly lets: Record<string, Expr> = emptyRecord<Expr>();
  private readonly inputs: Record<string, true> = emptyRecord<true>();
  /** Named values under evaluation, so a cycle is a fault instead of a stack overflow. */
  private readonly active: Record<string, true> = emptyRecord<true>();
  private readonly usedKeys: Record<string, number> = emptyRecord<number>();
  private readonly diagnostics: Diagnostic[] = [];
  private steps = 0;
  private depth = 0;
  private nodeCount = 0;

  constructor(program: Program, state: UiState) {
    this.program = program;
    this.state = state;
    for (const stmt of program.stmts) {
      if (stmt.t === 'state') this.inputs[stmt.name] = true;
      else if (stmt.t === 'let') this.lets[stmt.name] = stmt.value;
    }
  }

  // ── entry points ──────────────────────────────────────────────────────────

  /**
   * Inputs, in declaration order, written straight into `this.state` so a later
   * initializer sees the earlier ones and nothing else.
   */
  buildState(): UiState {
    for (const stmt of this.program.stmts) {
      if (stmt.t !== 'state') continue;
      this.steps = 0;
      this.depth = 0;
      try {
        const narrowed = toStateValue(this.evalExpr(stmt.value, null, `$${stmt.name}`));
        if (narrowed === undefined) {
          const message = `'$${stmt.name}' can only hold data, not a component or action`;
          this.diagnostics.push({ severity: 'warning', line: stmt.line, column: stmt.column, message });
        }
        this.state[stmt.name] = narrowed ?? null;
      } catch {
        this.state[stmt.name] = null;
      }
    }
    return this.state;
  }

  run(): { roots: readonly UiNode[]; diagnostics: readonly Diagnostic[] } {
    const roots: UiNode[] = [];
    const exprs = this.rootExprs();
    for (let index = 0; index < exprs.length; index += 1) {
      const path = `r${index}`;
      const expr = exprs[index];
      try {
        this.collectNodes(this.evalExpr(expr, null, path), path, roots);
      } catch (error) {
        if (error instanceof BudgetFault) {
          const { line, column } = error.pos;
          this.diagnostics.push({ severity: 'error', line, column, message: error.message });
          break;
        }
        roots.push(this.faultNode(error, expr, path));
      }
    }
    return { roots, diagnostics: this.diagnostics };
  }

  /** Bare expressions render; a spec with none renders its named value `root`. */
  private rootExprs(): readonly Expr[] {
    const bare: Expr[] = [];
    for (const stmt of this.program.stmts) if (stmt.t === 'root') bare.push(stmt.value);
    if (bare.length > 0) return bare;
    return tableHas(this.lets, 'root') ? [this.lets.root] : [];
  }

  // ── budgets and identity ──────────────────────────────────────────────────

  private checkString(value: string, pos: Pos): string {
    if (value.length > LIMITS.stringLength) {
      throw new BudgetFault(`string longer than ${LIMITS.stringLength} characters`, pos);
    }
    return value;
  }

  private checkList<T>(items: readonly T[], pos: Pos): readonly T[] {
    if (items.length > LIMITS.listLength) {
      throw new BudgetFault(`list longer than ${LIMITS.listLength} items`, pos);
    }
    return items;
  }

  /** Deterministic traversal makes the dedupe suffix stable across evaluations. */
  private freshKey(path: string): string {
    const seen = tableHas(this.usedKeys, path) ? this.usedKeys[path] : 0;
    this.usedKeys[path] = seen + 1;
    return seen === 0 ? path : `${path}~${seen}`;
  }

  private makeNode(component: string, props: Record<string, Value>, path: string, pos: Pos): UiNode {
    this.nodeCount += 1;
    if (this.nodeCount > LIMITS.nodes) throw new BudgetFault(`more than ${LIMITS.nodes} components`, pos);
    return { kind: 'node', component, props, key: this.freshKey(path) };
  }

  /** The node-level fail-soft path: no node budget, so an error always renders. */
  private faultNode(error: unknown, expr: Expr, path: string): UiNode {
    const pos = error instanceof RuntimeFault ? error.pos : expr;
    const message = error instanceof Error ? error.message : String(error);
    this.diagnostics.push({ severity: 'warning', line: pos.line, column: pos.column, message });
    return { kind: 'node', component: 'Error', props: { message }, key: this.freshKey(path) };
  }

  // ── expressions ───────────────────────────────────────────────────────────

  private evalExpr(expr: Expr, scope: Scope | null, path: string): Value {
    this.steps += 1;
    if (this.steps > LIMITS.steps) throw new BudgetFault(`more than ${LIMITS.steps} evaluation steps`, expr);
    if (this.depth >= LIMITS.evalDepth) throw new BudgetFault(`nested deeper than ${LIMITS.evalDepth}`, expr);
    this.depth += 1;
    try {
      return this.dispatch(expr, scope, path);
    } finally {
      this.depth -= 1;
    }
  }

  private dispatch(expr: Expr, scope: Scope | null, path: string): Value {
    switch (expr.t) {
      case 'lit':
        return expr.v;
      case 'tpl': {
        let out = '';
        for (const part of expr.parts) {
          out += typeof part === 'string' ? part : textOf(this.evalExpr(part, scope, path), expr);
          this.checkString(out, expr);
        }
        return out;
      }
      case 'list': {
        this.checkList(expr.items, expr);
        const items: Value[] = [];
        for (let i = 0; i < expr.items.length; i += 1) items.push(this.evalExpr(expr.items[i], scope, `${path}[${i}]`));
        return items;
      }
      case 'obj': {
        const out: Record<string, Value> = {};
        for (const entry of expr.entries) {
          if (tableHas(FORBIDDEN_PROPERTIES, entry.key)) {
            throw new RuntimeFault(`'${entry.key}' is not a usable key`, expr);
          }
          out[entry.key] = this.evalExpr(entry.value, scope, `${path}.${entry.key}`);
        }
        return out;
      }
      case 'state':
        return tableHas(this.state, expr.name) ? this.state[expr.name] : null;
      case 'ref':
        return this.evalRef(expr.name, scope, path, expr);
      case 'member':
        return this.member(this.evalExpr(expr.obj, scope, path), expr.name, expr);
      case 'index': {
        const target = this.evalExpr(expr.obj, scope, path);
        const key = this.evalExpr(expr.index, scope, path);
        return this.index(target, key, expr);
      }
      case 'call':
        return this.call(expr, scope, path);
      case 'method':
        return this.method(expr.obj, expr.name, expr.args, scope, path, expr);
      case 'unary': {
        const value = this.evalExpr(expr.arg, scope, path);
        if (expr.op === '!') return !truthy(value);
        return finite(-numberOf(value, "'-'", expr));
      }
      case 'bin':
        return this.binary(expr.op, expr.left, expr.right, scope, path, expr);
      case 'cond':
        return truthy(this.evalExpr(expr.test, scope, path))
          ? this.evalExpr(expr.then, scope, path)
          : this.evalExpr(expr.other, scope, path);
      case 'arrow':
        throw new RuntimeFault('a function is not a value here', expr);
    }
  }

  private evalRef(name: string, scope: Scope | null, path: string, pos: Pos): Value {
    for (let frame = scope; frame !== null; frame = frame.parent) {
      if (tableHas(frame.vars, name)) return frame.vars[name];
    }
    if (!tableHas(this.lets, name)) throw new RuntimeFault(`'${name}' is not defined`, pos);
    if (tableHas(this.active, name)) throw new RuntimeFault(`'${name}' refers to itself`, pos);
    this.active[name] = true;
    try {
      return this.evalExpr(this.lets[name], null, path);
    } finally {
      delete this.active[name];
    }
  }

  private binary(
    op: string,
    leftExpr: Expr,
    rightExpr: Expr,
    scope: Scope | null,
    path: string,
    pos: Pos,
  ): Value {
    if (op === '??') {
      const left = this.evalExpr(leftExpr, scope, path);
      return left === null ? this.evalExpr(rightExpr, scope, path) : left;
    }
    if (op === '||') {
      const left = this.evalExpr(leftExpr, scope, path);
      return truthy(left) ? left : this.evalExpr(rightExpr, scope, path);
    }
    if (op === '&&') {
      const left = this.evalExpr(leftExpr, scope, path);
      return truthy(left) ? this.evalExpr(rightExpr, scope, path) : left;
    }

    const left = this.evalExpr(leftExpr, scope, path);
    const right = this.evalExpr(rightExpr, scope, path);
    switch (op) {
      case '==':
      case '===':
        return left === right;
      case '!=':
      case '!==':
        return left !== right;
      case '<':
      case '<=':
      case '>':
      case '>=':
        return this.compare(op, left, right, pos);
      case '+':
        if (typeof left === 'string' || typeof right === 'string') {
          return this.checkString(textOf(left, pos) + textOf(right, pos), pos);
        }
        return finite(numberOf(left, "'+'", pos) + numberOf(right, "'+'", pos));
      case '-':
        return finite(numberOf(left, "'-'", pos) - numberOf(right, "'-'", pos));
      case '*':
        return finite(numberOf(left, "'*'", pos) * numberOf(right, "'*'", pos));
      case '/':
        return finite(numberOf(left, "'/'", pos) / numberOf(right, "'/'", pos));
      case '%':
        return finite(numberOf(left, "'%'", pos) % numberOf(right, "'%'", pos));
      case '**':
        return finite(numberOf(left, "'**'", pos) ** numberOf(right, "'**'", pos));
      default:
        throw new RuntimeFault(`unknown operator '${op}'`, pos);
    }
  }

  private compare(op: string, left: Value, right: Value, pos: Pos): boolean {
    const comparable = (typeof left === 'number' && typeof right === 'number')
      || (typeof left === 'string' && typeof right === 'string');
    if (!comparable) throw new RuntimeFault(`cannot compare ${typeName(left)} with ${typeName(right)}`, pos);
    const a = left as number | string;
    const b = right as number | string;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    if (op === '>') return a > b;
    return a >= b;
  }

  private member(target: Value, name: string, pos: Pos): Value {
    if (tableHas(FORBIDDEN_PROPERTIES, name)) throw new RuntimeFault(`'${name}' is not readable`, pos);
    if (target === null) return null;
    if (name === 'length') {
      if (isList(target)) return target.length;
      if (typeof target === 'string') return target.length;
    }
    if (isPlainObject(target)) return tableHas(target, name) ? target[name] : null;
    if (isNode(target) || isAction(target) || isBinding(target)) {
      throw new RuntimeFault(`cannot read '${name}' of ${typeName(target)}`, pos);
    }
    if (isList(target) || typeof target === 'string') {
      throw new RuntimeFault(`'${name}' is not a property of ${typeName(target)}`, pos);
    }
    throw new RuntimeFault(`cannot read '${name}' of ${typeName(target)}`, pos);
  }

  private index(target: Value, key: Value, pos: Pos): Value {
    if (target === null) return null;
    if (isList(target) || typeof target === 'string') {
      const at = numberOf(key, 'an index', pos);
      if (!Number.isInteger(at) || at < 0 || at >= target.length) return null;
      return typeof target === 'string' ? target.charAt(at) : target[at];
    }
    const name = stringOf(key, 'a key', pos);
    if (tableHas(FORBIDDEN_PROPERTIES, name)) throw new RuntimeFault(`'${name}' is not readable`, pos);
    const object = objectOf(target, 'an index', pos);
    return tableHas(object, name) ? object[name] : null;
  }

  // ── calls ─────────────────────────────────────────────────────────────────

  private call(expr: CallExpr, scope: Scope | null, path: string): Value {
    const name = expr.callee;
    if (tableHas(COMPONENT_BY_NAME, name)) return this.component(COMPONENT_BY_NAME[name], expr, scope, path);
    if (tableHas(ACTION_BY_NAME, name)) return this.action(expr, scope, path);
    if (tableHas(FUNCTIONS, name)) return this.global(name, expr, scope, path);
    if (tableHas(this.lets, name)) return this.namedFunction(name, expr, scope, path);
    throw new RuntimeFault(`'${name}' is not a component, action or function`, expr);
  }

  private namedFunction(name: string, expr: CallExpr, scope: Scope | null, path: string): Value {
    const fn = this.lets[name];
    if (fn.t !== 'arrow') throw new RuntimeFault(`'${name}' is not a function`, expr);
    if (tableHas(this.active, name)) throw new RuntimeFault(`'${name}' calls itself`, expr);
    const vars = emptyRecord<Value>();
    for (let i = 0; i < fn.params.length; i += 1) {
      const arg = expr.args[i];
      vars[fn.params[i]] = arg === undefined ? null : this.evalExpr(arg.value, scope, path);
    }
    this.active[name] = true;
    try {
      return this.evalExpr(fn.body, { vars, parent: null }, `${path}:${name}`);
    } finally {
      delete this.active[name];
    }
  }

  private component(spec: ComponentSpec, expr: CallExpr, scope: Scope | null, path: string): Value {
    try {
      const positional: Expr[] = [];
      const named = emptyRecord<Expr>();
      for (const arg of expr.args) {
        if (arg.name === null) positional.push(arg.value);
        else named[arg.name] = arg.value;
      }
      const props: Record<string, Value> = {};
      for (let i = 0; i < spec.params.length; i += 1) {
        const param = spec.params[i];
        const argExpr = tableHas(named, param.name) ? named[param.name] : positional[i];
        if (argExpr === undefined) continue;
        props[param.name] = this.propValue(param, argExpr, scope, `${path}.${param.name}`);
      }
      return this.makeNode(spec.name, props, path, expr);
    } catch (error) {
      if (error instanceof BudgetFault) throw error;
      return this.faultNode(error, expr, path);
    }
  }

  private propValue(param: ParamSpec, argExpr: Expr, scope: Scope | null, path: string): Value {
    if (param.kind === 'binding') {
      if (argExpr.t !== 'state') throw new RuntimeFault(`'${param.name}' expects an input written as $name`, argExpr);
      if (!tableHas(this.inputs, argExpr.name)) throw new RuntimeFault(`'$${argExpr.name}' is not declared`, argExpr);
      return { kind: 'binding', name: argExpr.name };
    }
    const value = this.evalExpr(argExpr, scope, path);
    if (param.kind === 'nodes') {
      const nodes: UiNode[] = [];
      this.collectNodes(value, path, nodes);
      return nodes;
    }
    if (param.kind === 'actions') {
      const actions: UiAction[] = [];
      this.collectActions(value, actions, argExpr);
      return actions;
    }
    return value;
  }

  /** Children flatten; text becomes a `Text` node; `null` and `false` drop out. */
  private collectNodes(value: Value, path: string, out: UiNode[]): void {
    if (value === null || value === false || value === true) return;
    if (isNode(value)) {
      out.push(value);
      return;
    }
    if (isList(value)) {
      this.checkList(value, { line: 0, column: 0 });
      for (let i = 0; i < value.length; i += 1) this.collectNodes(value[i], `${path}[${i}]`, out);
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(this.makeNode('Text', { text: String(value) }, path, { line: 0, column: 0 }));
    }
  }

  private collectActions(value: Value, out: UiAction[], pos: Pos): void {
    if (value === null) return;
    if (isAction(value)) {
      out.push(value);
      return;
    }
    if (isList(value)) {
      for (const item of value) this.collectActions(item, out, pos);
      return;
    }
    throw new RuntimeFault(`expected an action, got ${typeName(value)}`, pos);
  }

  private action(expr: CallExpr, scope: Scope | null, path: string): UiAction {
    const args: Value[] = [];
    for (let i = 0; i < expr.args.length; i += 1) {
      const arg = expr.args[i];
      if (expr.callee === 'Set' && i === 0) {
        args.push(null);
        continue;
      }
      args.push(this.evalExpr(arg.value, scope, path));
    }
    if (expr.callee === 'Draft') {
      return { kind: 'action', type: 'draft', text: this.checkString(textOf(args[0] ?? null, expr), expr) };
    }
    if (expr.callee === 'Copy') {
      return { kind: 'action', type: 'copy', text: this.checkString(textOf(args[0] ?? null, expr), expr) };
    }
    if (expr.callee === 'OpenUrl') {
      const url = stringOf(args[0] ?? null, 'OpenUrl', expr);
      if (!/^https?:\/\//i.test(url)) throw new RuntimeFault('OpenUrl only opens http(s) urls', expr);
      return { kind: 'action', type: 'openUrl', text: url };
    }
    const target = expr.args[0]?.value;
    if (target === undefined || target.t !== 'state') throw new RuntimeFault('Set expects an input written as $name', expr);
    if (!tableHas(this.inputs, target.name)) throw new RuntimeFault(`'$${target.name}' is not declared`, expr);
    const value = toStateValue(args[1] ?? null);
    if (value === undefined) throw new RuntimeFault('Set can only assign data to an input', expr);
    return { kind: 'action', type: 'set', name: target.name, value };
  }

  // ── globals ───────────────────────────────────────────────────────────────

  private global(name: string, expr: CallExpr, scope: Scope | null, path: string): Value {
    const args: Value[] = [];
    for (const arg of expr.args) args.push(this.evalExpr(arg.value, scope, path));
    const first = args.length > 0 ? args[0] : null;
    switch (name) {
      case 'round': {
        const factor = 10 ** clampDigits(args[1] ?? null, expr);
        return finite(Math.round(numberOf(first, 'round', expr) * factor) / factor);
      }
      case 'fmt': {
        const digits = clampDigits(args[1] ?? null, expr);
        const value = numberOf(first, 'fmt', expr);
        if (!Number.isFinite(value)) return '—';
        return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
      }
      case 'sum': {
        const items = listOf(first, 'sum', expr);
        this.checkList(items, expr);
        let total = 0;
        for (const item of items) total += numberOf(item, 'sum', expr);
        return finite(total);
      }
      case 'min':
      case 'max':
        return this.extreme(name, args, expr);
      case 'abs':
        return finite(Math.abs(numberOf(first, 'abs', expr)));
      case 'floor':
        return finite(Math.floor(numberOf(first, 'floor', expr)));
      case 'ceil':
        return finite(Math.ceil(numberOf(first, 'ceil', expr)));
      case 'pow':
        return finite(numberOf(first, 'pow', expr) ** numberOf(args[1] ?? null, 'pow', expr));
      case 'keys':
        return this.checkList(Object.keys(objectOf(first, 'keys', expr)), expr);
      case 'values': {
        const object = objectOf(first, 'values', expr);
        return this.checkList(Object.keys(object).map((key) => object[key]), expr);
      }
      case 'entries': {
        const object = objectOf(first, 'entries', expr);
        return this.checkList(Object.keys(object).map((key): ValueList => [key, object[key]]), expr);
      }
      default: {
        if (isList(first)) return first.length;
        if (typeof first === 'string') return first.length;
        throw new RuntimeFault(`len expects a list or text, got ${typeName(first)}`, expr);
      }
    }
  }

  private extreme(name: string, args: readonly Value[], pos: Pos): Value {
    let numbers: readonly Value[];
    if (args.length === 1 && isList(args[0])) numbers = this.checkList(args[0] as ValueList, pos);
    else numbers = args;
    if (numbers.length === 0) return null;
    let best = numberOf(numbers[0], name, pos);
    for (let i = 1; i < numbers.length; i += 1) {
      const value = numberOf(numbers[i], name, pos);
      if (name === 'min' ? value < best : value > best) best = value;
    }
    return finite(best);
  }

  // ── methods ───────────────────────────────────────────────────────────────

  private method(
    objExpr: Expr,
    name: string,
    argExprs: readonly Expr[],
    scope: Scope | null,
    path: string,
    pos: Pos,
  ): Value {
    if (tableHas(FORBIDDEN_PROPERTIES, name)) throw new RuntimeFault(`'${name}' is not callable`, pos);
    const target = this.evalExpr(objExpr, scope, path);
    if (isList(target) && tableHas(LIST_METHODS, name)) {
      this.checkList(target, pos);
      return this.listMethod(target, name, argExprs, scope, path, pos);
    }
    if (typeof target === 'string' && tableHas(STRING_METHODS, name)) {
      const args: Value[] = [];
      for (const arg of argExprs) args.push(this.evalExpr(arg, scope, path));
      return this.stringMethod(target, name, args, pos);
    }
    if (typeof target === 'number' && tableHas(NUMBER_METHODS, name)) {
      const digits = clampDigits(argExprs.length > 0 ? this.evalExpr(argExprs[0], scope, path) : null, pos);
      return Number.isFinite(target) ? target.toFixed(digits) : '—';
    }
    throw new RuntimeFault(`${typeName(target)} has no method '${name}'`, pos);
  }

  private listMethod(
    target: ValueList,
    name: string,
    argExprs: readonly Expr[],
    scope: Scope | null,
    path: string,
    pos: Pos,
  ): Value {
    if (tableHas(LAMBDA_METHODS, name)) {
      const fn = this.lambda(argExprs[0], pos);
      if (name === 'map') {
        const out: Value[] = [];
        for (let i = 0; i < target.length; i += 1) out.push(this.applyLambda(fn, target[i], i, scope, `${path}#${i}`));
        return out;
      }
      if (name === 'filter') {
        const out: Value[] = [];
        for (let i = 0; i < target.length; i += 1) {
          if (truthy(this.applyLambda(fn, target[i], i, scope, `${path}#${i}`))) out.push(target[i]);
        }
        return out;
      }
      if (name === 'find') {
        for (let i = 0; i < target.length; i += 1) {
          if (truthy(this.applyLambda(fn, target[i], i, scope, `${path}#${i}`))) return target[i];
        }
        return null;
      }
      const wanted = name === 'some';
      for (let i = 0; i < target.length; i += 1) {
        if (truthy(this.applyLambda(fn, target[i], i, scope, `${path}#${i}`)) === wanted) return wanted;
      }
      return !wanted;
    }

    const args: Value[] = [];
    for (const arg of argExprs) args.push(this.evalExpr(arg, scope, path));
    if (name === 'join') {
      const separator = args.length > 0 ? stringOf(args[0], 'join', pos) : ',';
      let out = '';
      for (let i = 0; i < target.length; i += 1) {
        out += (i === 0 ? '' : separator) + textOf(target[i], pos);
        this.checkString(out, pos);
      }
      return out;
    }
    if (name === 'slice') {
      const from = numberOf(args[0] ?? null, 'slice', pos);
      const to = args.length > 1 && args[1] !== null ? numberOf(args[1], 'slice', pos) : undefined;
      return target.slice(from, to);
    }
    if (name === 'includes') return target.indexOf(args[0] ?? null) >= 0;
    return target.indexOf(args[0] ?? null);
  }

  private stringMethod(target: string, name: string, args: readonly Value[], pos: Pos): Value {
    switch (name) {
      case 'includes':
        return target.includes(stringOf(args[0] ?? null, 'includes', pos));
      case 'slice': {
        const from = numberOf(args[0] ?? null, 'slice', pos);
        const to = args.length > 1 && args[1] !== null ? numberOf(args[1], 'slice', pos) : undefined;
        return target.slice(from, to);
      }
      case 'split':
        return this.checkList(target.split(stringOf(args[0] ?? null, 'split', pos)), pos);
      case 'trim':
        return target.trim();
      case 'toUpperCase':
        return target.toUpperCase();
      case 'toLowerCase':
        return target.toLowerCase();
      case 'startsWith':
        return target.startsWith(stringOf(args[0] ?? null, 'startsWith', pos));
      default:
        return target.endsWith(stringOf(args[0] ?? null, 'endsWith', pos));
    }
  }

  private lambda(expr: Expr | undefined, pos: Pos): ArrowExpr {
    if (expr === undefined) throw new RuntimeFault('expected a function', pos);
    if (expr.t === 'arrow') return expr;
    if (expr.t === 'ref' && tableHas(this.lets, expr.name)) {
      const fn = this.lets[expr.name];
      if (fn.t === 'arrow') return fn;
    }
    throw new RuntimeFault('expected a function', pos);
  }

  private applyLambda(fn: ArrowExpr, item: Value, index: number, scope: Scope | null, path: string): Value {
    const vars = emptyRecord<Value>();
    if (fn.params.length > 0) vars[fn.params[0]] = item;
    if (fn.params.length > 1) vars[fn.params[1]] = index;
    return this.evalExpr(fn.body, { vars, parent: scope }, path);
  }
}

/** Evaluate every `$name = …` initializer once, in declaration order. */
export function initialState(program: Program): UiState {
  return new Interpreter(program, {}).buildState();
}

/** Evaluate every root against the current inputs. Never throws. */
export function evaluate(
  program: Program,
  state: UiState,
): { roots: readonly UiNode[]; diagnostics: readonly Diagnostic[] } {
  return new Interpreter(program, state).run();
}
