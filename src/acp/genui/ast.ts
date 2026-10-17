// Krypton — generative UI AST (spec 309).
// Produced by `parser.ts`, checked by `validate.ts`, walked by `evaluate.ts`.
// Every node carries a source position so a diagnostic can point at it.

export const BINARY_OPS = [
  '??', '||', '&&',
  '==', '!=', '===', '!==',
  '<', '<=', '>', '>=',
  '+', '-',
  '*', '/', '%',
  '**',
] as const;

export type BinaryOp = (typeof BINARY_OPS)[number];
export type UnaryOp = '!' | '-';

/** Binding power per operator; higher binds tighter. `**` is right-associative. */
export const PRECEDENCE: Readonly<Record<BinaryOp, number>> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
  '**': 9,
};

export interface Pos {
  readonly line: number;
  readonly column: number;
}

export interface LiteralExpr extends Pos {
  readonly t: 'lit';
  readonly v: string | number | boolean | null;
}

export interface TemplateExpr extends Pos {
  readonly t: 'tpl';
  /** Alternating raw text and interpolations; text parts are plain strings. */
  readonly parts: readonly (string | Expr)[];
}

export interface ListExpr extends Pos {
  readonly t: 'list';
  readonly items: readonly Expr[];
}

export interface ObjectEntry {
  readonly key: string;
  readonly value: Expr;
}

export interface ObjectExpr extends Pos {
  readonly t: 'obj';
  readonly entries: readonly ObjectEntry[];
}

/** `$name` — an input declared at the top level. */
export interface StateExpr extends Pos {
  readonly t: 'state';
  readonly name: string;
}

/** A named value, a named function, or an arrow parameter. */
export interface RefExpr extends Pos {
  readonly t: 'ref';
  readonly name: string;
}

export interface MemberExpr extends Pos {
  readonly t: 'member';
  readonly obj: Expr;
  readonly name: string;
}

export interface IndexExpr extends Pos {
  readonly t: 'index';
  readonly obj: Expr;
  readonly index: Expr;
}

export interface Arg extends Pos {
  /** `null` for a positional argument. */
  readonly name: string | null;
  readonly value: Expr;
}

/** `Name(...)` — a component, an action, a global function, or a named function. */
export interface CallExpr extends Pos {
  readonly t: 'call';
  readonly callee: string;
  readonly args: readonly Arg[];
}

export interface MethodExpr extends Pos {
  readonly t: 'method';
  readonly obj: Expr;
  readonly name: string;
  readonly args: readonly Expr[];
}

export interface UnaryExpr extends Pos {
  readonly t: 'unary';
  readonly op: UnaryOp;
  readonly arg: Expr;
}

export interface BinaryExpr extends Pos {
  readonly t: 'bin';
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface CondExpr extends Pos {
  readonly t: 'cond';
  readonly test: Expr;
  readonly then: Expr;
  readonly other: Expr;
}

export interface ArrowExpr extends Pos {
  readonly t: 'arrow';
  readonly params: readonly string[];
  readonly body: Expr;
}

export type Expr =
  | LiteralExpr
  | TemplateExpr
  | ListExpr
  | ObjectExpr
  | StateExpr
  | RefExpr
  | MemberExpr
  | IndexExpr
  | CallExpr
  | MethodExpr
  | UnaryExpr
  | BinaryExpr
  | CondExpr
  | ArrowExpr;

/** `$name = expr` — an input, initialised once in declaration order. */
export interface StateStmt extends Pos {
  readonly t: 'state';
  readonly name: string;
  readonly value: Expr;
}

/** `name = expr` — a named value, or a named function when `value` is an arrow. */
export interface LetStmt extends Pos {
  readonly t: 'let';
  readonly name: string;
  readonly value: Expr;
}

/** A bare expression: it renders. */
export interface RootStmt extends Pos {
  readonly t: 'root';
  readonly value: Expr;
}

export type Stmt = StateStmt | LetStmt | RootStmt;

export interface Program {
  readonly stmts: readonly Stmt[];
}

export function childExprs(expr: Expr): readonly Expr[] {
  switch (expr.t) {
    case 'lit':
    case 'state':
    case 'ref':
      return [];
    case 'tpl':
      return expr.parts.filter((part): part is Expr => typeof part !== 'string');
    case 'list':
      return expr.items;
    case 'obj':
      return expr.entries.map((entry) => entry.value);
    case 'member':
      return [expr.obj];
    case 'index':
      return [expr.obj, expr.index];
    case 'call':
      return expr.args.map((arg) => arg.value);
    case 'method':
      return [expr.obj, ...expr.args];
    case 'unary':
      return [expr.arg];
    case 'bin':
      return [expr.left, expr.right];
    case 'cond':
      return [expr.test, expr.then, expr.other];
    case 'arrow':
      return [expr.body];
  }
}

/** Depth-first walk over every expression in the program. */
export function walkProgram(program: Program, visit: (expr: Expr) => void): void {
  const stack: Expr[] = program.stmts.map((stmt) => stmt.value);
  while (stack.length > 0) {
    const expr = stack.pop() as Expr;
    visit(expr);
    for (const child of childExprs(expr)) stack.push(child);
  }
}
