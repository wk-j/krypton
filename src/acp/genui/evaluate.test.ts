import { describe, expect, it } from 'vitest';

import { compile } from './compile';
import { evaluate, initialState } from './evaluate';
import { LIMITS } from './limits';
import type { Program } from './ast';
import type { Diagnostic, UiAction, UiNode, UiState, Value, ValueList } from './types';

function compiled(source: string): Program {
  const result = compile(source);
  if (result.program === null) {
    throw Error(`compile failed: ${result.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join(' · ')}`);
  }
  return result.program;
}

function render(source: string, overrides: UiState = {}): {
  roots: readonly UiNode[];
  diagnostics: readonly Diagnostic[];
  state: UiState;
} {
  const program = compiled(source);
  const state: UiState = { ...initialState(program), ...overrides };
  return { ...evaluate(program, state), state };
}

/** One expression's value, read back through a prop the validator leaves alone. */
function val(expr: string, prelude = ''): Value {
  const { roots } = render(`${prelude}\nSparkline([${expr}])`);
  const node = roots[0];
  if (node === undefined) throw Error('nothing rendered');
  if (node.component !== 'Sparkline') throw Error(`faulted: ${String(node.props.message)}`);
  return (node.props.values as ValueList)[0];
}

function children(node: UiNode): readonly UiNode[] {
  return node.props.children as readonly UiNode[];
}

function allKeys(nodes: readonly UiNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.key);
    const kids = node.props.children;
    if (Array.isArray(kids)) allKeys(kids as readonly UiNode[], out);
  }
  return out;
}

const EXAMPLE = [
  '$seats = 10',
  '$plan = "Pro"',
  'price = $plan == "Pro" ? 29 : 12',
  'Card("Estimate", [',
  '  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),',
  '  Metric("Total", "$" + fmt(price * $seats)),',
  '  Button("Use this", Draft("Plan for " + $seats + " seats"), variant: "primary")',
  '])',
].join('\n');

describe('initialState', () => {
  it('evaluates initializers in order, with only earlier inputs visible', () => {
    const program = compiled('$a = 10\n$b = $a * 2\n$c = [1, 2]\nMetric("x", fmt($b))');
    expect(initialState(program)).toEqual({ a: 10, b: 20, c: [1, 2] });
  });

  it('stores null for an initializer that faults', () => {
    const program = compiled('$a = "x" - 1\nMetric("x", "y")');
    expect(initialState(program).a).toBeNull();
  });

  it('keeps a list of row objects', () => {
    const program = compiled('$rows = [{ name: "a", n: 1 }]\nEditableTable($rows, ["name", "n"])');
    expect(initialState(program).rows).toEqual([{ name: 'a', n: 1 }]);
  });
});

describe('the worked example', () => {
  it('evaluates to the expected tree', () => {
    const { roots, diagnostics, state } = render(EXAMPLE);
    expect(diagnostics).toEqual([]);
    expect(state).toEqual({ seats: 10, plan: 'Pro' });
    expect(roots).toHaveLength(1);

    const card = roots[0];
    expect(card.component).toBe('Card');
    expect(card.props.title).toBe('Estimate');
    expect(children(card)).toHaveLength(3);

    const [row, metric, button] = children(card);
    const [choice, slider] = children(row);
    expect(choice.component).toBe('Choice');
    expect(choice.props.value).toEqual({ kind: 'binding', name: 'plan' });
    expect(choice.props.options).toEqual(['Basic', 'Pro']);
    expect(slider.props.value).toEqual({ kind: 'binding', name: 'seats' });
    expect(slider.props.min).toBe(1);
    expect(slider.props.max).toBe(50);
    expect(slider.props.label).toBe('Seats');
    expect(slider.props.step).toBeUndefined();

    expect(metric.props).toEqual({ label: 'Total', value: '$290' });
    expect(button.props.variant).toBe('primary');
    expect(button.props.action).toEqual([{ kind: 'action', type: 'draft', text: 'Plan for 10 seats' }]);
  });

  it('recomputes when an input changes, keeping every key', () => {
    const program = compiled(EXAMPLE);
    const state = initialState(program);
    const first = evaluate(program, state);
    const second = evaluate(program, { ...state, seats: 20 });

    const metric = children(second.roots[0])[1];
    const button = children(second.roots[0])[2];
    expect(metric.props.value).toBe('$580');
    expect(button.props.action).toEqual([{ kind: 'action', type: 'draft', text: 'Plan for 20 seats' }]);
    expect(allKeys(second.roots)).toEqual(allKeys(first.roots));
    expect(second.diagnostics).toEqual([]);
  });

  it('renders a named value called root when there is no bare expression', () => {
    const { roots } = render('root = Badge("hi")');
    expect(roots.map((node) => node.component)).toEqual(['Badge']);
  });
});

