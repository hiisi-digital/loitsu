//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The expander end to end: real macros, real text in, real text out, and the map
 * back checked against the authored bytes rather than against a remembered offset. */
import ts from "typescript";
import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { registry } from "../src/macro.ts";
import { expand, ROUNDS } from "../src/expand.ts";
import { outputOffsets, sourceOffset } from "../src/spans.ts";

const f = ts.factory;
const named = (e: ts.Expression) => ts.isIdentifier(e) ? e.text : "";

/** `[cfg(x)]` keeps its item when `x` is `deno`, and emits nothing otherwise. The
 * first attribute macro, and deliberately not a built-in. */
const cfg = {
  kind: "attribute",
  name: "cfg",
  expand: (args: readonly ts.Expression[], item: { node: ts.Statement }) =>
    named(args[0]!) === "deno" ? [item.node] : [],
} as const;

/** Returns the item beside something built from it, which is the shape that makes
 * one authored name appear twice in the output. */
const derive = {
  kind: "attribute",
  name: "derive",
  expand: (_args: readonly ts.Expression[], item: { node: ts.Statement }) => {
    const fn = item.node as ts.FunctionDeclaration;
    return [
      item.node,
      f.createFunctionDeclaration(
        undefined,
        undefined,
        f.createIdentifier(`${fn.name!.text}_twice`),
        undefined,
        [],
        undefined,
        // the ORIGINAL identifier node, reused. A macro naming what it was given is
        // the normal case and it is what makes deduplicating the marks necessary.
        f.createBlock([
          f.createReturnStatement(
            f.createCallExpression(fn.name!, undefined, []),
          ),
        ], true),
      ),
    ];
  },
} as const;

const include = {
  kind: "function",
  name: "include_str",
  expand: (args: readonly ts.Expression[]) =>
    f.createStringLiteral(`<${named(args[0]!)}>`),
} as const;

// deno-lint-ignore no-explicit-any
const reg = registry([cfg, derive, include] as any);

/** Every offset in `code` where `word` occurs. */
function every(code: string, word: string): number[] {
  const out: number[] = [];
  for (let at = code.indexOf(word); at >= 0; at = code.indexOf(word, at + 1)) {
    out.push(at);
  }
  return out;
}

/** The expanded text must be valid TypeScript. The marker comments are removed by
 * hand rather than by the compiler, and a strip that ate one byte too many would
 * otherwise show up as a wrong answer somewhere much further downstream. */
function parses(code: string): boolean {
  const sf = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
  // deno-lint-ignore no-explicit-any
  return ((sf as any).parseDiagnostics ?? []).length === 0;
}

Deno.test("a file with no macros comes back byte-identical and maps to itself", () => {
  const src = `const a = 1;\nfunction b() {\n  return a;\n}\n`;
  const out = expand(src, reg);
  assertEquals(out.code, src);
  assertEquals(out.diagnostics, []);
  for (let at = 0; at < src.length; at++) {
    assertEquals(sourceOffset(out.spans, at), at);
  }
});

Deno.test("cfg keeps its item, and the kept names still point at what was written", () => {
  const src = `[cfg(deno)]\nfunction kept(who: string) {\n  return who;\n}\n`;
  const out = expand(src, reg);
  assertStringIncludes(out.code, "kept");
  assertEquals(parses(out.code), true);
  for (const word of ["kept", "who"]) {
    for (const at of every(out.code, word)) {
      const back = sourceOffset(out.spans, at);
      assertEquals(
        src.slice(back!, back! + word.length),
        word,
        `${word} at ${at}`,
      );
    }
  }
});

Deno.test("cfg emitting nothing removes the item rather than guarding it", () => {
  // The difference between this and a runtime check: there is nothing left to run.
  const src = `const a = 1;\n[cfg(node)]\nfunction gone() {}\nconst b = 2;\n`;
  const out = expand(src, reg);
  assertEquals(out.code.includes("gone"), false);
  assertStringIncludes(out.code, "const a = 1;");
  assertStringIncludes(out.code, "const b = 2;");
  assertEquals(parses(out.code), true);
});

