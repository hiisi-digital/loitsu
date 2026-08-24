//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The crossing between what the author wrote and what the checker read.
 *
 * Driven off real expansions rather than tables written by hand, so what is
 * tested is what the server will actually be handed. There is one twin per
 * target and the arms never meet inside one of them, which is why every name in
 * a twin is a name that was written and why a rename unions across twins rather
 * than across arms.
 *
 * @module
 */

import ts from "typescript";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { registry } from "../src/macro.ts";
import { expand } from "../src/expand.ts";
import { identity, spanning } from "../src/spans.ts";
import type { Position, Range } from "../src/position.ts";
import {
  Mapping,
  type Pair,
  type ProtocolDiagnostic,
  renameEdits,
  type TextEdit,
  toSourceDiagnostic,
  toSourceDiagnostics,
} from "../src/translate.ts";

const named = (e: ts.Expression) => ts.isIdentifier(e) ? e.text : "";

/** `[cfg(x)]` keeps its item when `x` names the target being built for. */
function forTarget(target: string) {
  return registry([
    {
      kind: "attribute",
      name: "cfg",
      expand: (args: readonly ts.Expression[], item: { node: ts.Statement }) =>
        named(args[0]!) === target ? [item.node] : [],
      // deno-lint-ignore no-explicit-any
    } as any,
  ]);
}

/** A pair from a real expansion, which is what the server hands this. */
function pairFor(source: string, target: string): Pair {
  const out = expand(source, forTarget(target));
  return { source, twin: out.code, spans: out.spans };
}

/** Two arms of one symbol, one per target, which is what every law is about. */
const TWO_ARMS = `[cfg(deno)]
export function greet() {
  return "d";
}

[cfg(node)]
export function greet() {
  return "n";
}
`;

const URI = "file:///a.ts";

/** The two mappings a request fans out to. */
function bothTwins(source = TWO_ARMS) {
  return {
    deno: new Mapping(pairFor(source, "deno")),
    node: new Mapping(pairFor(source, "node")),
  };
}

/** Where the nth occurrence of a word sits, as a range in `text`. */
function rangeOf(text: string, word: string, nth = 0): Range {
  let at = -1;
  for (let n = 0; n <= nth; n++) at = text.indexOf(word, at + 1);
  assertNotEquals(at, -1, `${word} #${nth} is not in the text`);
  return offsets(text, at, at + word.length);
}

/** A range from two offsets into `text`. */
function offsets(text: string, from: number, to: number): Range {
  const upto = (offset: number): Position => {
    const before = text.slice(0, offset);
    return {
      line: before.split("\n").length - 1,
      character: offset - (before.lastIndexOf("\n") + 1),
    };
  };
  return { start: upto(from), end: upto(to) };
}

/** The text a range names, so an assertion reads as characters rather than as
 * four numbers nobody can check by eye. */
function slice(text: string, range: Range): string {
  const lines = text.split("\n");
  const at = (p: Position) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return text.slice(at(range.start), at(range.end));
}

Deno.test("each twin holds one arm, under the name that was written", () => {
  const { deno, node } = bothTwins();
  assertEquals(
    slice(deno.twin.text, rangeOf(deno.twin.text, "greet")),
    "greet",
  );
  assertEquals(deno.twin.text.includes('"d"'), true);
  assertEquals(deno.twin.text.includes('"n"'), false, "the other arm is gone");
  assertEquals(node.twin.text.includes('"n"'), true);
  assertEquals(node.twin.text.includes('"d"'), false);
});

Deno.test("the two twins map their one name back to two different declarations", () => {
  // The reason a rename unions across twins. Each is a separate document to the
  // checker and each carries a different one of the two things the author wrote.
  const { deno, node } = bothTwins();
  const fromDeno = deno.toSource(
    deno.twin.positionAt(deno.twin.text.indexOf("greet")),
  );
  const fromNode = node.toSource(
    node.twin.positionAt(node.twin.text.indexOf("greet")),
  );
  assert(fromDeno !== undefined && fromNode !== undefined);
  assertEquals(slice(TWO_ARMS, { start: fromDeno, end: fromDeno }), "");
  assertEquals(fromDeno.line, 1, "the first declaration");
  assertEquals(fromNode.line, 6, "the second, which is a different symbol");
  assertNotEquals(fromDeno, fromNode);
});

