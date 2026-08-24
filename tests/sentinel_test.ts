/**
 * Whether the printer actually carries a marker where it is put.
 *
 * The whole recovery rests on one assumption: a synthetic comment attached to a
 * node is emitted around that node's text. That is the least a printer can be
 * asked to do, and it is still an assumption, and a wrong one would produce
 * spans that are confidently in the wrong place rather than absent. So it is
 * measured per node kind rather than measured once and generalised.
 *
 * @module
 */

import { assertEquals, assertThrows } from "@std/assert";
import ts from "typescript";
import { Marker, strip } from "../src/sentinel.ts";

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const blank = ts.createSourceFile("x.ts", "", ts.ScriptTarget.Latest, false);

/** Print one node the way the expander will, so the test measures the real path. */
const show = (node: ts.Node) =>
  printer.printNode(ts.EmitHint.Unspecified, node, blank);

const f = ts.factory;

// ------------------------------------------------------------ the assumption

Deno.test("a constructed node really does carry no position", () => {
  // The premise of the whole module, asserted rather than trusted, because if it
  // ever stops being true the sentinels are unnecessary machinery.
  const made = f.createFunctionDeclaration(
    undefined,
    undefined,
    "greet",
    undefined,
    [],
    undefined,
    f.createBlock([]),
  );
  assertEquals(made.pos, -1);
  assertEquals(made.end, -1);

  const parsed = ts.createSourceFile(
    "y.ts",
    "function greet() {}",
    ts.ScriptTarget.Latest,
    true,
  ).statements[0]!;
  assertEquals(
    parsed.pos >= 0 && parsed.end > parsed.pos,
    true,
    "a parsed node has one",
  );
});

// ----------------------------------------------------- where a marker survives

const KINDS: [string, () => ts.Node][] = [
  [
    "a statement",
    () => f.createExpressionStatement(f.createIdentifier("marked")),
  ],
  ["a function declaration", () =>
    f.createFunctionDeclaration(
      undefined,
      undefined,
      "marked",
      undefined,
      [],
      undefined,
      f.createBlock([f.createReturnStatement(f.createNumericLiteral(1))], true),
    )],
  ["an identifier in a call", () => f.createIdentifier("marked")],
  ["a string literal", () => f.createStringLiteral("marked")],
  ["a type reference", () => f.createTypeReferenceNode("Marked", undefined)],
  ["a property name", () => f.createIdentifier("marked")],
  [
    "a class declaration",
    () =>
      f.createClassDeclaration(undefined, "Marked", undefined, undefined, []),
  ],
];

for (const [label, make] of KINDS) {
  Deno.test(`a marker survives printing on ${label}`, () => {
    const marker = new Marker("test");
    const node = marker.mark(make(), 100, 6);
    const printed = show(node);
    const { text, found, lost } = strip(printed, marker);

    assertEquals(lost, [], `no marker may be dropped on ${label}`);
    assertEquals(found.length, 1, `exactly one pair on ${label}`);
    assertEquals(
      text.slice(found[0]!.outStart, found[0]!.outStart + found[0]!.length)
        .includes("marked") ||
        text.slice(found[0]!.outStart, found[0]!.outStart + found[0]!.length)
          .includes("Marked"),
      true,
      `the enclosed text is the node's own text on ${label}, got ${
        JSON.stringify(
          text.slice(found[0]!.outStart, found[0]!.outStart + found[0]!.length),
        )
      }`,
    );
    assertEquals(
      /ƒ/.test(text),
      false,
      `no marker is left in the text on ${label}`,
    );
  });
}

// -------------------------------------------------------------- nested markers

Deno.test("a marker inside a marked node is found, and both are located", () => {
  const marker = new Marker("test");
  const inner = marker.mark(f.createIdentifier("inner"), 200, 5);
  const outer = marker.mark(
    f.createExpressionStatement(f.createCallExpression(inner, undefined, [])),
    100,
    20,
  );
  const { text, found, lost } = strip(show(outer), marker);
  assertEquals(lost, []);
  assertEquals(found.length, 2);
  const byId = new Map(found.map((x) => [x.id, x]));
  const at = (id: number) => {
    const g = byId.get(id)!;
    return text.slice(g.outStart, g.outStart + g.length);
  };
  assertEquals(at(0), "inner", "the inner marker encloses only the identifier");
  assertEquals(
    at(1).replace(/\s+/g, ""),
    "inner();",
    `the outer encloses the whole call, got ${JSON.stringify(at(1))}`,
  );
});

Deno.test("two markers side by side do not cross", () => {
  const marker = new Marker("test");
  const a = marker.mark(f.createIdentifier("aaa"), 10, 3);
  const b = marker.mark(f.createIdentifier("bbb"), 20, 3);
  const stmt = f.createExpressionStatement(
    f.createBinaryExpression(a, ts.SyntaxKind.PlusToken, b),
  );
  const { text, found, lost } = strip(show(stmt), marker);
  assertEquals(lost, []);
  assertEquals(found.length, 2);
  for (const g of found) {
    const got = text.slice(g.outStart, g.outStart + g.length);
    assertEquals(
      got === "aaa" || got === "bbb",
      true,
      `each encloses its own, got ${got}`,
    );
  }
});

// -------------------------------------------------------------------- refusals

Deno.test("a zero-length or negative region is refused, since it maps nothing", () => {
  const marker = new Marker("test");
  assertThrows(
    () => marker.mark(f.createIdentifier("x"), 0, 0),
    RangeError,
    "maps nothing",
  );
  assertThrows(
    () => marker.mark(f.createIdentifier("x"), 0, -1),
    RangeError,
    "maps nothing",
  );
});

