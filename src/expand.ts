//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Running the macros, and keeping a map from what came out back to what was written.
 *
 * The whole design follows from two facts established against the compiler and
 * pinned in `tests/printer_test.ts`. A node a macro builds carries no position,
 * so `sentinel.ts` has to recover one from the printed text. And `ts.transform`
 * discards a synthetic comment made before it, even an identity transform, so
 * the obvious way to rewrite a tree cannot be used at all.
 *
 * What is left is a textual splice. One invocation is expanded per round, the
 * printed replacement is spliced into the text, and the round's own span table
 * is composed onto what came before. Everything outside the replaced range is
 * byte-identical and maps to itself, which is most of a file and costs nothing
 * to say.
 *
 * Expanding one at a time rather than all at once buys the property that makes
 * this worth doing: a macro whose expansion contains another invocation gets
 * that one expanded too, because the next round simply reads the new text. The
 * mapping composes along with it, so a name written once and generated through
 * three rounds still points back at where it was written.
 *
 * @module
 */

import ts from "typescript";
import type { Registry } from "./macro.ts";
import { type Use, uses } from "./syntax.ts";
import {
  compose,
  identity,
  type Run,
  type Span,
  spanning,
  type SpanTable,
} from "./spans.ts";
import { Marker, strip } from "./sentinel.ts";

/** Something to say about a run of the authored text.
 *
 * A `Run` rather than a pair of numbers, so `sourceRuns` and `outputRuns` apply to a
 * diagnostic directly: carrying one across the twin boundary in either direction is
 * the same operation as carrying any other region, and it should not need its own. */
export interface Diagnostic extends Run {
  readonly message: string;
}