Deno.test("an authored position has an image in the twin that kept its arm", () => {
  const { deno, node } = bothTwins();
  const at = rangeOf(TWO_ARMS, "greet", 0).start;
  assertEquals(deno.toTwin(at).length, 1, "the deno arm survived into it");
  assertEquals(
    node.toTwin(at),
    [],
    "and the node twin dropped that arm, so there is nowhere to point",
  );
});

Deno.test("one authored name written into two places has both images", () => {
  // The reason the downward map is plural, and it is not the cfg case: a macro
  // that derives something returns the item alongside what it derived, and names
  // the authored symbol in both. A singular answer reaches one and leaves the
  // other, which is a partial rename that nothing reports.
  const twice = registry([
    {
      kind: "attribute",
      name: "twice",
      expand: (_a: readonly ts.Expression[], item: { node: ts.Statement }) => {
        const fn = item.node as ts.FunctionDeclaration;
        return [
          item.node,
          ts.factory.createFunctionDeclaration(
            undefined,
            undefined,
            ts.factory.createIdentifier(`${fn.name!.text}_again`),
            undefined,
            [],
            undefined,
            // the authored identifier node itself, reused
            ts.factory.createBlock([
              ts.factory.createReturnStatement(fn.name!),
            ], true),
          ),
        ];
      },
      // deno-lint-ignore no-explicit-any
    } as any,
  ]);
  const source = `[twice()]\nfunction greet() {\n  return 1;\n}\n`;
  const out = expand(source, twice);
  const map = new Mapping({ source, twin: out.code, spans: out.spans });
  const images = map.toTwin(rangeOf(source, "greet").start);
  assertEquals(images.length, 2, "the declaration and the derived body");
  for (const image of images) {
    const at = map.twin.offsetAt(image);
    assertEquals(map.twin.text.slice(at, at + 5), "greet");
  }
  // and a rename driven at either one reaches the single place it was written
  const { edits } = renameEdits("hello", [[
    map,
    images.map((image) => ({
      range: {
        start: image,
        end: map.twin.positionAt(map.twin.offsetAt(image) + 5),
      },
      newText: "hello",
    })),
  ]]);
  assertEquals(edits.length, 1, "two images, one authored symbol");
  assertEquals(slice(source, edits[0]!.range), "greet");
});

Deno.test("a position inside the invocation itself has no image in any twin", () => {
  // `[cfg(deno)]` is gone from both twins. A request there is answered by
  // nothing rather than by whatever ended up at the same offset.
  const { deno, node } = bothTwins();
  const inside: Position = { line: 0, character: 5 };
  assertEquals(deno.toTwin(inside), []);
  assertEquals(node.toTwin(inside), []);
});

Deno.test("a twin position in text the printer invented maps back to nothing", () => {
  // The printer pads what it reprints, so a twin holds characters between the
  // authored ones that nobody typed. Answering with a position would put a
  // diagnostic on a column the author never touched.
  const { deno } = bothTwins();
  const twin = deno.twin.text;
  const padded = twin.indexOf("export") - 1;
  assertEquals(twin[padded], " ", "aiming at a character the printer added");
  assertEquals(deno.toSource(deno.twin.positionAt(padded)), undefined);
});

Deno.test("a twin range covering invented text keeps only the authored part", () => {
  const { deno } = bothTwins();
  const twin = deno.twin.text;
  const from = twin.indexOf("greet") - 1;
  const ranges = deno.toSourceRanges(offsets(twin, from, from + 6));
  assertEquals(ranges.length, 1);
  assertEquals(slice(TWO_ARMS, ranges[0]!), "greet", "five, not six");
});

Deno.test("a diagnostic on text nobody wrote is dropped", () => {
  const { deno } = bothTwins();
  const twin = deno.twin.text;
  const padded = twin.indexOf("export") - 1;
  assertEquals(
    toSourceDiagnostic(deno, URI, {
      range: offsets(twin, padded, padded + 1),
      message: "unused",
    }),
    undefined,
  );
});

Deno.test("a diagnostic on authored text lands on the authored text", () => {
  const { deno } = bothTwins();
  const moved = toSourceDiagnostic(deno, URI, {
    range: rangeOf(deno.twin.text, "greet"),
    message: "something",
    severity: 1,
    code: 2345,
  });
  assert(moved !== undefined);
  assertEquals(slice(TWO_ARMS, moved.range), "greet");
  assertEquals(moved.message, "something");
  assertEquals(moved.severity, 1, "a field this has no opinion about survives");
  assertEquals(moved.code, 2345);
});

