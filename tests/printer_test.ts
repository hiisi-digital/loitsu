//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * What TypeScript's printer does with a synthetic comment, which is what the
 * whole sentinel mechanism rests on.
 *
 * These are facts about a dependency rather than about this package, so they are
 * asserted rather than assumed: a toolchain bump that changed any of them would
 * turn every recovered position silently wrong, and nothing else here would
 * notice. Each one closed a design question, and the last one closed it in the
 * expensive direction.
 */
import ts from "typescript";
import { assertEquals, assertStringIncludes } from "@std/assert";

const SOURCE = `function greet(who: string) {\n  return who;\n}\n`;

const parsed = () =>
  ts.createSourceFile("a.ts", SOURCE, ts.ScriptTarget.ESNext, true);
const printer = () => ts.createPrinter({ removeComments: false });

/** The parameter's name: a leaf, several levels down, inside a node nothing touched. */
const leafOf = (sf: ts.SourceFile) =>
  (sf.statements[0] as ts.FunctionDeclaration).parameters[0]!
    .name as ts.Identifier;

const mark = (node: ts.Node) =>
  ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    "MARK",
  );

Deno.test("the printer descends into a parsed node rather than reprinting its text", () => {
  // If it copied the original text for anything it had not changed, a mark on an
  // inner leaf would vanish and only whole replaced items could ever be located.
  const sf = parsed();
  mark(leafOf(sf));
  assertStringIncludes(
    printer().printNode(ts.EmitHint.Unspecified, sf.statements[0]!, sf),
    "/*MARK*/",
  );
});

Deno.test("printing the whole file descends the same way", () => {
  const sf = parsed();
  mark(leafOf(sf));
  assertStringIncludes(printer().printFile(sf), "/*MARK*/");
});

Deno.test("ts.transform discards a mark made before it, even doing nothing", () => {
  // This is the one that decided the expander's shape. A transformer is the obvious
  // way to rewrite a tree and it cannot be used here: the marks do not survive it,
  // an identity transform loses them just as thoroughly as a real one, and the
  // failure is silent, since the output is valid code with no positions in it.
  const sf = parsed();
  mark(leafOf(sf));
  const out = ts.transform(sf, [() => (s: ts.SourceFile) => s])
    .transformed[0] as ts.SourceFile;
  assertEquals(printer().printFile(out).includes("/*MARK*/"), false);
});

Deno.test("marking after the transform does survive, which is the escape if one is ever needed", () => {
  const sf = parsed();
  const out = ts.transform(sf, [() => (s: ts.SourceFile) => s])
    .transformed[0] as ts.SourceFile;
  mark(leafOf(out));
  assertStringIncludes(printer().printFile(out), "/*MARK*/");
});

Deno.test("an identifier prints back the bytes it was parsed from", () => {
  // Why leaves are what carry the mapping. A statement reprints with the printer's
  // own indentation and its length no longer matches the source it came from, so a
  // span over one would be a lie. A name comes back byte-identical.
  const sf = parsed();
  const leaf = leafOf(sf);
  const printed = printer().printNode(ts.EmitHint.Unspecified, leaf, sf);
  assertEquals(printed, SOURCE.slice(leaf.getStart(sf), leaf.getEnd()));
  assertEquals(printed, "who");
});

Deno.test("a reindented statement does not, which is the control for the above", () => {
  // Without this, the claim about identifiers would read as a claim about every node.
  const sf = parsed();
  const body = (sf.statements[0] as ts.FunctionDeclaration).body!;
  const printed = printer().printNode(ts.EmitHint.Unspecified, body, sf);
  assertEquals(
    printed === SOURCE.slice(body.getStart(sf), body.getEnd()),
    false,
  );
});