Deno.test("an authored name a macro wrote twice has two images, and both map back", () => {
  // The reason `outputOffsets` is plural. A rename driven off a singular reverse
  // reaches one of these and silently leaves the other behind.
  const src = `[derive(Twice)]\nfunction base() {\n  return 1;\n}\n`;
  const out = expand(src, reg);
  const authored = src.indexOf("base");
  const images = outputOffsets(out.spans, authored);
  assertEquals(
    images.length,
    2,
    `one authored name, two images, got ${images.length}`,
  );
  for (const at of images) assertEquals(out.code.slice(at, at + 4), "base");
  assertStringIncludes(out.code, "base_twice");
});

Deno.test("a call macro inside an attribute's item is expanded first", () => {
  // Innermost first, or the attribute would be handed an item still holding an
  // unexpanded call and every attribute macro would have to expand its own children.
  const src = `[cfg(deno)]\nfunction f() {\n  return include_str!(thing);\n}\n`;
  const out = expand(src, reg);
  assertStringIncludes(out.code, `"<thing>"`);
  assertEquals(out.code.includes("include_str"), false);
  assertEquals(parses(out.code), true);
});

Deno.test("a generated name maps nowhere, because nobody wrote it", () => {
  // `_twice` was built by the macro. Answering with a position would put a
  // diagnostic on a line the author never typed.
  const src = `[derive(Twice)]\nfunction base() {\n  return 1;\n}\n`;
  const out = expand(src, reg);
  const at = out.code.indexOf("base_twice") + "base".length;
  assertEquals(sourceOffset(out.spans, at), undefined);
});

Deno.test("an attribute with nothing beneath it is reported against the authored text", () => {
  const src = `const a = 1;\n[cfg(deno)]\n`;
  const out = expand(src, reg);
  assertEquals(out.diagnostics.length, 1);
  const d = out.diagnostics[0]!;
  assertEquals(src.slice(d.start, d.start + d.length), "[cfg(deno)]");
  assertStringIncludes(d.message, "nothing beneath it");
});

Deno.test("a name the registry does not know is left exactly as it was written", () => {
  const src = `const a = 1;\n[notAMacro(x)]\nconst b = 2;\n`;
  const out = expand(src, reg);
  assertEquals(out.code, src);
  assertEquals(out.diagnostics, []);
});

Deno.test("a macro expanding into itself is stopped and reported, not run forever", () => {
  const loop = registry([{
    kind: "function",
    name: "forever",
    expand: () =>
      f.createCallExpression(
        f.createNonNullExpression(f.createIdentifier("forever")),
        undefined,
        [],
      ),
    // deno-lint-ignore no-explicit-any
  } as any]);
  const out = expand(`const a = forever!();\n`, loop, { rounds: 5 });
  assertEquals(out.diagnostics.length, 1);
  assertStringIncludes(
    out.diagnostics[0]!.message,
    "did not settle in 5 rounds",
  );
});

Deno.test("several macros in one file all run, and every mapped byte is honest", () => {
  // The whole-file law rather than a spot check: whatever the table claims about an
  // output byte, the authored byte it names must be that same byte.
  const src =
    `const a = 1;\n\n[cfg(deno)]\nfunction kept(who: string) {\n  return who;\n}\n\n` +
    `[cfg(node)]\nfunction dropped() {}\n\n[derive(T)]\nfunction base() {\n` +
    `  return include_str!(thing);\n}\n`;
  const out = expand(src, reg);
  assertEquals(parses(out.code), true);
  let mapped = 0;
  for (let at = 0; at < out.code.length; at++) {
    const back = sourceOffset(out.spans, at);
    if (back === undefined) continue;
    mapped++;
    assertEquals(out.code[at], src[back], `output ${at} claims source ${back}`);
  }
  assertEquals(
    mapped > 0,
    true,
    "a table that maps nothing would pass the loop above",
  );
});

