//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Finding macro invocations in a source file.
 *
 * Both forms are found by parsing rather than by matching text. An `!` inside a
 * string and a `[` opening a genuine array are both common, and only the parser
 * reliably knows which is which.
 *
 * An attribute is an array literal holding exactly one call, standing alone as
 * a statement, with something after it to attach to. Nothing else in ordinary
 * code has that shape: an array literal evaluated and discarded is dead code
 * nobody writes. A name that is not in the registry is left alone anyway, so
 * somebody who does write one gets their code back untouched.
 *
 * The last statement in a block cannot be an attribute, because an attribute
 * with nothing beneath it attaches to nothing. That is reported rather than
 * ignored, since it is nearly always a line that drifted rather than a
 * deliberate no-op.
 *
 * @module
 */

import ts from "typescript";

/**
 * An offset into one source text, branded so offsets do not cross files.
 *
 * Counted in UTF-16 code units, which is what a JavaScript string index is and
 * what TypeScript reports from `getStart`. It is not a byte count and the two
 * differ the moment the text stops being ascii: in `const \u65e5\u672c = 1;` the
 * name ends at offset 8 and at byte 12. Converting to bytes anywhere would move
 * every position in every non-ascii file.
 */
export type Offset = number & { readonly __offset: unique symbol };

/** Assert an offset belongs to `text`, which is the only way to make one. */
export function offsetIn(text: string, at: number): Offset {
  if (!Number.isInteger(at) || at < 0 || at > text.length) {
    throw new RangeError(
      `offset ${at} is outside a source text of ${text.length} characters`,
    );
  }
  return at as Offset;
}

/** One `[name(...args)]` and the statement it attaches to. */
export interface AttributeUse {
  readonly form: "attribute";
  readonly name: string;
  readonly args: readonly ts.Expression[];
  readonly start: Offset;
  readonly end: Offset;
  /** The statement below it. */
  readonly target: ts.Statement;
}

/** One `name!(...args)` standing where an expression goes. */
export interface CallUse {
  readonly form: "call";
  readonly name: string;
  readonly args: readonly ts.Expression[];
  readonly start: Offset;
  readonly end: Offset;
  readonly node: ts.CallExpression;
}

/** An attribute with nothing beneath it, which cannot expand into anything. */
export interface DanglingAttribute {
  readonly form: "dangling";
  readonly name: string;
  readonly start: Offset;
  readonly end: Offset;
}

/**
 * One place a macro is used, in whichever of the three shapes it took.
 *
 * An attribute with something beneath it to expand, a call, or an attribute
 * with nothing beneath it. The last is kept rather than dropped because an
 * attribute expanding into nothing is a mistake worth reporting, and a scanner
 * that discarded it would have nothing to report it from.
 */
export type Use = AttributeUse | CallUse | DanglingAttribute;

/** The callee's name, when the expression is a call to a plain identifier. */
function calleeName(
  call: ts.CallExpression,
  src: ts.SourceFile,
): string | undefined {
  const callee = call.expression;
  const bare = ts.isNonNullExpression(callee) ? callee.expression : callee;
  return ts.isIdentifier(bare) ? bare.getText(src) : undefined;
}

/** True when this statement is `[someCall()]` and nothing more. */
function asAttributeCall(s: ts.Statement): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(s)) return undefined;
  const e = s.expression;
  if (!ts.isArrayLiteralExpression(e) || e.elements.length !== 1) {
    return undefined;
  }
  const only = e.elements[0];
  return only !== undefined && ts.isCallExpression(only) ? only : undefined;
}

/** Which TypeScript dialect a file is written in.
 *
 * `.tsx` is not a variant spelling of `.ts`. The two disagree about what `<` means
 * at the head of an expression, so a file parsed in the wrong one does not fail: it
 * parses as something else entirely, and a JSX element comes apart into comparisons.
 */
export type Dialect = "ts" | "tsx";

/** The dialect a file name implies. Anything that is not `.tsx` is `ts`, which is
 * what the compiler itself assumes for an unknown extension. */
export function dialectOf(fileName: string): Dialect {
  return fileName.endsWith(".tsx") ? "tsx" : "ts";
}

/**
 * Every macro invocation in `text`, in source order.
 *
 * @param known decides which names are macros. A name it does not recognise is
 * not an invocation, so ordinary code that happens to share a shape is left as
 * it was written.
 */
export function uses(
  text: string,
  known: { attribute(name: string): unknown; function(name: string): unknown },
  fileName = "loitsu.ts",
): readonly Use[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: Use[] = [];

  const scanStatements = (list: readonly ts.Statement[]): void => {
    list.forEach((statement, i) => {
      const call = asAttributeCall(statement);
      if (call === undefined) return;
      const name = calleeName(call, src);
      if (name === undefined || known.attribute(name) === undefined) return;

      const start = offsetIn(text, statement.getStart(src));
      const end = offsetIn(text, statement.getEnd());
      const target = list[i + 1];

      found.push(
        target === undefined ? { form: "dangling", name, start, end } : {
          form: "attribute",
          name,
          args: call.arguments,
          start,
          end,
          target,
        },
      );
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      scanStatements(node.statements);
    }
    if (ts.isCallExpression(node) && ts.isNonNullExpression(node.expression)) {
      const name = calleeName(node, src);
      if (name !== undefined && known.function(name) !== undefined) {
        found.push({
          form: "call",
          name,
          args: node.arguments,
          start: offsetIn(text, node.getStart(src)),
          end: offsetIn(text, node.getEnd()),
          node,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  return found.sort((a, b) => a.start - b.start);
}