Deno.test("a diagnostic that arrived without related information leaves without it", () => {
  // An empty array and an absent field read differently to a client, and adding
  // one is a change to a payload this was only asked to move.
  const { deno } = bothTwins();
  const moved = toSourceDiagnostic(deno, URI, {
    range: rangeOf(deno.twin.text, "greet"),
    message: "x",
  });
  assert(moved !== undefined);
  assertEquals("relatedInformation" in moved, false);
});

Deno.test("a related location in this document is moved, and one elsewhere is not", () => {
  const { deno } = bothTwins();
  const elsewhere = {
    location: { uri: "file:///b.ts", range: rangeOf(deno.twin.text, '"d"') },
    message: "declared here",
  };
  const moved = toSourceDiagnostic(deno, URI, {
    range: rangeOf(deno.twin.text, "greet"),
    message: "x",
    relatedInformation: [
      {
        location: { uri: URI, range: rangeOf(deno.twin.text, '"d"') },
        message: "and here",
      },
      elsewhere,
    ],
  });
  assert(moved !== undefined);
  const related = moved.relatedInformation!;
  assertEquals(related.length, 2);
  assertEquals(slice(TWO_ARMS, related[0]!.location.range), '"d"');
  assertEquals(
    related[1],
    elsewhere,
    "another file is passed through untouched, since this knows one document",
  );
});

Deno.test("a related location in this document with no image is dropped", () => {
  const { deno } = bothTwins();
  const twin = deno.twin.text;
  const padded = twin.indexOf("export") - 1;
  const moved = toSourceDiagnostic(deno, URI, {
    range: rangeOf(twin, "greet"),
    message: "x",
    relatedInformation: [{
      location: { uri: URI, range: offsets(twin, padded, padded + 1) },
      message: "gone",
    }],
  });
  assert(moved !== undefined);
  assertEquals(
    "relatedInformation" in moved,
    false,
    "the only one was dropped",
  );
});

Deno.test("a range with several authored images reports once and notes the rest", () => {
  // Reporting it several times would put one message in the problems list twice.
  // Covering the gap between them with a hull would claim text it never touched.
  const source = "aaaXXXbbb";
  const twin = "aaabbb";
  const map = new Mapping({
    source,
    twin,
    spans: spanning([
      { outStart: 0, length: 3, inStart: 0 },
      { outStart: 3, length: 3, inStart: 6 },
    ]),
  });
  const moved = toSourceDiagnostic(map, URI, {
    range: rangeOf(twin, "aaabbb"),
    message: "spans the seam",
  });
  assert(moved !== undefined);
  assertEquals(slice(source, moved.range), "aaa");
  assertEquals(moved.relatedInformation!.length, 1);
  assertEquals(
    slice(source, moved.relatedInformation![0]!.location.range),
    "bbb",
  );
});

Deno.test("the diagnostics that survive keep the order they arrived in", () => {
  const { deno } = bothTwins();
  const twin = deno.twin.text;
  const padded = twin.indexOf("export") - 1;
  const out = toSourceDiagnostics(deno, URI, [
    { range: rangeOf(twin, "greet"), message: "first" },
    { range: offsets(twin, padded, padded + 1), message: "dropped" },
    { range: rangeOf(twin, '"d"'), message: "second" },
  ]);
  assertEquals(out.map((d) => d.message), ["first", "second"]);
});

Deno.test("a rename across the twins reaches both arms, and only once each", () => {
  // The whole point. Each twin knows one declaration and neither knows the
  // other, so a rename driven at one twin alone renames half the symbol.
  const { deno, node } = bothTwins();
  const { edits, dropped } = renameEdits("hello", [
    [deno, [{ range: rangeOf(deno.twin.text, "greet"), newText: "hello" }]],
    [node, [{ range: rangeOf(node.twin.text, "greet"), newText: "hello" }]],
  ]);
  assertEquals(dropped, 0);
  assertEquals(edits.length, 2, "two arms, two declarations, two edits");
  for (const edit of edits) {
    assertEquals(slice(TWO_ARMS, edit.range), "greet");
    assertEquals(edit.newText, "hello");
  }
  assertEquals(edits[0]!.range.start.line, 1, "in authored order");
  assertEquals(edits[1]!.range.start.line, 6);
});