Deno.test("the text on both sides of an expansion still maps to itself", () => {
  // A splice that recorded only what it replaced would leave the rest of the file
  // unmapped, so every diagnostic outside a macro would land nowhere. The tail also
  // has to be shifted by however much the middle changed length, and it changed.
  const src =
    `const before = 1;\n[cfg(node)]\nfunction gone() {}\nconst after = 2;\n`;
  const out = expand(src, reg);
  for (const word of ["before", "after"]) {
    const at = out.code.indexOf(word);
    assertEquals(at >= 0, true, `${word} survived the expansion`);
    const back = sourceOffset(out.spans, at);
    assertEquals(
      back,
      src.indexOf(word),
      `${word} maps back to where it was written`,
    );
  }
});

Deno.test("a leaf inside a marked item does not collide with the item itself", () => {
  // Marks go on leaves only, and this is what that buys. `a;` prints back byte for
  // byte and so does the `a` inside it, so marking both would record two spans over
  // one region of the output, which is an overlap and is refused outright. The
  // failure would be a throw from the middle of an expansion, on a file whose only
  // sin was being short.
  const src = `const a = 1;\n[cfg(deno)]\na;\n`;
  const out = expand(src, reg);
  assertEquals(parses(out.code), true);
  // The printer puts a space where each marker comment was, and stripping the comment
  // does not take the space with it. That is cosmetic, the spans are measured after
  // the strip, and the twin is read by a checker rather than by a person.
  assertStringIncludes(out.code.replace(/\s+/g, ""), "a;");
  const at = out.code.lastIndexOf("a");
  assertEquals(sourceOffset(out.spans, at), src.lastIndexOf("a"));
});

Deno.test("a node claiming a source range it does not match is dropped, both ways", () => {
  // The printer never does this: a parsed literal comes back as the bytes it was
  // parsed from, verbatim. A macro can, and `ts.setTextRange` is the ordinary way it
  // happens, because attaching an original range is how a macro says where something
  // came from. Here it says so wrongly, in both the shapes that matter: a node whose
  // printed length differs from the range, and one whose length matches while the
  // bytes do not. Recording either would send a rename to bytes that are not there.
  const src = `const original = 1;\n[relabel(x)]\nconst target = 2;\n`;
  const liar = registry([{
    kind: "attribute",
    name: "relabel",
    expand: (_a: readonly ts.Expression[], item: { node: ts.Statement }) => {
      const decl = (item.node as ts.VariableStatement).declarationList
        .declarations[0]!;
      const at = decl.name.getStart(item.node.getSourceFile());
      const range = { pos: at, end: at + "target".length };
      return [
        // six bytes claimed, three printed
        f.createVariableStatement(undefined, [
          f.createVariableDeclaration(
            ts.setTextRange(f.createIdentifier("aaa"), range),
            undefined,
            undefined,
            f.createNumericLiteral("1"),
          ),
        ]),
        // six bytes claimed, six printed, none of them the same six
        f.createVariableStatement(undefined, [
          f.createVariableDeclaration(
            ts.setTextRange(f.createIdentifier("wrongo"), range),
            undefined,
            undefined,
            f.createNumericLiteral("2"),
          ),
        ]),
      ];
    },
    // deno-lint-ignore no-explicit-any
  } as any]);

  const out = expand(src, liar);
  assertStringIncludes(out.code, "aaa");
  assertStringIncludes(out.code, "wrongo");
  for (const word of ["aaa", "wrongo"]) {
    const at = out.code.indexOf(word);
    for (let i = 0; i < word.length; i++) {
      assertEquals(
        sourceOffset(out.spans, at + i),
        undefined,
        `${word} byte ${i} claimed a range it is not`,
      );
    }
  }
  // and the control: the same macro shape, telling the truth, does map
  const honest = registry([{
    kind: "attribute",
    name: "relabel",
    expand: (
      _a: readonly ts.Expression[],
      item: { node: ts.Statement },
    ) => [item.node],
    // deno-lint-ignore no-explicit-any
  } as any]);
  const ok = expand(src, honest);
  const at = ok.code.indexOf("target");
  assertEquals(sourceOffset(ok.spans, at), src.indexOf("target"));
});

