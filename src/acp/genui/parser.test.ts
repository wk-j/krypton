import { describe, expect, it } from 'vitest';

import type { BinaryExpr, CallExpr, CondExpr, Expr, ListExpr, Program, Stmt, TemplateExpr, UnaryExpr } from './ast';
import { parse } from './parser';

function parsed(source: string): Program {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  if (result.program === null) throw Error('expected a program');
  return result.program;
}

function rootValue(source: string): Expr {
  const stmt = parsed(source).stmts[0];
  if (stmt.t !== 'root') throw Error(`expected a root, got ${stmt.t}`);
  return stmt.value;
}

function soleError(source: string): { line: number; column: number; message: string } {
  const result = parse(source);
  expect(result.program).toBeNull();
  expect(result.diagnostics).toHaveLength(1);
  const [diagnostic] = result.diagnostics;
  expect(diagnostic.severity).toBe('error');
  return { line: diagnostic.line, column: diagnostic.column, message: diagnostic.message };
}

const example = `$seats = 10
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats)),
  Button("Use this", Draft("Plan for " + $seats + " seats"), variant: "primary")
])`;

describe('krypton-ui parser', () => {
  it('parses the published example into inputs, a named value and one root', () => {
    const { stmts } = parsed(example);
    expect(stmts.map((stmt: Stmt) => stmt.t)).toEqual(['state', 'state', 'let', 'root']);
    expect(stmts.map((stmt: Stmt) => ('name' in stmt ? stmt.name : null))).toEqual(['seats', 'plan', 'price', null]);
    expect(stmts[0]).toMatchObject({ line: 1, column: 1, value: { t: 'lit', v: 10 } });

    const price = stmts[2].value as CondExpr;
    expect(price.t).toBe('cond');
    expect(price.test).toMatchObject({ t: 'bin', op: '==', left: { t: 'state', name: 'plan' }, right: { t: 'lit', v: 'Pro' } });
    expect(price.then).toMatchObject({ t: 'lit', v: 29 });
    expect(price.other).toMatchObject({ t: 'lit', v: 12 });

    const card = stmts[3].value as CallExpr;
    expect(card).toMatchObject({ t: 'call', callee: 'Card', line: 4, column: 1 });
    expect(card.args).toHaveLength(2);
    expect(card.args[0]).toMatchObject({ name: null, value: { t: 'lit', v: 'Estimate' } });
    const children = card.args[1].value as ListExpr;
    expect(children.items.map((item: Expr) => (item as CallExpr).callee)).toEqual(['Row', 'Metric', 'Button']);

    const row = children.items[0] as CallExpr;
    const slider = (row.args[0].value as ListExpr).items[1] as CallExpr;
    expect(slider.callee).toBe('Slider');
    expect(slider.args.map((arg) => arg.name)).toEqual([null, null, null, 'label']);
    expect(slider.args[3]).toMatchObject({ line: 5, value: { t: 'lit', v: 'Seats' } });

    const button = children.items[2] as CallExpr;
    expect(button.args[2]).toMatchObject({ name: 'variant', value: { t: 'lit', v: 'primary' } });
    expect(button.args[1].value).toMatchObject({ t: 'call', callee: 'Draft' });
  });

  it('applies the documented precedence', () => {
    const sum = rootValue('1 + 2 * 3 ** 2') as BinaryExpr;
    expect(sum).toMatchObject({
      t: 'bin',
      op: '+',
      left: { t: 'lit', v: 1 },
      right: { t: 'bin', op: '*', left: { t: 'lit', v: 2 }, right: { t: 'bin', op: '**', left: { t: 'lit', v: 3 }, right: { t: 'lit', v: 2 } } },
    });

    expect(rootValue('a ?? b || c')).toMatchObject({
      t: 'bin',
      op: '??',
      left: { t: 'ref', name: 'a' },
      right: { t: 'bin', op: '||', left: { t: 'ref', name: 'b' }, right: { t: 'ref', name: 'c' } },
    });

    expect(rootValue('a && b == c < d + e * f')).toMatchObject({
      op: '&&',
      right: { op: '==', right: { op: '<', right: { op: '+', right: { op: '*' } } } },
    });

    // `**` binds tighter than unary minus.
    const negated = rootValue('-x ** 2') as UnaryExpr;
    expect(negated).toMatchObject({ t: 'unary', op: '-', arg: { t: 'bin', op: '**', left: { t: 'ref', name: 'x' }, right: { t: 'lit', v: 2 } } });
    expect(rootValue('!a == b')).toMatchObject({ t: 'bin', op: '==', left: { t: 'unary', op: '!' } });
  });

  it('keeps `**` right-associative and `+` left-associative', () => {
    expect(rootValue('2 ** 3 ** 2')).toMatchObject({
      t: 'bin', op: '**', left: { t: 'lit', v: 2 },
      right: { t: 'bin', op: '**', left: { t: 'lit', v: 3 }, right: { t: 'lit', v: 2 } },
    });
    expect(rootValue('1 - 2 - 3')).toMatchObject({
      t: 'bin', op: '-', left: { t: 'bin', op: '-', left: { t: 'lit', v: 1 }, right: { t: 'lit', v: 2 } }, right: { t: 'lit', v: 3 },
    });
    expect(rootValue('(1 + 2) * 3')).toMatchObject({ t: 'bin', op: '*', left: { t: 'bin', op: '+' } });
  });

  it('continues a statement across a newline after or before an operator, and inside brackets', () => {
    const trailing = parsed('total = 1 +\n  2 *\n  3');
    expect(trailing.stmts).toHaveLength(1);
    expect(trailing.stmts[0].value).toMatchObject({ t: 'bin', op: '+', right: { t: 'bin', op: '*' } });

    const leading = parsed('total = 1\n  + 2\n  + 3');
    expect(leading.stmts).toHaveLength(1);

    const bracketed = parsed('Card("a", [\n  Text("x"),\n  Text("y"),\n])\nText("z")');
    expect(bracketed.stmts).toHaveLength(2);
    expect(((bracketed.stmts[0].value as CallExpr).args[1].value as ListExpr).items).toHaveLength(2);

    expect(parsed('a = 1\n\n\nb = 2\n').stmts).toHaveLength(2);
    expect(parsed('x =\n  5').stmts[0].value).toMatchObject({ t: 'lit', v: 5 });
  });

  it('separates statements on `;` and ignores comments', () => {
    const program = parsed('a = 1; b = 2; a + b');
    expect(program.stmts.map((stmt: Stmt) => stmt.t)).toEqual(['let', 'let', 'root']);
    expect(program.stmts[2]).toMatchObject({ line: 1, column: 15 });

    const commented = parsed('// a heading\n$x = 1 // trailing\n// another\nMetric("n", $x)');
    expect(commented.stmts.map((stmt: Stmt) => stmt.t)).toEqual(['state', 'root']);
    expect(commented.stmts[1]).toMatchObject({ line: 4, column: 1 });
  });

  it('parses templates, nested interpolation and escapes', () => {
    const template = rootValue('`a ${ `b ${1 + 1}` } c`') as TemplateExpr;
    expect(template.t).toBe('tpl');
    expect(template.parts).toHaveLength(3);
    expect(template.parts[0]).toBe('a ');
    expect(template.parts[2]).toBe(' c');
    const inner = template.parts[1] as TemplateExpr;
    expect(inner.t).toBe('tpl');
    expect(inner.parts[0]).toBe('b ');
    expect(inner.parts[1]).toMatchObject({ t: 'bin', op: '+' });

    expect(rootValue('`${ {Good for: "views"}.x }`')).toMatchObject({
      t: 'tpl',
      parts: [{ t: 'member', name: 'x', obj: { t: 'obj', entries: [{ key: 'Good for' }] } }],
    });
    expect(rootValue('"a\\nb\\u{1F600}\\$\\\\"')).toMatchObject({ t: 'lit', v: 'a\nb\u{1F600}$\\' });
    expect(rootValue('`cost \\${raw} ${ 2 }`')).toMatchObject({ t: 'tpl', parts: ['cost ${raw} ', { t: 'lit', v: 2 }] });
  });

  it('parses member, index, method and arrow chains', () => {
    expect(rootValue('rows.map(r => r.total).join(", ")')).toMatchObject({
      t: 'method',
      name: 'join',
      obj: { t: 'method', name: 'map', obj: { t: 'ref', name: 'rows' }, args: [{ t: 'arrow', params: ['r'], body: { t: 'member', name: 'total' } }] },
      args: [{ t: 'lit', v: ', ' }],
    });
    expect(rootValue('rows.filter((r, i) => i > 0)[0]["name"]')).toMatchObject({
      t: 'index',
      index: { t: 'lit', v: 'name' },
      obj: { t: 'index', index: { t: 'lit', v: 0 }, obj: { t: 'method', args: [{ t: 'arrow', params: ['r', 'i'] }] } },
    });
    expect(parsed('double = n => n * 2').stmts[0]).toMatchObject({ t: 'let', name: 'double', value: { t: 'arrow', params: ['n'] } });
    expect(rootValue('[1, 2,]')).toMatchObject({ t: 'list', items: [{ v: 1 }, { v: 2 }] });
    expect(rootValue('{}')).toMatchObject({ t: 'obj', entries: [] });
    expect(rootValue('[true, false, null, 1.5, 2e3, 1.5e-2]')).toMatchObject({
      items: [{ v: true }, { v: false }, { v: null }, { v: 1.5 }, { v: 2000 }, { v: 0.015 }],
    });
  });

  it('refuses a positional argument after a named one', () => {
    const error = soleError('Slider($seats, label: "Seats", 50)');
    expect(error.message).toBe("positional argument after a named argument, found '50'");
    expect(error).toMatchObject({ line: 1, column: 32 });
  });

  it('reports one diagnostic per malformed construct, at the offending token', () => {
    expect(soleError('x = "abc')).toMatchObject({ line: 1, column: 5, message: 'unterminated string' });
    expect(soleError('Card("a", [1, 2')).toMatchObject({ line: 1, column: 16, message: "expected ']' to close the list, found end of input" });
    expect(soleError('Card("a"')).toMatchObject({ line: 1, column: 9, message: "expected ')' to close the arguments, found end of input" });
    expect(soleError('=> 1')).toMatchObject({ line: 1, column: 1, message: "unexpected '=>', expected an expression" });
    expect(soleError('f(1))')).toMatchObject({ line: 1, column: 5, message: "expected a newline or ';' after a statement, found ')'" });
    expect(soleError('Text(1 + )')).toMatchObject({ line: 1, column: 10, message: "unexpected ')', expected an expression" });
    expect(soleError('`a ${ 1')).toMatchObject({ line: 1, column: 1, message: 'unterminated template literal' });
    expect(soleError('x = 1 @ 2')).toMatchObject({ line: 1, column: 7, message: "expected a newline or ';' after a statement, found '@'" });
    expect(soleError('Text(@)')).toMatchObject({ line: 1, column: 6, message: "unexpected '@', expected an expression" });
    expect(soleError('a(1)(2)')).toMatchObject({ line: 1, column: 5, message: "unexpected '(', only a name can be called" });
  });

  it('stops nesting at the parse-depth limit without cascading', () => {
    expect(parse(`${'['.repeat(100)}${']'.repeat(100)}`).diagnostics).toEqual([]);
    const error = soleError(`${'['.repeat(101)}${']'.repeat(101)}`);
    expect(error.message).toBe('expression nests deeper than 100');
    expect(error).toMatchObject({ line: 1, column: 101 });
  });

  it('resynchronises so one bad statement does not poison the next', () => {
    const result = parse('a = 1\nb = *\nc = 3\nd = )\ne = 5');
    expect(result.program).toBeNull();
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.line)).toEqual([2, 4]);
  });
});
