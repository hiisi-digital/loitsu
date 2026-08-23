/**
 * What the recogniser must and must not treat as a macro invocation.
 *
 * The must-nots carry as much weight as the musts here. An attribute is an
 * array literal used as a statement, which is a shape ordinary code can produce
 * by accident, so every law that says "this is an attribute" is paired with one
 * saying "this looks like one and is not".
 *
 * @module
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import ts from "typescript";
import { registry } from "../src/macro.ts";
import { type Use, uses } from "../src/syntax.ts";

/** A registry that knows `cfg` as an attribute and `env` as a call. */
const known = registry([
  { kind: "attribute", name: "cfg", expand: (_a, item) => [item.node] },
  { kind: "function", name: "env", expand: () => ts.factory.createStringLiteral("") },
]);

const find = (source: string): readonly Use[] => uses(source, known);

Deno.test("an attribute above an item attaches to the item", () => {
  const found = find(`[cfg(deno)]\nexport function readFile(): void {}\n`);
  assertEquals(found.length, 1);
  const [use] = found;
  assert(use !== undefined && use.form === "attribute", "expected one attribute");
  assertEquals(use.name, "cfg");
  assertEquals(use.target.kind, ts.SyntaxKind.FunctionDeclaration);
});

Deno.test("an attribute inside a body attaches to the next statement", () => {
  const found = find(`function b() {\n  [cfg(deno)]\n  const x = 1;\n  return x;\n}\n`);
  const [use] = found;
  assert(use !== undefined && use.form === "attribute");
  assertEquals(use.target.kind, ts.SyntaxKind.VariableStatement);
});

Deno.test("a name the registry does not know is not an attribute", () => {
  // somebody's own code, shaped like an attribute by coincidence. it is theirs.
  assertEquals(find(`[sideEffect()]\nexport function f(): void {}\n`).length, 0);
});

Deno.test("an array that is not a statement is not an attribute", () => {
  assertEquals(find(`const notAnAttribute = [cfg(deno)];\n`).length, 0);
});

Deno.test("an array of more than one element is not an attribute", () => {
  assertEquals(find(`[cfg(deno), cfg(node)]\nexport function f(): void {}\n`).length, 0);
});

Deno.test("an attribute with nothing beneath it is reported, not ignored", () => {
  const found = find(`function b() {\n  const x = 1;\n  [cfg(deno)]\n}\n`);
  const [use] = found;
  assert(use !== undefined && use.form === "dangling", "a dangling attribute must be reported");
  assertEquals(use.name, "cfg");
});

Deno.test("a bang call is found; the same call without one is not", () => {
  const withBang = find(`const a = env!("HOME");\n`);
  assertEquals(withBang.length, 1);
  assert(withBang[0]?.form === "call");

  // the bang is the entire difference between an invocation and a normal call
  assertEquals(find(`const a = env("HOME");\n`).length, 0);
});

Deno.test("offsets point at the invocation itself", () => {
  const source = `[cfg(deno)]\nexport function f(): void {}\n`;
  const [use] = find(source);
  assert(use !== undefined);
  assertEquals(source.slice(use.start, use.end), "[cfg(deno)]");
});

Deno.test("two macros of one kind cannot share a name", () => {
  assertThrows(
    () =>
      registry([
        { kind: "attribute", name: "cfg", expand: (_a, i) => [i.node] },
        { kind: "attribute", name: "cfg", expand: () => [] },
      ]),
    Error,
    "two attribute macros are named cfg",
  );
});

Deno.test("the harness can fail, so the laws above mean something", () => {
  // without this, a recogniser that returned nothing at all would pass every
  // must-not law above and half the must laws would be the only thing catching it.
  assert(find(`[cfg(deno)]\nexport function f(): void {}\n`).length > 0);
  assertEquals(find(``).length, 0);
});