describe('operators', () => {
  it('compares with strict equality', () => {
    expect(val('1 == 1')).toBe(true);
    expect(val('1 === 1')).toBe(true);
    expect(val('"1" == 1')).toBe(false);
    expect(val('"1" === 1')).toBe(false);
    expect(val('1 != 2')).toBe(true);
    expect(val('"1" !== 1')).toBe(true);
    expect(val('null == false')).toBe(false);
  });

  it('adds numbers and concatenates text', () => {
    expect(val('1 + 2')).toBe(3);
    expect(val('"a" + 1')).toBe('a1');
    expect(val('1 + "a"')).toBe('1a');
    expect(val('"a" + null')).toBe('a');
    expect(val('"n=" + true')).toBe('n=true');
  });

  it('refuses a mixed-type comparison', () => {
    expect(val('2 < 10')).toBe(true);
    expect(val('"a" < "b"')).toBe(true);
    expect(val('"b" >= "b"')).toBe(true);
    expect(val('10 > 2')).toBe(true);
    expect(val('2 <= 2')).toBe(true);
    const { roots, diagnostics } = render('Sparkline(["2" < 10])');
    expect(roots[0].component).toBe('Error');
    expect(String(roots[0].props.message)).toContain('cannot compare');
    expect(diagnostics[0].severity).toBe('warning');
  });

  it('yields null for non-finite arithmetic', () => {
    expect(val('1 / 0')).toBeNull();
    expect(val('0 / 0')).toBeNull();
    expect(val('1e308 * 10')).toBeNull();
    expect(val('0 - 1e308 - 1e308')).toBeNull();
    expect(val('2 ** 10000')).toBeNull();
  });

  it('treats only null as nullish', () => {
    expect(val('null ?? 5')).toBe(5);
    expect(val('false ?? 5')).toBe(false);
    expect(val('0 ?? 5')).toBe(0);
    expect(val('"" ?? 5')).toBe('');
  });

  it('short-circuits || and &&', () => {
    expect(val('0 || "x"')).toBe('x');
    expect(val('"a" || "b"')).toBe('a');
    expect(val('"" && 1')).toBe('');
    expect(val('1 && 2')).toBe(2);
    expect(val('null && 1')).toBeNull();
  });

  it('applies the remaining arithmetic, unary and ternary rules', () => {
    expect(val('7 - 2')).toBe(5);
    expect(val('3 * 4')).toBe(12);
    expect(val('7 / 2')).toBe(3.5);
    expect(val('7 % 3')).toBe(1);
    expect(val('2 ** 3 ** 2')).toBe(512);
    expect(val('0 - 2 ** 2')).toBe(-4);
    expect(val('!0')).toBe(true);
    expect(val('!"a"')).toBe(false);
    expect(val('!null')).toBe(true);
    expect(val('-(3)')).toBe(-3);
    expect(val('1 > 0 ? "y" : "n"')).toBe('y');
    expect(val('0 ? "y" : "n"')).toBe('n');
  });

  it('interpolates templates', () => {
    expect(val('`a${1 + 1}b`')).toBe('a2b');
  });
});

describe('member access', () => {
  it('reads length, own keys and null', () => {
    expect(val('[1, 2, 3].length')).toBe(3);
    expect(val('"abc".length')).toBe(3);
    expect(val('row.a', 'row = { a: 1, b: 2 }')).toBe(1);
    expect(val('row.zz', 'row = { a: 1 }')).toBeNull();
    expect(val('nothing.a', 'nothing = null')).toBeNull();
    expect(val('[7, 8][1]')).toBe(8);
    expect(val('[7, 8][9]')).toBeNull();
    expect(val('row["a"]', 'row = { a: 1 }')).toBe(1);
  });

  it('refuses a forbidden property at compile and at run time', () => {
    const atCompile = compile('Badge("a".constructor)');
    expect(atCompile.program).toBeNull();
    expect(atCompile.diagnostics.some((d) => d.severity === 'error' && d.message.includes('constructor'))).toBe(true);

    const { roots } = render('$key = "constructor"\nrow = { a: 1 }\nBadge(row[$key])');
    expect(roots[0].component).toBe('Error');
    expect(String(roots[0].props.message)).toContain('constructor');
  });
});

