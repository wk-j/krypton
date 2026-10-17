import { describe, expect, it } from 'vitest';

import { compile, uiSourceHash } from './compile';
import { LIMITS } from './limits';

/** Compile a spec that must fail: asserts the fail-closed contract, returns the error messages. */
function errors(source: string): readonly string[] {
  const { program, diagnostics } = compile(source);
  expect(program).toBeNull();
  const failures = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(failures.length).toBeGreaterThan(0);
  return failures.map((diagnostic) => diagnostic.message);
}

/** Compile a spec that must still render: asserts a program came back, returns the warnings. */
function warnings(source: string): readonly string[] {
  const { program, diagnostics } = compile(source);
  expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map((entry) => entry.message)).toEqual([]);
  expect(program).not.toBeNull();
  return diagnostics.map((diagnostic) => diagnostic.message);
}

const EXAMPLE = `$seats = 10
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats)),
  Button("Use this", Draft("Plan for " + $seats + " seats"), variant: "primary")
])`;

describe('krypton-ui compile', () => {
  it('takes the worked example with the version header, without it, and after a blank line', () => {
    expect(compile(EXAMPLE).diagnostics).toEqual([]);
    expect(compile(EXAMPLE).program).not.toBeNull();
    expect(compile(`version 2\n${EXAMPLE}`).diagnostics).toEqual([]);
    expect(compile(`\nversion 2\n${EXAMPLE}`).diagnostics).toEqual([]);
  });

  it('keeps the fence line numbers when the version header is stripped', () => {
    const body = 'Card("T", [Text("hi")])\n"loose"';
    expect(compile(body).diagnostics[0]?.line).toBe(2);
    expect(compile(`version 2\n${body}`).diagnostics[0]?.line).toBe(3);
    expect(compile(`\n\nversion 2\n${body}`).diagnostics[0]?.line).toBe(5);
  });

  it('rejects an oversized source and a v1 JSON body before parsing', () => {
    const long = `Card("T", [Text("${'x'.repeat(LIMITS.sourceChars)}")])`;
    expect(errors(long)).toEqual([`a krypton-ui spec may be at most ${LIMITS.sourceChars} characters, got ${long.length}`]);
    expect(errors('{"version":1,"title":"x"}')).toEqual(['krypton-ui v1 JSON is no longer accepted']);
    expect(errors('\n  {"version":1}')).toEqual(['krypton-ui v1 JSON is no longer accepted']);
  });

  it('hashes the source with FNV-1a', () => {
    expect(uiSourceHash('')).toBe('811c9dc5');
    expect(uiSourceHash('a')).toBe('e40c292c');
    expect(uiSourceHash(EXAMPLE)).toBe(uiSourceHash(EXAMPLE));
    expect(uiSourceHash(EXAMPLE)).not.toBe(uiSourceHash(`${EXAMPLE} `));
  });
});

describe('krypton-ui names and arity', () => {
  it('suggests a near miss for an unknown name and stays silent for a far one', () => {
    expect(errors('Crd("T", ["hi"])')).toContain("unknown name 'Crd' — did you mean Card?");
    expect(errors('Zebra("T")')).toContain("unknown name 'Zebra'");
    expect(errors('Card("T", ["hi"].mapp(x => x))')).toContain("unknown method 'mapp' — did you mean map?");
    expect(errors('$seats = 1\nCard("T", [Slider($seat, 1, 2)])')).toContain("unknown input '$seat' — did you mean $seats?");
  });

  it('counts positional arguments, named parameters and duplicates', () => {
    expect(errors('Card("T", ["hi"], "extra")')).toContain('Card takes at most 2 arguments');
    expect(errors('Card("T", ["hi"], color: "red")')).toContain("Card has no parameter 'color'");
    expect(errors('Card("T", ["hi"], title: "U")')).toContain("Card: 'title' is given twice");
    expect(errors('Card("T")')).toContain("Card requires 'children'");
  });

  it('takes function and method arity from the catalog', () => {
    expect(errors('Card("T", [Text(fmt())])')).toContain('fmt() takes at least 1 argument, got 0');
    expect(errors('Card("T", [Text(len(1, 2))])')).toContain('len() takes at most 1 argument, got 2');
    expect(errors('Card("T", [Text("a".trim("b"))])')).toContain('.trim() takes at most 0 arguments, got 1');
    expect(errors('Card("T", [Text(round(1, digits: 2))])')).toContain('round() takes no named arguments');
  });
});