Deno.test("a declaration outside every arm collapses to one edit, not one per twin", () => {
  // The other normal case. A symbol no macro touched is in every twin, and the
  // same authored range arriving twice is one thing to rename.
  const source = `export function shared() {}\n`;
  const deno = new Mapping(pairFor(source, "deno"));
  const node = new Mapping(pairFor(source, "node"));
  const { edits } = renameEdits("other", [
    [deno, [{ range: rangeOf(deno.twin.text, "shared"), newText: "other" }]],
    [node, [{ range: rangeOf(node.twin.text, "shared"), newText: "other" }]],
  ]);
  assertEquals(edits.length, 1);
  assertEquals(slice(source, edits[0]!.range), "shared");
});

Deno.test("the twin's own replacement text is never spliced into the source", () => {
  // The law that would corrupt a file rather than merely miss an edit. A twin
  // may hold a name a macro derived, of which only part was written, so carrying
  // its replacement onto the authored range writes invented text into the file.
  const source = "greet();\n";
  const map = new Mapping({
    source,
    twin: "greet__deno();\n",
    // only the five authored characters of the eleven have an image
    spans: spanning([{ outStart: 0, length: 5, inStart: 0 }]),
  });
  const { edits } = renameEdits("hello", [[map, [{
    range: rangeOf("greet__deno();\n", "greet__deno"),
    newText: "hello__deno",
  }]]]);
  assertEquals(edits.length, 1);
  assertEquals(slice(source, edits[0]!.range), "greet");
  assertEquals(edits[0]!.newText, "hello", "what the author asked for");
  assertEquals(edits[0]!.newText.includes("__deno"), false);
});

Deno.test("a shorthand property's affix survives, because the twin holds the authored name", () => {
  // TypeScript answers a rename of `foo` in `{ foo }` with `prefixText: "foo: "`,
  // so an inner server sends `foo: bar` to keep the property and rename only the
  // binding. Writing the bare new name there produces `{ bar }`, which renames a
  // public property nobody asked about and breaks every reader of it.
  //
  // Verified against the compiler rather than assumed: `findRenameLocations` with
  // `providePrefixAndSuffixTextForRename` returns exactly that shape for this
  // source.
  const source = "const foo = 1;\nconst o = { foo };\n";
  const map = new Mapping({
    source,
    twin: source,
    spans: identity(source.length),
  });
  const { edits } = renameEdits("bar", [[map, [
    { range: rangeOf(source, "foo"), newText: "bar" },
    {
      range: offsets(
        source,
        source.lastIndexOf("foo"),
        source.lastIndexOf("foo") + 3,
      ),
      newText: "foo: bar",
    },
  ]]]);
  assertEquals(edits.length, 2);
  assertEquals(edits[0]!.newText, "bar", "the declaration is a plain rename");
  assertEquals(
    edits[1]!.newText,
    "foo: bar",
    "and the shorthand keeps its property name",
  );
});

Deno.test("an affix computed against a derived name is not spliced in", () => {
  // The other half of the same rule. Here the twin holds `greet__deno`, which
  // the author never wrote, so whatever the inner server built around it was
  // built around a name that does not exist in the source. The authored name is
  // what goes in, affix or no affix.
  const source = "const greet = 1;\nconst o = { greet };\n";
  const map = new Mapping({
    source,
    twin: "const greet__deno = 1;\nconst o = { greet__deno };\n",
    spans: spanning([
      { outStart: 6, length: 5, inStart: 6 },
      { outStart: 34, length: 5, inStart: 28 },
    ]),
  });
  const twin = map.twin.text;
  const { edits } = renameEdits("hello", [[map, [
    { range: offsets(twin, 6, 17), newText: "hello__deno" },
    {
      range: offsets(
        twin,
        twin.lastIndexOf("greet__deno"),
        twin.lastIndexOf("greet__deno") + 11,
      ),
      newText: "greet__deno: hello__deno",
    },
  ]]]);
  assertEquals(edits.length, 2);
  for (const edit of edits) {
    assertEquals(
      edit.newText,
      "hello",
      "the authored name, nothing built on a derived one",
    );
  }
});