describe('globals', () => {
  it('rounds and formats', () => {
    expect(val('round(3.14159, 2)')).toBe(3.14);
    expect(val('round(2.5)')).toBe(3);
    expect(val('fmt(1234567.891, 2)')).toBe('1,234,567.89');
    expect(val('fmt(1234)')).toBe('1,234');
    expect(val('fmt(1.5, 99)')).toBe((1.5).toLocaleString('en-US', { minimumFractionDigits: 20, maximumFractionDigits: 20 }));
  });

  it('reduces numbers', () => {
    expect(val('sum([1, 2, 3])')).toBe(6);
    expect(val('min([3, 1, 2])')).toBe(1);
    expect(val('max([3, 1, 2])')).toBe(3);
    expect(val('min(4, 2, 9)')).toBe(2);
    expect(val('max(4, 2, 9)')).toBe(9);
    expect(val('abs(0 - 2)')).toBe(2);
    expect(val('floor(1.9)')).toBe(1);
    expect(val('ceil(1.1)')).toBe(2);
    expect(val('pow(2, 10)')).toBe(1024);
    expect(val('pow(10, 400)')).toBeNull();
  });

  it('reads objects and lengths', () => {
    expect(val('keys(row)', 'row = { a: 1, b: 2 }')).toEqual(['a', 'b']);
    expect(val('values(row)', 'row = { a: 1, b: 2 }')).toEqual([1, 2]);
    expect(val('entries(row)', 'row = { a: 1, b: 2 }')).toEqual([['a', 1], ['b', 2]]);
    expect(val('len([1, 2])')).toBe(2);
    expect(val('len("abc")')).toBe(3);
  });

  it('calls a named function', () => {
    expect(val('double(21)', 'double = n => n * 2')).toBe(42);
  });
});

describe('methods', () => {
  it('walks a list', () => {
    expect(val('[1, 2, 3].map(n => n * 2)')).toEqual([2, 4, 6]);
    expect(val('[1, 2, 3].map((n, i) => n * i)')).toEqual([0, 2, 6]);
    expect(val('[1, 2, 3].filter(n => n > 1)')).toEqual([2, 3]);
    expect(val('[1, 2, 3].find(n => n > 1)')).toBe(2);
    expect(val('[1, 2].find(n => n > 9)')).toBeNull();
    expect(val('[1, 2].some(n => n > 1)')).toBe(true);
    expect(val('[1, 2].some(n => n > 9)')).toBe(false);
    expect(val('[1, 2].every(n => n > 0)')).toBe(true);
    expect(val('[1, 2].every(n => n > 1)')).toBe(false);
    expect(val('["a", "b"].join("-")')).toBe('a-b');
    expect(val('["a", "b"].join()')).toBe('a,b');
    expect(val('[1, 2, 3].slice(1)')).toEqual([2, 3]);
    expect(val('[1, 2, 3].slice(0, 2)')).toEqual([1, 2]);
    expect(val('[1, 2].includes(2)')).toBe(true);
    expect(val('[1, 2].indexOf(2)')).toBe(1);
    expect(val('[1, 2].indexOf(9)')).toBe(-1);
  });

  it('walks a string and a number', () => {
    expect(val('"abc".includes("b")')).toBe(true);
    expect(val('"abc".slice(1)')).toBe('bc');
    expect(val('"abc".slice(0, 2)')).toBe('ab');
    expect(val('"a,b".split(",")')).toEqual(['a', 'b']);
    expect(val('"  a ".trim()')).toBe('a');
    expect(val('"ab".toUpperCase()')).toBe('AB');
    expect(val('"AB".toLowerCase()')).toBe('ab');
    expect(val('"abc".startsWith("a")')).toBe(true);
    expect(val('"abc".endsWith("a")')).toBe(false);
    expect(val('n.toFixed(2)', 'n = 3.14159')).toBe('3.14');
    expect(val('n.toFixed()', 'n = 3.6')).toBe('4');
  });
});