Deno.test("the twin is exactly this, marker padding and all", () => {
  // Nothing else pins what comes out, only what it maps to, and the two are separate
  // claims. This one also holds down the choice to mark leaves rather than every
  // positioned node: both produce identical spans, so no mapping law can tell them
  // apart, and the difference is entirely in how much padding the twin carries. That
  // is a real cost and the only place it is visible is here.
  //
  // The spaces are where a marker comment was removed. They are not tidied up: doing
  // so means deciding which whitespace the printer inserted and which was already
  // there, and being wrong about that inside a template literal corrupts a string.
  const src = `[cfg(deno)]\nfunction f(a: number) {\n  return a;\n}\n`;
  assertEquals(
    expand(src, reg).code,
    "function  f ( a :  number ) {\n    return  a ;\n}\n",
  );
});

Deno.test("an attribute sees its item with the inner macros already run", () => {
  // Innermost first, stated as something an attribute can observe. `cfg` cannot: it
  // hands its item back whole, so running it before or after an inner call gives the
  // same text either way and the ordering is invisible. This one reads what it was
  // given, which is what an attribute macro is for.
  const seen: string[] = [];
  const watching = registry([include, {
    kind: "attribute",
    name: "watch",
    expand: (_a: readonly ts.Expression[], item: { node: ts.Statement }) => {
      seen.push(item.node.getText(item.node.getSourceFile()));
      return [item.node];
    },
    // deno-lint-ignore no-explicit-any
  }] as any);

  expand(`[watch(x)]\nconst v = include_str!(thing);\n`, watching);
  assertEquals(seen.length, 1);
  assertStringIncludes(
    seen[0]!,
    '"<thing>"',
    "the call was expanded before the attribute ran",
  );
  assertEquals(seen[0]!.includes("include_str"), false);
});

Deno.test("a dangling attribute does not stop the macros above it running", () => {
  // The dangling one is last in the file, and the round picks the last invocation, so
  // a selector that did not exclude it would pick it every round and return without
  // expanding anything. The file would come back untouched with one diagnostic on it,
  // which reads exactly like a file that had nothing to do.
  const src = `[cfg(node)]\nfunction gone() {}\nconst kept = 1;\n[cfg(deno)]\n`;
  const out = expand(src, reg);
  assertEquals(
    out.code.includes("gone"),
    false,
    "the real macro above it still ran",
  );
  assertStringIncludes(out.code, "const kept = 1;");
  assertEquals(out.diagnostics.length, 1);
});

Deno.test("the round limit is the number of expansions, not a suggestion", () => {
  // Counting rather than reading the message, because the message names the limit it
  // was given whether or not the loop honoured it.
  let ran = 0;
  const loop = registry([{
    kind: "function",
    name: "forever",
    expand: () => {
      ran++;
      return f.createCallExpression(
        f.createNonNullExpression(f.createIdentifier("forever")),
        undefined,
        [],
      );
    },
    // deno-lint-ignore no-explicit-any
  } as any]);
  const out = expand(`const a = forever!();\n`, loop, { rounds: 4 });
  assertEquals(ran, 4, "four rounds means the macro ran four times");
  assertEquals(out.diagnostics.length, 1);
  assertStringIncludes(
    out.diagnostics[0]!.message,
    "did not settle in 4 rounds",
  );
});

Deno.test("the harness can fail, so the agreements above mean something", () => {
  assertEquals(parses("function ("), false, "parses must be able to say no");
  assertEquals(every("aXbXc", "X"), [1, 3]);
});

Deno.test("a macro returning nodes parsed from another file is refused", async () => {
  // Building an expansion by parsing a template is the obvious implementation and
  // nothing in the type forbids it: `Expansion` is `readonly ts.Statement[]`.
  //
  // Left unguarded it is the worst failure this design has. The printer is handed
  // the user's file and slices it at the foreign node's positions, so `const q = 1;`
  // printed as `const  q  =  ge ;`: the literal `1` became two bytes taken from the
  // middle of the word `target` on the user's own line. And every law here passes
  // on it, because the span table then honestly maps `ge` back to the authored `ge`
  // it really was sliced from. A corrupt twin with a truthful map.
  const reg = registry([{
    kind: "attribute",
    name: "tpl",
    expand: () => [
      ...ts.createSourceFile(
        "macro.ts",
        "const q = 1;",
        ts.ScriptTarget.Latest,
        true,
      ).statements,
    ],
    // deno-lint-ignore no-explicit-any
  } as any]);

  const src = `const target = 0;\n[tpl(x)]\nconst z = 2;\n`;
  const out = expand(src, reg);
  // Not `includes("ge")`: `target` contains those bytes, so that assertion is true
  // of the untouched source too and would pass against no fix at all. What the
  // unguarded expander emitted was `const  q  =  ge ;`, the literal replaced by a
  // slice of the user's line, so that is what gets named.
  assertEquals(
    /const\s+q\s+=\s+ge/.test(out.code),
    false,
    "the literal was not replaced by a slice of the user's own line",
  );
  assertEquals(out.code, src, "nothing was spliced at all");
  assertEquals(out.diagnostics.length, 1, "and it was reported");
  assertStringIncludes(out.diagnostics[0]!.message, "another file");
  await Promise.resolve();
});

