// Krypton — generative UI parser (spec 309).
// Recursive descent for statements, precedence climbing for expressions.
// A syntax error ends the statement it was found in and resynchronises at the
// next separator, so one mistake yields one diagnostic; `program` is null when
// anything was reported. Nothing escapes to the caller.

import {
  PRECEDENCE,
  type Arg,
  type BinaryOp,
  type Expr,
  type ObjectEntry,
  type Program,
  type Stmt,
} from './ast';
import { tableHas } from './catalog';
import { LIMITS } from './limits';
import { tokenize, type Token } from './lexer';
import type { Diagnostic } from './types';

/** Thrown to unwind to the statement loop; the diagnostic is already recorded. */
class ParseFailure extends Error {}

function describe(token: Token): string {
  switch (token.type) {
    case 'eof': return 'end of input';
    case 'newline': return 'end of line';
    case 'string': return 'a string';
    case 'tpl-start': case 'tpl-chunk': case 'tpl-end': return 'a template';
    case 'tpl-expr': return "'${'";
    case 'tpl-expr-end': return "'}'";
    case 'state': return `'$${token.text}'`;
    default: return `'${token.text}'`;
  }
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[], private readonly diagnostics: Diagnostic[]) {}

  parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    while (this.atSeparator()) this.index += 1;
    while (!this.atEnd()) {
      try {
        const stmt = this.parseStatement();
        if (!this.atEnd() && !this.atSeparator()) {
          this.fail(`expected a newline or ';' after a statement, found ${describe(this.peek())}`, this.peek());
        }
        stmts.push(stmt);
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.depth = 0;
        while (!this.atEnd() && !this.atSeparator()) this.index += 1;
      }
      while (this.atSeparator()) this.index += 1;
    }
    return stmts;
  }

  // ── tokens ──────────────────────────────────────────────────────────────

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.index + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private atEnd(): boolean {
    return this.peek().type === 'eof';
  }

  private atSeparator(): boolean {
    const token = this.peek();
    return token.type === 'newline' || (token.type === 'punct' && token.text === ';');
  }

  private checkPunct(text: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.text === text;
  }

  private matchPunct(text: string): boolean {
    if (!this.checkPunct(text)) return false;
    this.index += 1;
    return true;
  }

  private expectPunct(text: string, what: string): void {
    if (this.matchPunct(text)) return;
    this.fail(`expected '${text}' ${what}, found ${describe(this.peek())}`, this.peek());
  }

  private fail(message: string, token: Token): never {
    this.diagnostics.push({ severity: 'error', line: token.line, column: token.column, message });
    throw new ParseFailure(message);
  }

  // ── statements ──────────────────────────────────────────────────────────

  private parseStatement(): Stmt {
    const token = this.peek();
    const assigned = this.peekAt(1).type === 'punct' && this.peekAt(1).text === '=';
    if (token.type === 'state' && assigned) {
      this.index += 2;
      return { t: 'state', name: token.text, value: this.parseExpr(), line: token.line, column: token.column };
    }
    if (token.type === 'ident' && assigned) {
      this.index += 2;
      return { t: 'let', name: token.text, value: this.parseExpr(), line: token.line, column: token.column };
    }
    const value = this.parseExpr();
    return { t: 'root', value, line: value.line, column: value.column };
  }

  // ── expressions ─────────────────────────────────────────────────────────

  /** The one entry point that counts nesting; every sub-expression goes through it. */
  private parseExpr(): Expr {
    if (this.depth >= LIMITS.parseDepth) {
      this.fail(`expression nests deeper than ${LIMITS.parseDepth}`, this.peek());
    }
    this.depth += 1;
    try {
      const arrow = this.tryParseArrow();
      return arrow ?? this.parseTernary();
    } finally {
      this.depth -= 1;
    }
  }

  private tryParseArrow(): Expr | null {
    const token = this.peek();
    if (token.type === 'ident' && this.peekAt(1).type === 'punct' && this.peekAt(1).text === '=>') {
      this.index += 2;
      return { t: 'arrow', params: [token.text], body: this.parseExpr(), line: token.line, column: token.column };
    }
    if (!this.checkPunct('(') || !this.arrowAhead()) return null;
    this.index += 1;
    const params: string[] = [];
    while (!this.checkPunct(')') && !this.atEnd()) {
      const param = this.peek();
      if (param.type !== 'ident') this.fail(`expected an arrow parameter name, found ${describe(param)}`, param);
      params.push(param.text);
      this.index += 1;
      if (!this.matchPunct(',')) break;
    }
    this.expectPunct(')', 'to close the arrow parameters');
    this.expectPunct('=>', 'after the arrow parameters');
    return { t: 'arrow', params, body: this.parseExpr(), line: token.line, column: token.column };
  }

  /** `(` … `)` immediately followed by `=>`: a parameter list, not a group. */
  private arrowAhead(): boolean {
    let depth = 0;
    for (let k = this.index; k < this.tokens.length; k += 1) {
      const token = this.tokens[k];
      if (token.type === 'eof') return false;
      if (token.type !== 'punct') continue;
      if (token.text === '(' || token.text === '[' || token.text === '{') depth += 1;
      else if (token.text === ')' || token.text === ']' || token.text === '}') {
        depth -= 1;
        if (depth === 0) {
          const next = this.tokens[k + 1];
          return next !== undefined && next.type === 'punct' && next.text === '=>';
        }
      }
    }
    return false;
  }

  private parseTernary(): Expr {
    const test = this.parseBinary(1);
    if (!this.matchPunct('?')) return test;
    const then = this.parseExpr();
    this.expectPunct(':', 'between the ternary branches');
    const other = this.parseExpr();
    return { t: 'cond', test, then, other, line: test.line, column: test.column };
  }

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      // `**` is right-associative and binds tighter than unary minus: `parsePower` owns it.
      if (token.type !== 'punct' || token.text === '**' || !tableHas(PRECEDENCE, token.text)) break;
      const op = token.text as BinaryOp;
      const precedence = PRECEDENCE[op];
      if (precedence < minPrecedence) break;
      this.index += 1;
      const right = this.parseBinary(precedence + 1);
      left = { t: 'bin', op, left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private parseUnary(): Expr {
    const token = this.peek();
    if (token.type === 'punct' && (token.text === '!' || token.text === '-')) {
      this.index += 1;
      return { t: 'unary', op: token.text, arg: this.parseUnary(), line: token.line, column: token.column };
    }
    return this.parsePower();
  }

  private parsePower(): Expr {
    const left = this.parsePostfix(this.parsePrimary());
    if (!this.checkPunct('**')) return left;
    this.index += 1;
    const right = this.parseUnary();
    return { t: 'bin', op: '**', left, right, line: left.line, column: left.column };
  }

  private parsePostfix(target: Expr): Expr {
    let expr = target;
    for (;;) {
      if (this.matchPunct('.')) {
        const name = this.peek();
        if (name.type !== 'ident') this.fail(`expected a property name, found ${describe(name)}`, name);
        this.index += 1;
        if (this.checkPunct('(')) {
          expr = { t: 'method', obj: expr, name: name.text, args: this.parseMethodArgs(), line: expr.line, column: expr.column };
          continue;
        }
        expr = { t: 'member', obj: expr, name: name.text, line: expr.line, column: expr.column };
        continue;
      }
      if (this.matchPunct('[')) {
        const index = this.parseExpr();
        this.expectPunct(']', 'to close the index');
        expr = { t: 'index', obj: expr, index, line: expr.line, column: expr.column };
        continue;
      }
      if (this.checkPunct('(')) this.fail("unexpected '(', only a name can be called", this.peek());
      return expr;
    }
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    const line = token.line;
    const column = token.column;
    switch (token.type) {
      case 'number':
        this.index += 1;
        return { t: 'lit', v: token.num ?? 0, line, column };
      case 'string':
        this.index += 1;
        return { t: 'lit', v: token.text, line, column };
      case 'state':
        this.index += 1;
        return { t: 'state', name: token.text, line, column };
      case 'tpl-start':
        return this.parseTemplate();
      case 'ident': {
        this.index += 1;
        if (token.text === 'true' || token.text === 'false') return { t: 'lit', v: token.text === 'true', line, column };
        if (token.text === 'null') return { t: 'lit', v: null, line, column };
        if (this.checkPunct('(')) return { t: 'call', callee: token.text, args: this.parseCallArgs(), line, column };
        return { t: 'ref', name: token.text, line, column };
      }
      case 'punct': {
        if (token.text === '(') {
          this.index += 1;
          const inner = this.parseExpr();
          this.expectPunct(')', 'to close the group');
          return inner;
        }
        if (token.text === '[') return this.parseList();
        if (token.text === '{') return this.parseObject();
        break;
      }
      default:
        break;
    }
    this.fail(`unexpected ${describe(token)}, expected an expression`, token);
  }

  private parseTemplate(): Expr {
    const start = this.peek();
    this.index += 1;
    const parts: (string | Expr)[] = [];
    for (;;) {
      const token = this.peek();
      if (token.type === 'tpl-end') {
        this.index += 1;
        break;
      }
      if (token.type === 'tpl-chunk') {
        parts.push(token.text);
        this.index += 1;
        continue;
      }
      if (token.type === 'tpl-expr') {
        this.index += 1;
        parts.push(this.parseExpr());
        const close = this.peek();
        if (close.type !== 'tpl-expr-end') {
          this.fail(`expected '}' to close the interpolation, found ${describe(close)}`, close);
        }
        this.index += 1;
        continue;
      }
      this.fail(`unterminated template, found ${describe(token)}`, token);
    }
    return { t: 'tpl', parts, line: start.line, column: start.column };
  }

  private parseList(): Expr {
    const start = this.peek();
    this.index += 1;
    const items: Expr[] = [];
    while (!this.checkPunct(']') && !this.atEnd()) {
      items.push(this.parseExpr());
      if (!this.matchPunct(',')) break;
    }
    this.expectPunct(']', 'to close the list');
    return { t: 'list', items, line: start.line, column: start.column };
  }

  private parseObject(): Expr {
    const start = this.peek();
    this.index += 1;
    const entries: ObjectEntry[] = [];
    while (!this.checkPunct('}') && !this.atEnd()) {
      const key = this.parseObjectKey();
      this.expectPunct(':', 'after the key');
      entries.push({ key, value: this.parseExpr() });
      if (!this.matchPunct(',')) break;
    }
    this.expectPunct('}', 'to close the object');
    return { t: 'obj', entries, line: start.line, column: start.column };
  }

  /** `"a b"`, `key`, or a bare multi-word key such as `Good for`. */
  private parseObjectKey(): string {
    const token = this.peek();
    if (token.type === 'string') {
      this.index += 1;
      return token.text;
    }
    if (token.type !== 'ident') this.fail(`expected an object key, found ${describe(token)}`, token);
    const words: string[] = [];
    while (this.peek().type === 'ident' || this.peek().type === 'number') {
      words.push(this.peek().text);
      this.index += 1;
    }
    return words.join(' ');
  }

  private parseCallArgs(): Arg[] {
    this.index += 1;
    const args: Arg[] = [];
    let named = false;
    while (!this.checkPunct(')') && !this.atEnd()) {
      const token = this.peek();
      const next = this.peekAt(1);
      if (token.type === 'ident' && next.type === 'punct' && next.text === ':') {
        this.index += 2;
        named = true;
        args.push({ name: token.text, value: this.parseExpr(), line: token.line, column: token.column });
      } else {
        if (named) this.fail(`positional argument after a named argument, found ${describe(token)}`, token);
        const value = this.parseExpr();
        args.push({ name: null, value, line: value.line, column: value.column });
      }
      if (!this.matchPunct(',')) break;
    }
    this.expectPunct(')', 'to close the arguments');
    return args;
  }

  private parseMethodArgs(): Expr[] {
    this.index += 1;
    const args: Expr[] = [];
    while (!this.checkPunct(')') && !this.atEnd()) {
      const token = this.peek();
      const next = this.peekAt(1);
      if (token.type === 'ident' && next.type === 'punct' && next.text === ':') {
        this.fail(`named arguments are not allowed on a method, found '${token.text}:'`, token);
      }
      args.push(this.parseExpr());
      if (!this.matchPunct(',')) break;
    }
    this.expectPunct(')', 'to close the arguments');
    return args;
  }
}

export function parse(source: string): { program: Program | null; diagnostics: Diagnostic[] } {
  const lexed = tokenize(source);
  const diagnostics: Diagnostic[] = [...lexed.diagnostics];
  const stmts = new Parser(lexed.tokens, diagnostics).parseProgram();
  diagnostics.sort((a, b) => (a.line - b.line) || (a.column - b.column));
  const failed = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return { program: failed ? null : { stmts }, diagnostics };
}