describe('children and actions', () => {
  it('flattens children, turning text into Text and dropping null', () => {
    const { roots } = render('Stack(["one", 42, null, false, [Badge("deep")]])');
    const kids = children(roots[0]);
    expect(kids.map((node) => node.component)).toEqual(['Text', 'Text', 'Badge']);
    expect(kids[0].props.text).toBe('one');
    expect(kids[1].props.text).toBe('42');
  });

  it('builds every action', () => {
    const { roots } = render([
      '$plan = "Pro"',
      'Stack([',
      '  Button("a", Draft("hello")),',
      '  Button("b", Set($plan, "Basic")),',
      '  Button("c", Copy("text")),',
      '  Button("d", OpenUrl("https://example.com/x")),',
      '  Button("e", [Draft("one"), Copy("two")])',
      '])',
    ].join('\n'));
    const actions = children(roots[0]).map((node) => node.props.action as readonly UiAction[]);
    expect(actions[0]).toEqual([{ kind: 'action', type: 'draft', text: 'hello' }]);
    expect(actions[1]).toEqual([{ kind: 'action', type: 'set', name: 'plan', value: 'Basic' }]);
    expect(actions[2]).toEqual([{ kind: 'action', type: 'copy', text: 'text' }]);
    expect(actions[3]).toEqual([{ kind: 'action', type: 'openUrl', text: 'https://example.com/x' }]);
    expect(actions[4]).toHaveLength(2);
  });

  it('refuses a non-http url', () => {
    const { roots, diagnostics } = render('Button("go", OpenUrl("javascript:alert(1)"))');
    expect(roots[0].component).toBe('Error');
    expect(String(roots[0].props.message)).toContain('http(s)');
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning']);
  });
});

describe('keys', () => {
  it('are stable across evaluations and unique within the tree', () => {
    const program = compiled('rows = "a,b,c".split(",")\nStack(rows.map(r => Badge(r)))');
    const first = allKeys(evaluate(program, {}).roots);
    const second = allKeys(evaluate(program, {}).roots);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    expect(first).toHaveLength(4);
  });

  it('separate two sibling nodes built by the same expression', () => {
    const { roots } = render('badge = Badge("x")\nRow([badge, badge])');
    const keys = children(roots[0]).map((node) => node.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('failure', () => {
  it('replaces one node and still renders its sibling', () => {
    const { roots, diagnostics } = render('Row([Metric("Bad", "1" < 2), Badge("ok")])');
    const kids = children(roots[0]);
    expect(kids.map((node) => node.component)).toEqual(['Error', 'Badge']);
    expect(kids[1].props.text).toBe('ok');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
  });

  it('refuses a named value that refers to itself', () => {
    const program = compile('a = a + 1\nBadge(a)');
    if (program.program === null) {
      expect(program.diagnostics.some((d) => d.severity === 'error')).toBe(true);
      return;
    }
    const { roots } = evaluate(program.program, {});
    expect(roots[0].component).toBe('Error');
  });
});

describe('budgets', () => {
  function expectStopped(source: string, fragment: string): void {
    const { roots, diagnostics } = render(source);
    expect(roots).toHaveLength(0);
    expect(diagnostics.some((d) => d.severity === 'error' && d.message.includes(fragment))).toBe(true);
  }

  it('stops a list longer than the cap', () => {
    const csv = Array.from({ length: LIMITS.listLength + 1 }, () => 'a').join(',');
    expectStopped(`parts = "${csv}".split(",")\nSparkline(parts)`, 'list longer than');
  });

  it('stops a string longer than the cap', () => {
    const lines = ['s0 = "' + 'x'.repeat(1_000) + '"'];
    for (let i = 1; i <= 7; i += 1) lines.push(`s${i} = s${i - 1} + s${i - 1}`);
    lines.push('Badge(s7)');
    expectStopped(lines.join('\n'), 'string longer than');
  });

  it('stops after too many components', () => {
    const csv = Array.from({ length: 600 }, () => 'a').join(',');
    expectStopped(
      `rows = "${csv}".split(",")\nStack(rows.map(r => Row([Badge(r), Badge(r), Badge(r)])))`,
      'more than 2000 components',
    );
  });

  it('stops after too many steps', () => {
    const csv = Array.from({ length: 500 }, () => 'a').join(',');
    expectStopped(
      `data = "${csv}".split(",")\nSparkline([data.map(r => data.map(c => 1)).length])`,
      'evaluation steps',
    );
  });

  it('stops when nesting too deep', () => {
    const lines = ['a0 = 1'];
    for (let i = 1; i < 600; i += 1) lines.push(`a${i} = a${i - 1} + 1`);
    lines.push('Sparkline([a599])');
    expectStopped(lines.join('\n'), 'nested deeper than');
  });

  it('drops the remaining roots but keeps the ones already rendered', () => {
    const csv = Array.from({ length: LIMITS.listLength + 1 }, () => 'a').join(',');
    const { roots, diagnostics } = render(`parts = "${csv}".split(",")\nBadge("first")\nSparkline(parts)`);
    expect(roots.map((node) => node.component)).toEqual(['Badge']);
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
});