Deno.test("the control: the same macro built with the factory expands fine", () => {
  // Without this the refusal above could be a refusal of everything.
  const reg = registry([{
    kind: "attribute",
    name: "tpl",
    expand: () => [
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList([
          ts.factory.createVariableDeclaration(
            "q",
            undefined,
            undefined,
            ts.factory.createNumericLiteral(1),
          ),
        ], ts.NodeFlags.Const),
      ),
    ],
    // deno-lint-ignore no-explicit-any
  } as any]);
  const out = expand(`const target = 0;\n[tpl(x)]\nconst z = 2;\n`, reg);
  assertStringIncludes(out.code, "const q = 1;");
  assertEquals(out.diagnostics, []);
});

Deno.test("a constructed node claiming a range it did not come from gets no span", () => {
  // The byte comparison in `render` was called the verification the marking pass
  // leans on. It is necessary and it is not sufficient: it establishes that the
  // printed bytes match the claimed range, never that the range is where the node
  // came from. When the bytes coincide it passes and the span is still a lie.
  //
  // Here a macro claims the first `target`'s range for a node it prints in place of
  // the second. The bytes match exactly, so the comparison waves it through, and the
  // authored `target` on line one acquires an image it never had. A rename driven
  // off that edits a word the author never selected, which is the partial-rename
  // class the plural reverse map exists to prevent, arriving through the front door.
  const reg = registry([{
    kind: "attribute",
    name: "relabel",
    expand: (_args: readonly ts.Expression[], item: { node: ts.Statement }) => {
      const file = item.node.getSourceFile();
      const first = file.text.indexOf("target");
      const id = ts.factory.createIdentifier("target");
      ts.setTextRange(id, { pos: first, end: first + "target".length });
      return [ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList([
          ts.factory.createVariableDeclaration(
            id,
            undefined,
            undefined,
            ts.factory.createNumericLiteral(9),
          ),
        ], ts.NodeFlags.Const),
      )];
    },
    // deno-lint-ignore no-explicit-any
  } as any]);

  const src = `const target = 0;\n[relabel(x)]\nconst target2 = 2;\n`;
  const out = expand(src, reg);
  assertEquals(
    outputOffsets(out.spans, src.indexOf("target")),
    [src.indexOf("target")],
    "the authored `target` has only the image it actually had",
  );
});

/** How many JSX elements survive in `code`, read back in `dialect`. */
function jsxIn(code: string, fileName: string): number {
  const file = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  let found = 0;
  const count = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) found++;
    ts.forEachChild(node, count);
  };
  count(file);
  return found;
}