Deno.test("an edit naming only invented text is dropped and counted", () => {
  const { deno } = bothTwins();
  const twin = deno.twin.text;
  const padded = twin.indexOf("export") - 1;
  const { edits, dropped } = renameEdits("hello", [[deno, [{
    range: offsets(twin, padded, padded + 1),
    newText: "x",
  }]]]);
  assertEquals(edits, []);
  assertEquals(dropped, 1, "reported rather than silently absent");
});

Deno.test("edits come back in authored order whatever order the twins came in", () => {
  const source = "one two\n";
  const twin = "two one\n";
  const map = new Mapping({
    source,
    twin,
    spans: spanning([
      { outStart: 0, length: 3, inStart: 4 },
      { outStart: 4, length: 3, inStart: 0 },
    ]),
  });
  const { edits } = renameEdits("x", [
    [map, [{ range: rangeOf(twin, "two"), newText: "x" }]],
    [map, [{ range: rangeOf(twin, "one"), newText: "x" }]],
  ]);
  assertEquals(edits.map((e) => slice(source, e.range)), ["one", "two"]);
});

Deno.test("two edits that overlap are refused rather than handed to the client", () => {
  // The protocol forbids overlapping edits in one array, and a client handed
  // them resolves a conflict whose cause it cannot see.
  const source = "abcdef";
  const map = new Mapping({ source, twin: source, spans: identity(6) });
  assertThrows(
    () =>
      renameEdits("x", [
        [map, [{ range: rangeOf(source, "abcd"), newText: "x" }]],
        [map, [{ range: rangeOf(source, "cdef"), newText: "x" }]],
      ]),
    RangeError,
    "overlap",
  );
});

Deno.test("two edits starting in one place but reaching different lengths are refused", () => {
  // Nested rather than merely crossing, which the dedupe sees before the overlap
  // check does. Keyed on the start alone these collapse into one edit and the
  // refusal never runs, so one of the two twins is silently ignored.
  const source = "abcdef";
  const map = new Mapping({ source, twin: source, spans: identity(6) });
  assertThrows(
    () =>
      renameEdits("x", [
        [map, [{ range: rangeOf(source, "abcd"), newText: "x" }]],
        [map, [{ range: rangeOf(source, "abcdef"), newText: "x" }]],
      ]),
    RangeError,
    "overlap",
  );
});

Deno.test("edits that only touch are not overlapping", () => {
  // The control for the refusal above. Written with the wrong comparison it
  // would refuse every pair of adjacent edits, which is the common case.
  const source = "abcdef";
  const map = new Mapping({ source, twin: source, spans: identity(6) });
  const { edits } = renameEdits("x", [
    [map, [{ range: rangeOf(source, "abc"), newText: "x" }]],
    [map, [{ range: rangeOf(source, "def"), newText: "x" }]],
  ]);
  assertEquals(edits.length, 2);
});

Deno.test("no twins at all is no edits, not a failure", () => {
  assertEquals(renameEdits("hello", []), { edits: [], dropped: 0 });
});

Deno.test("a file with no macros maps to itself, position for position", () => {
  const source = `function greet() {\n  return 1;\n}\n`;
  const map = new Mapping(pairFor(source, "deno"));
  assertEquals(map.twin.text, source, "nothing fired, so nothing moved");
  for (let line = 0; line < map.source.count; line++) {
    const width = map.source.endOf(line) - map.source.startOf(line);
    for (let ch = 0; ch < width; ch++) {
      const at: Position = { line, character: ch };
      assertEquals(map.toTwin(at), [at], `${line}:${ch}`);
      assertEquals(map.toSource(at), at, `${line}:${ch} back`);
    }
  }
});

Deno.test("a non-ascii source maps by characters, not by bytes", () => {
  // The reason the offsets are UTF-16 code units and the encoding is negotiated.
  // With a byte count anywhere in the chain every position after the first wide
  // character lands somewhere else.
  const source =
    `const 日本 = 1;\n[cfg(deno)]\nfunction greet() {\n  return 1;\n}\n`;
  const map = new Mapping(pairFor(source, "deno"));
  const at = rangeOf(source, "greet").start;
  assertEquals(at.line, 2, "the line the author sees it on");
  const images = map.toTwin(at);
  assertEquals(images.length, 1);
  const landed = map.twin.offsetAt(images[0]!);
  assertEquals(map.twin.text.slice(landed, landed + 5), "greet");
  assertEquals(map.toSource(images[0]!), at, "and straight back again");
});