/** What one file expanded to, and how to get back from it. */
export interface Expanded {
  /** The text a checker reads. */
  readonly code: string;
  /** `code` back to what was authored. */
  readonly spans: SpanTable;
  /** Positioned in the authored text, never in `code`, because that is the text
   * whoever reads them is looking at. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * How many rounds before an expansion is called non-terminating.
 *
 * A macro that expands into a call to itself is a real mistake and produces an
 * unbounded loop, so there is a limit; it is not a budget and a file legitimately
 * needing this many rounds does not exist.
 */
export const ROUNDS = 1000;

/** A leaf that came from the text: nothing below it, and a position of its own.
 *
 * These are what carry the mapping. A statement reprints with the printer's
 * indentation rather than the author's, so its length no longer matches what it
 * came from and a span over it would be a lie. A name comes back byte for byte.
 */
function leaves(node: ts.Node, into: Set<ts.Node>): void {
  let children = 0;
  ts.forEachChild(node, (child) => {
    children++;
    leaves(child, into);
  });
  if (children === 0 && node.pos >= 0 && node.end > node.pos) into.add(node);
}

/** Mark every mappable leaf under `nodes`, and say what each was marked as.
 *
 * Marking generously is safe because `splice` verifies each one: a mark whose
 * printed bytes differ from the bytes it claims is dropped rather than recorded.
 * So the choice of what to mark is a question of yield, never of soundness.
 */
function markLeaves(
  nodes: readonly ts.Node[],
  marker: Marker,
  src: ts.SourceFile,
): void {
  // A set, because a macro that derives something from an item routinely reuses that
  // item's own nodes inside what it built: the derived call below names the original
  // function by handing back the very identifier node it was given. Marking that node
  // twice puts two comment pairs on it and yields two spans over one region, which is
  // an overlap and gets refused. Marked once, it is simply printed twice, and comes
  // back as two images of one authored offset, which is what a rename needs.
  const found = new Set<ts.Node>();
  for (const node of nodes) leaves(node, found);
  for (const leaf of found) {
    const start = leaf.getStart(src), length = leaf.getEnd() - start;
    if (length > 0) marker.mark(leaf, start, length);
  }
}

/** Print `nodes`, then take the markers back out and say where each landed. */
function render(
  nodes: readonly ts.Node[],
  src: ts.SourceFile,
  marker: Marker,
): {
  text: string;
  spans: readonly { outStart: number; length: number; inStart: number }[];
} {
  const printer = ts.createPrinter({
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  });
  const printed = nodes
    .map((n) => printer.printNode(ts.EmitHint.Unspecified, n, src))
    .join("\n");
  const { text, found } = strip(printed, marker);

  const source = src.getFullText();
  const by = new Map(marker.marked.map((m) => [m.id, m]));
  const spans: Span[] = [];
  for (const f of found) {
    const mark = by.get(f.id);
    if (mark === undefined) continue;
    // The verification the marking pass leans on, and the whole of it. A node whose
    // printed bytes are not the bytes it claims has no honest span: a rename driven
    // off one would replace a region it never measured. Comparing the bytes settles
    // the length too, so a separate length check can never be the thing that
    // decides, and a condition that decides nothing is one more line to keep true.
    const from = source.slice(
      mark.sourceStart,
      mark.sourceStart + mark.sourceLength,
    );
    if (text.slice(f.outStart, f.outStart + f.length) !== from) continue;
    spans.push({
      outStart: f.outStart,
      length: f.length,
      inStart: mark.sourceStart,
    });
  }
  spans.sort((a, b) => a.outStart - b.outStart);
  return { text, spans };
}

/**
 * Replace `[from, to)` of `text` with `replacement`, and say what still maps.
 *
 * The two untouched sides map to themselves, shifted by however much the middle
 * changed length. The middle maps by whatever the sentinels recovered, which is
 * usually the names inside it and nothing else.
 */
function splice(
  text: string,
  from: number,
  to: number,
  replacement: { text: string; spans: readonly Span[] },
): { code: string; spans: SpanTable } {
  const code = text.slice(0, from) + replacement.text + text.slice(to);
  const after = from + replacement.text.length;
  const spans: Span[] = [];
  if (from > 0) spans.push({ outStart: 0, length: from, inStart: 0 });
  for (const s of replacement.spans) {
    spans.push({
      outStart: from + s.outStart,
      length: s.length,
      inStart: s.inStart,
    });
  }
  if (to < text.length) {
    spans.push({ outStart: after, length: text.length - to, inStart: to });
  }
  return { code, spans: spanning(spans) };
}

/** The invocation to expand this round: the last one in the text.
 *
 * Last rather than first, because a nested invocation starts after the one
 * containing it, so taking the last takes the innermost. An outer attribute then
 * receives an item whose inner macros have already run, which is the order a
 * reader expects and the only one under which an attribute can inspect what it
 * is given.
 */
function next(found: readonly Use[], reg: Registry): Use | undefined {
  let pick: Use | undefined;
  for (const use of found) {
    const known = use.form === "attribute"
      ? reg.attribute(use.name) !== undefined
      : use.form === "call"
      ? reg.function(use.name) !== undefined
      : false;
    if (known && (pick === undefined || use.start > pick.start)) pick = use;
  }
  return pick;
}

/** Expand every macro in `text` until none is left. */
export function expand(
  text: string,
  reg: Registry,
  rounds: number = ROUNDS,
): Expanded {
  const diagnostics: Diagnostic[] = [];
  let code = text;
  let spans = identity(text.length);

  // Reported once, against the authored text, before anything moves. A dangling
  // attribute cannot expand, so it survives every round and would otherwise be
  // reported once per round at a position that drifts.
  for (const use of uses(text, reg)) {
    if (use.form !== "dangling") continue;
    diagnostics.push({
      start: use.start,
      length: use.end - use.start,
      message: `[${use.name}(...)] has nothing beneath it to expand`,
    });
  }

  for (let round = 0; round < rounds; round++) {
    const use = next(uses(code, reg), reg);
    if (use === undefined) return { code, spans, diagnostics };

    const marker = new Marker();
    let from: number,
      to: number,
      produced: readonly ts.Node[],
      src: ts.SourceFile;

    if (use.form === "attribute") {
      const macro = reg.attribute(use.name)!;
      src = use.target.getSourceFile();
      from = use.start;
      to = use.target.getEnd();
      produced = macro.expand(use.args, {
        node: use.target,
        attribute: { start: use.start, end: use.end },
      });
    } else if (use.form === "call") {
      const macro = reg.function(use.name)!;
      src = use.node.getSourceFile();
      from = use.start;
      to = use.end;
      produced = [macro.expand(use.args)];
    } else {
      // dangling: reported above, and there is nothing to run
      return { code, spans, diagnostics };
    }

    markLeaves(produced, marker, src);
    const spliced = splice(code, from, to, render(produced, src, marker));
    code = spliced.code;
    spans = compose(spans, spliced.spans);
  }

  diagnostics.push({
    start: 0,
    length: 0,
    message:
      `expansion did not settle in ${rounds} rounds; a macro likely expands into itself`,
  });
  return { code, spans, diagnostics };
}