Deno.test("a tsx file expands as tsx, and as ts it comes apart", () => {
  // The dialect is not cosmetic and getting it wrong does not fail. Parsed as
  // `.ts`, `<div className="a">` is a comparison against `div`, then a property
  // access, then another comparison, and the printer writes that back out happily.
  // The twin then parses, and type-checks a program the author never wrote.
  //
  // The assertion is on the shape rather than on the spelling, because the printer
  // reformats JSX the same way it reindents everything else. What has to hold is
  // that a JSX element is still a JSX element.
  const reg = registry([{
    kind: "attribute",
    name: "cfg",
    expand: (args: readonly ts.Expression[], item: { node: ts.Statement }) =>
      named(args[0]!) === "deno" ? [item.node] : [],
    // deno-lint-ignore no-explicit-any
  } as any]);

  const src =
    `[cfg(deno)]\nexport function View() {\n  return <div className="a">text {x} more</div>;\n}\n`;

  const right = expand(src, reg, { fileName: "View.tsx" });
  assertEquals(jsxIn(right.code, "View.tsx"), 1, "the element survived");
  assertEquals(
    (ts.createSourceFile(
      "View.tsx",
      right.code,
      ts.ScriptTarget.Latest,
      true,
      // deno-lint-ignore no-explicit-any
    ) as any).parseDiagnostics.length,
    0,
    "and the twin parses",
  );

  // The control, and what makes the two assertions above mean something: the same
  // text through the default dialect is the mangling this exists to prevent.
  //
  // Each twin is read back in its own dialect, which is the only pairing that says
  // anything. Reading the `.ts` twin as `.tsx` finds an element too, because the
  // comparisons it was mangled into parse as JSX again in the other dialect. A
  // different element, of a different name, from text nobody wrote.
  const wrong = expand(src, reg, { fileName: "View.ts" });
  assertEquals(
    jsxIn(wrong.code, "View.ts"),
    0,
    "as ts there is no element at all, which is how it came apart",
  );
  assertNotEquals(right.code, wrong.code);
  assertEquals(
    jsxIn(right.code, "View.tsx") > jsxIn(wrong.code, "View.ts"),
    true,
    "and the tsx path is the one that kept it",
  );
});

Deno.test("a tsx file with no macros is left exactly as written", () => {
  const src = `const e = <div className="a">text</div>;\n`;
  assertEquals(expand(src, registry([]), { fileName: "a.tsx" }).code, src);
});

Deno.test("the round budget still works now that it shares a parameter", () => {
  // `rounds` moved from a positional argument into the options object, and a
  // caller passing `{ fileName }` alone must still get the default rather than
  // zero rounds.
  const loop = registry([{
    kind: "function",
    name: "forever",
    expand: () => ts.factory.createIdentifier("forever!()"),
    // deno-lint-ignore no-explicit-any
  } as any]);
  const capped = expand(`const a = forever!();\n`, loop, { rounds: 3 });
  assertStringIncludes(capped.diagnostics.at(-1)!.message, "3 rounds");

  const named2 = expand(`const a = forever!();\n`, loop, { fileName: "a.ts" });
  assertStringIncludes(
    named2.diagnostics.at(-1)!.message,
    `${ROUNDS} rounds`,
    "no rounds given means the default, not none",
  );
});

Deno.test("a leaf whose printed bytes differ from its own source range is dropped", () => {
  // What the byte comparison still catches once provenance is checked, and the
  // reason it is not redundant. A numeric separator is the case: `1_000` is five
  // bytes in the source and the printer emits four, on a node that fully belongs to
  // this file. Provenance passes, because it does belong here. Retargeting a parsed
  // node does not reach this, because the printer honours whatever range it is
  // given and emits the bytes actually at it, so the mark stays truthful.
  //
  // Unguarded, the mark claims five source bytes for four printed ones and every
  // position after the first is off by one against the underscore.
  const src = `const a = 1;\n[keep(x)]\nconst big = 1_000;\n`;
  const reg = registry([{
    kind: "attribute",
    name: "keep",
    expand: (
      _a: readonly ts.Expression[],
      item: { node: ts.Statement },
    ) => [item.node],
    // deno-lint-ignore no-explicit-any
  } as any]);

  const out = expand(src, reg);
  assertStringIncludes(out.code, "1000", "the printer dropped the separator");
  assertEquals(out.code.includes("1_000"), false);

  const at = out.code.indexOf("1000");
  for (let i = 0; i < 4; i++) {
    assertEquals(
      sourceOffset(out.spans, at + i),
      undefined,
      `byte ${i} of the reprinted number claims nothing`,
    );
  }

  // The control: the name beside it, whose bytes do survive printing, still maps.
  const name = out.code.lastIndexOf("big");
  assertEquals(sourceOffset(out.spans, name), src.indexOf("big"));
});