Deno.test("the same document under utf-8 answers in utf-8 columns", () => {
  // The name sits on the same line as the wide characters, or both encodings
  // agree about its column and this measures nothing.
  const source = `const 日本 = 1; function greet() {}\n`;
  const pair = pairFor(source, "deno");
  const utf16 = new Mapping(pair);
  const utf8 = new Mapping(pair, "utf-8");
  const at = source.indexOf("greet");
  assertEquals(utf16.source.positionAt(at).character, at);
  assertEquals(
    utf8.source.positionAt(at, "utf-8").character,
    at + 4,
    "two three byte characters, four bytes more than code units",
  );
  assertEquals(
    utf8.toSource(utf8.twin.positionAt(at, "utf-8")),
    utf8.source.positionAt(at, "utf-8"),
    "a crossing under utf-8 stays in utf-8 on both sides",
  );
});

Deno.test("a mapping under one encoding disagrees with one under another", () => {
  // The control. If the encoding were ignored these two would be equal and every
  // law above would pass against one implementation used for all three.
  const source = `const 日本 = 1; function greet() {}\n`;
  const pair = pairFor(source, "deno");
  const at = pair.twin.indexOf("greet");
  const utf16 = new Mapping(pair), utf8 = new Mapping(pair, "utf-8");
  assertNotEquals(
    utf16.toSource(utf16.twin.positionAt(at)),
    utf8.toSource(utf8.twin.positionAt(at, "utf-8")),
  );
});

Deno.test("a range that runs backwards maps to nothing rather than to everything", () => {
  const source = "abcdef";
  const map = new Mapping({ source, twin: source, spans: identity(6) });
  const backwards: Range = {
    start: { line: 0, character: 4 },
    end: { line: 0, character: 1 },
  };
  assertEquals(map.toSourceRanges(backwards), []);
  assertEquals(map.toTwinRanges(backwards), []);
});

Deno.test("an empty range crosses as the position it names, not as nothing", () => {
  const source = "abcdef";
  const map = new Mapping({ source, twin: source, spans: identity(6) });
  const at: Position = { line: 0, character: 2 };
  const empty: Range = { start: at, end: at };
  assertEquals(map.toSourceRanges(empty), [{ start: at, end: at }]);
  assertEquals(map.toTwinRanges(empty), [{ start: at, end: at }]);
});

Deno.test("an empty range in text the printer invented still crosses to nothing", () => {
  // The point crossing goes through `toSource`, so the ratified drop survives
  // it: a position the author never typed answers with nothing, empty range or
  // not.
  const { deno } = bothTwins();
  const twin = deno.twin.text;
  const padded = twin.indexOf("export") - 1;
  assertEquals(twin[padded], " ", "aiming at a character the printer added");
  const at = deno.twin.positionAt(padded);
  assertEquals(deno.toSourceRanges({ start: at, end: at }), []);
});

Deno.test("a point diagnostic on a file with no macros survives the crossing", () => {
  const source = "const x = 1;\n";
  const map = new Mapping({
    source,
    twin: source,
    spans: identity(source.length),
  });
  const at: Position = { line: 0, character: 6 };
  const out = toSourceDiagnostic(map, URI, {
    range: { start: at, end: at },
    message: "expected a name",
  });
  assertEquals(out?.range, { start: at, end: at });
});

Deno.test("an authored range comes back as a twin range covering the same text", () => {
  const { deno } = bothTwins();
  const out = deno.toTwinRanges(rangeOf(TWO_ARMS, "greet", 0));
  assertEquals(out.length, 1);
  assertEquals(slice(deno.twin.text, out[0]!), "greet");
});

Deno.test("the mapping exposes the table it was built over, unchanged", () => {
  const pair = pairFor(TWO_ARMS, "deno");
  assertEquals(new Mapping(pair).spans, pair.spans);
});

Deno.test("the harness can fail, so the agreements above mean something", () => {
  const { deno } = bothTwins();
  assertNotEquals(deno.toTwin(rangeOf(TWO_ARMS, "greet", 0).start), []);
  assertNotEquals(deno.twin.text, TWO_ARMS, "the macro really did fire");
  let threw = false;
  try {
    assertEquals(deno.toTwin({ line: 0, character: 5 }), [{
      line: 0,
      character: 5,
    }]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