describe('krypton-ui argument kinds', () => {
  it('checks an enum against its values', () => {
    expect(errors('Card("T", [Badge("x", tone: "purple")])'))
      .toContain("Badge: 'tone' must be one of neutral, good, warn, bad, info");
  });

  it('checks a literal, list, object, template or unary argument against the parameter kind', () => {
    expect(errors('Card("T", [Progress("lots")])')).toContain("Progress: 'value' must be a number, got a string");
    expect(errors('Card("T", [Details("x", "y", open: 1)])')).toContain("Details: 'open' must be a boolean, got a number");
    expect(errors('Card("T", [Sparkline(3)])')).toContain("Sparkline: 'values' must be a list, got a number");
    expect(errors('Card("T", [Badge([1, 2])])')).toContain("Badge: 'text' must be a string, got a list");
    expect(errors('Card("T", [Progress(`${1} done`)])')).toContain("Progress: 'value' must be a number, got a string");
    expect(errors('Card("T", [Progress(!true)])')).toContain("Progress: 'value' must be a number, got a boolean");
    expect(errors('Card("T", [Badge({ a: 1 })])')).toContain("Badge: 'text' must be a string, got an object");
    expect(errors('Card(["T"], ["hi"])')).toContain("Card: 'title' must be a string, got a list");
  });

  it('leaves a ref, member, call or conditional untyped', () => {
    expect(compile('$n = 1\nCard("T", [Progress($n), Progress($n > 0 ? 1 : 2), Progress(sum([1]))])').diagnostics).toEqual([]);
  });

  it('accepts an action or a nested list of actions, and nothing else, in an actions parameter', () => {
    expect(compile('Card("T", [Button("Go", [Draft("a"), [Copy("b")]])])').diagnostics).toEqual([]);
    expect(errors('Card("T", [Button("Go", Card("A", ["x"]))])'))
      .toContain("Button: 'action' must be an action — Draft, Set, Copy, OpenUrl");
    expect(errors('Card("T", [Button("Go", "draft it")])'))
      .toContain("Button: 'action' must be an action — Draft, Set, Copy, OpenUrl");
  });

  it('rejects an action handed to a parameter that is not an action', () => {
    expect(errors('Card("T", [Text(Draft("hi"))])')).toContain("Text: 'text' cannot be an action");
    expect(errors('Card("T", Draft("hi"))')).toContain("Card: 'children' cannot be an action");
  });
});

describe('krypton-ui bindings and state', () => {
  it('requires a literal $name and points at the one that was meant', () => {
    expect(errors('$seats = 1\nCard("T", [Slider(seats, 1, 50)])'))
      .toContain("Slider: 'value' must be an input written as $name — write $seats");
    expect(errors('Card("T", [Slider(10, 1, 50)])')).toContain("Slider: 'value' must be an input written as $name");
    expect(errors('Card("T", [Slider($gone, 1, 50)])')).toContain("unknown input '$gone'");
  });

  it('warns and coerces a lossless initial value, and fails on anything else', () => {
    expect(warnings('$seats = "10"\nCard("T", [Slider($seats, 1, 50)])'))
      .toContain('$seats is a number input; "10" is read as 10');
    expect(warnings('$tags = ""\nCard("T", [Checklist($tags, ["a"])])'))
      .toContain('$tags is a list input; "" is read as []');
    expect(warnings('$tags = "a"\nCard("T", [Checklist($tags, ["a"])])'))
      .toContain('$tags is a list input; "a" is read as ["a"]');
    expect(warnings('$note = 3\nCard("T", [Input($note, "Note")])'))
      .toContain('$note is a text input; 3 is read as "3"');
    expect(errors('$flag = "yes"\nCard("T", [Toggle($flag, "On")])'))
      .toContain('$flag is a boolean input; its initial value is a string');
    expect(errors('$seats = [1]\nCard("T", [Slider($seats, 1, 50)])'))
      .toContain('$seats is a number input; its initial value is a list');
  });

  it('lets an input hold data but never a node or an action', () => {
    expect(compile('$rows = [{ name: "a" }]\nCard("T", [EditableTable($rows, ["name"])])').diagnostics).toEqual([]);
    expect(errors('$x = Card("T", ["hi"])\nCard("T", ["hi"])')).toContain('$x cannot hold a component');
    expect(errors('$x = [Draft("hi")]\nCard("T", ["hi"])')).toContain('$x cannot hold an action');
  });

  it('refuses more inputs than the limit allows', () => {
    const inputs = Array.from({ length: LIMITS.inputs + 1 }, (_unused, index) => `$a${index} = ${index}`).join('\n');
    expect(errors(`${inputs}\nCard("T", ["hi"])`)).toContain(`a spec may declare at most ${LIMITS.inputs} inputs`);
    const legal = Array.from({ length: LIMITS.inputs }, (_unused, index) => `$a${index} = ${index}`).join('\n');
    expect(compile(`${legal}\nCard("T", ["hi"])`).diagnostics).toEqual([]);
  });
});