Deno.test("a region before the text is refused", () => {
  const marker = new Marker("test");
  assertThrows(
    () => marker.mark(f.createIdentifier("x"), -1, 4),
    RangeError,
    "before the text",
  );
});

Deno.test("a nonce that would not survive a comment is refused", () => {
  assertThrows(() => new Marker("has space"), RangeError);
  assertThrows(() => new Marker("*/"), RangeError);
  assertThrows(() => new Marker(""), RangeError);
});

Deno.test("two markers with different nonces do not resolve against each other", () => {
  // The reason a Marker is single-use. A marker from one file must not be found
  // in another's printed text, because the span would name a file nobody asked
  // about and nothing downstream could tell.
  const mine = new Marker("aaa");
  const theirs = new Marker("bbb");
  const node = theirs.mark(f.createIdentifier("x"), 0, 1);
  const { found, lost } = strip(show(node), mine);
  assertEquals(found.length, 0, "another marker's pair is not mine to find");
  assertEquals(lost, [], "and I lost nothing, because I marked nothing");
});

// -------------------------------------------------------------------- controls

Deno.test("text with no markers comes back byte-identical", () => {
  const marker = new Marker("test");
  const printed = show(
    f.createExpressionStatement(f.createIdentifier("plain")),
  );
  const { text, found, lost } = strip(printed, marker);
  assertEquals(text, printed);
  assertEquals(found, []);
  assertEquals(lost, []);
});

Deno.test("a dropped marker is reported rather than guessed at", () => {
  // `strip` is handed text the marker never marked into, which is what a printer
  // dropping a comment looks like from here.
  const marker = new Marker("test");
  marker.mark(f.createIdentifier("x"), 0, 1);
  const { found, lost } = strip("nothing here", marker);
  assertEquals(found, []);
  assertEquals(lost, [0], "the id whose pair never turned up");
});

/** The printer's own comment syntax around a marker half, so a test can hand `strip`
 * text the printer could have produced without having to get a real printer to produce
 * it. The malformed shapes below are ones no printer emits on purpose and any printer
 * can emit by accident, which is the whole reason `strip` reports rather than guesses. */
const wrap = (half: string) => `/*${half}*/`;

Deno.test("a marker that opens and never closes is reported, not left half-mapped", () => {
  const marker = new Marker("test");
  marker.mark(f.createIdentifier("x"), 0, 1);
  const { text, found, lost } = strip(`${wrap(marker.open(0))}tail`, marker);
  assertEquals(
    text,
    "tail",
    "the half that was there still comes out of the text",
  );
  assertEquals(found, [], "half a pair locates nothing");
  assertEquals(lost, [0], "and the id says so");
});

Deno.test("a close before its open is reported rather than anchored at zero", () => {
  // The failure this refuses is the tempting one: a close with no open could be read
  // as `everything so far`, which is a plausible-looking region and always wrong.
  const marker = new Marker("test");
  marker.mark(f.createIdentifier("x"), 0, 1);
  const printed = `before${wrap(marker.close(0))}after${wrap(marker.open(0))}`;
  const { text, found, lost } = strip(printed, marker);
  assertEquals(text, "beforeafter");
  assertEquals(found, [], "a crossed pair encloses nothing knowable");
  assertEquals(lost, [0]);
});

Deno.test("a pair with nothing between it is a loss, not a zero-length span", () => {
  // `spans.ts` refuses a zero-length span, so recording one here would push the
  // failure one layer down and lose which node caused it.
  const marker = new Marker("test");
  marker.mark(f.createIdentifier("x"), 0, 1);
  const { text, found, lost } = strip(
    `a${wrap(marker.open(0))}${wrap(marker.close(0))}b`,
    marker,
  );
  assertEquals(text, "ab");
  assertEquals(found, []);
  assertEquals(lost, [0], "seen, closed, and still nothing to map");
});

Deno.test("a pair enclosing only whitespace is a loss too", () => {
  // The trim is what makes this reachable: the region is not empty as printed, and is
  // empty once the padding the markers themselves caused is taken back off.
  const marker = new Marker("test");
  marker.mark(f.createIdentifier("x"), 0, 1);
  const { found, lost } = strip(
    `a${wrap(marker.open(0))}   ${wrap(marker.close(0))}b`,
    marker,
  );
  assertEquals(found, []);
  assertEquals(lost, [0]);
});

Deno.test("one marker's loss does not take a sound neighbour with it", () => {
  // Every refusal above returns early, and an early return that skipped the rest of
  // the text would pass all of them while mapping nothing.
  const marker = new Marker("test");
  marker.mark(f.createIdentifier("x"), 0, 1);
  marker.mark(f.createIdentifier("y"), 10, 4);
  const printed = `${wrap(marker.open(0))}${wrap(marker.close(0))}` +
    `${wrap(marker.open(1))}kept${wrap(marker.close(1))}`;
  const { text, found, lost } = strip(printed, marker);
  assertEquals(text, "kept");
  assertEquals(found, [{ id: 1, outStart: 0, length: 4 }]);
  assertEquals(lost, [0]);
});

Deno.test("the harness can fail, so the survivals above mean something", () => {
  // Without this, a `strip` that returned an empty `lost` unconditionally would
  // satisfy every assertion of the form `lost, []`.
  const marker = new Marker("test");
  marker.mark(f.createIdentifier("x"), 0, 1);
  const { lost } = strip("", marker);
  assertEquals(lost.length, 1, "strip must be able to report a loss");
});