describe('krypton-ui declarations', () => {
  it('rejects a duplicate input or named value', () => {
    expect(errors('$a = 1\n$a = 2\nCard("T", ["hi"])')).toContain('$a is already declared');
    expect(errors('x = 1\nx = 2\nCard("T", [Text(x)])')).toContain("'x' is already declared");
  });

  it('rejects an initializer that reads itself or an input declared later', () => {
    expect(errors('$a = $a + 1\nCard("T", ["hi"])')).toContain('$a reads itself');
    expect(errors('$a = $b\n$b = 1\nCard("T", ["hi"])')).toContain('$a reads $b, which is declared later');
    expect(errors('$a = later\nlater = $b * 2\n$b = 1\nCard("T", ["hi"])'))
      .toContain('$a reads $b, which is declared later');
  });

  it('rejects a cycle among named values and warns about an unused one', () => {
    expect(errors('a = b + 1\nb = a + 1\nCard("T", [Text(a)])')).toContain('cycle among named values: a → b → a');
    expect(warnings('price = 29\nCard("T", ["hi"])')).toContain("'price' is never used");
  });

  it('rejects a named value that shadows a built-in', () => {
    expect(errors('fmt = n => n * 2\nCard("T", [Text("hi")])')).toContain("'fmt' shadows a built-in");
    expect(errors('Card = 1\nCard("T", ["hi"])')).toContain("'Card' shadows a built-in");
  });
});

describe('krypton-ui arrows', () => {
  it('allows an arrow only as a named function or a lambda method argument', () => {
    expect(compile('double = n => n * 2\nCard("T", [Text(fmt(double(2)))])').diagnostics).toEqual([]);
    expect(compile('Card("T", [List([1, 2].map(n => n * 2))])').diagnostics).toEqual([]);
    expect(errors('Card("T", [Text(n => n)])'))
      .toContain('an arrow is only allowed as a named function or as the first argument of map, filter, find, some or every');
    expect(errors('Card("T", [Text([1].join(n => n))])'))
      .toContain('an arrow is only allowed as a named function or as the first argument of map, filter, find, some or every');
    expect(errors('Card("T", [List([1].map(2))])')).toContain('.map() takes an arrow, e.g. .map(row => row.name)');
  });

  it('caps arrow parameters and refuses recursion', () => {
    expect(errors('f = (a, b, c) => a\nCard("T", [Text(f(1, 2, 3))])')).toContain('an arrow takes at most 2 parameters');
    expect(errors('f = n => f(n)\nCard("T", [Text(f(1))])')).toContain("'f' refers to itself; recursion is not allowed");
  });
});

describe('krypton-ui forbidden properties', () => {
  it('refuses __proto__, prototype and constructor in every position', () => {
    expect(errors('__proto__ = 1\nCard("T", ["hi"])')).toContain("'__proto__' is not allowed");
    expect(errors('$__proto__ = 1\nCard("T", ["hi"])')).toContain("'__proto__' is not allowed");
    expect(errors('Card("T", [KeyValue({ __proto__: 1 })])')).toContain("'__proto__' is not allowed");
    expect(errors('$x = "s"\nCard("T", [Text($x.__proto__)])')).toContain("'__proto__' is not allowed");
    expect(errors('$x = "s"\nCard("T", [Text($x["__proto__"])])')).toContain("'__proto__' is not allowed");
    expect(errors('$x = "s"\nCard("T", [Text($x.constructor)])')).toContain("'constructor' is not allowed");
    expect(errors('$x = "s"\nCard("T", [Text($x.prototype)])')).toContain("'prototype' is not allowed");
    expect(errors('f = __proto__ => 1\nCard("T", [Text(f(1))])')).toContain("'__proto__' is not allowed");
  });
});

describe('krypton-ui roots', () => {
  it('needs at least one root, bare or named root', () => {
    expect(errors('$a = 1')).toContain('nothing to render: add an expression on its own line, or name one `root`');
    expect(compile('root = Card("T", ["hi"])').diagnostics).toEqual([]);
  });

  it('refuses a root that is not a component', () => {
    expect(errors('"hello"')).toContain('a root must be a component, not a string');
    expect(errors('42')).toContain('a root must be a component, not a number');
    expect(errors('fmt(1)')).toContain('a root must be a component, not a call to fmt');
    expect(errors('Draft("hi")')).toContain('a root must be a component, not a call to Draft');
    expect(errors('root = "hello"')).toContain('a root must be a component, not a string');
  });
});
