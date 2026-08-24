//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Carrying a position from the text the checker read back to the text you wrote.
 *
 * Neutralising an attribute costs one byte and moves nothing, so for a while it
 * looked as though positions could simply be trusted. They cannot. A macro that
 * expands adds lines, and from the first added line every position below it in
 * the output names a different place in the source. Trusting them there reports
 * every later diagnostic against the wrong line, silently, which is the failure
 * this module exists to make impossible.
 *
 * TypeScript has machinery for this and it is the wrong machinery. Its
 * `createSourceMapSource`, `setSourceMapRange` and `setOriginalNode` are read by
 * the *emitter*, so they give the built JavaScript a correct map back to the
 * authored TypeScript, which is what a debugger and a stack trace need. A
 * diagnostic is not emitted. It is reported against the source file the checker
 * was handed, so nothing in that machinery touches it.
 *
 * What replaces it is exact rather than recovered. A transform builds its output
 * and therefore knows, at the moment it writes each piece, which input range the
 * piece came from. Recording those pairs as it goes gives a mapping with no
 * inference in it. That is all a source map is; this one is simply never
 * serialised, because the only consumer is in the same process.
 *
 * @module
 */

/** One contiguous run of output that came from one contiguous run of input. */
export interface Span {
  /** Where the run starts in the text the checker read. */
  readonly outStart: number;
  /** How long the run is in that text. */
  readonly length: number;
  /** Where the run starts in the text that was written. */
  readonly inStart: number;
}

/**
 * An ordered, non-overlapping set of spans covering one transformed text.
 *
 * Ordered by `outStart`, which is what makes the lookup a binary search rather
 * than a scan, and which {@link spanning} checks rather than assumes.
 */
export interface SpanTable {
  readonly spans: readonly Span[];
}

/**
 * Build a table, refusing anything that would make a lookup lie.
 *
 * @throws {RangeError} on a span that is empty, that starts before the previous
 * one ends, or that runs backwards. Each of those makes at least one output
 * position resolve to a source position it did not come from, and a mapping that
 * is wrong in one place cannot be told from one that is right by anything
 * downstream of it.
 */
export function spanning(spans: readonly Span[]): SpanTable {
  let reach = 0;
  for (const span of spans) {
    if (span.length <= 0) {
      throw new RangeError(`a span covering ${span.length} bytes maps nothing`);
    }
    if (span.outStart < reach) {
      throw new RangeError(
        `a span starting at ${span.outStart} overlaps the one ending at ${reach}, ` +
          "so a position inside the overlap has two answers",
      );
    }
    if (span.inStart < 0) {
      throw new RangeError(
        `a span from source offset ${span.inStart} starts before the text`,
      );
    }
    reach = span.outStart + span.length;
  }
  return { spans: [...spans] };
}

/** The identity table for a transform that moved nothing, over a text of `length` bytes. */
export function identity(length: number): SpanTable {
  return length === 0
    ? { spans: [] }
    : spanning([{ outStart: 0, length, inStart: 0 }]);
}

/**
 * Where an output offset came from, or `undefined` when it came from nowhere.
 *
 * `undefined` is a real answer and not a failure: a macro that expands writes
 * bytes that were never in the source, and a diagnostic landing on one of those
 * has no authored position to name. Reporting it against the nearest line would
 * be a guess wearing a citation, so it is refused instead and the caller decides
 * what to say.
 */
export function sourceOffset(
  table: SpanTable,
  out: number,
): number | undefined {
  const { spans } = table;
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const span = spans[mid]!;
    if (out < span.outStart) high = mid - 1;
    else if (out >= span.outStart + span.length) low = mid + 1;
    else return span.inStart + (out - span.outStart);
  }
  return undefined;
}

/** A contiguous run of bytes, in whichever text the function taking it names. */
export interface Run {
  readonly start: number;
  readonly length: number;
}

/**
 * Every place an authored offset ended up, in ascending output order.
 *
 * Plural, and that is the whole point. An expansion is a list of items, so a
 * macro that derives something returns the item it was handed alongside what it
 * derived, and the derived part names the authored symbol. One authored offset
 * then has several images, and a singular answer edits one of them and leaves
 * the rest, which is a partial rename that nothing reports.
 *
 * Empty is a real answer, the mirror of `undefined` from {@link sourceOffset}:
 * an authored offset inside something a macro deleted has no image, and a caller
 * that edits nothing there is correct.
 *
 * Ascending, and without sorting: {@link spanning} refuses a span starting before
 * the previous one ends, so the table is ordered by output position and walking it
 * produces images in that order already. A sort here would be unreachable, and an
 * unreachable sort is a claim no test can hold.
 *
 * Linear in the number of spans, because the table is ordered by output position
 * and this asks the other question. Building a second index would be the fix if
 * it ever mattered, and per file it does not.
 */
export function outputOffsets(table: SpanTable, source: number): number[] {
  const out: number[] = [];
  for (const span of table.spans) {
    const delta = source - span.inStart;
    if (delta >= 0 && delta < span.length) out.push(span.outStart + delta);
  }
  return out;
}

/**
 * The authored runs an output run covers, in order, with nothing inferred.
 *
 * A run rather than a range, and a list rather than one answer, because an output
 * run routinely covers bytes that came from nowhere. `greet__deno` in a twin is
 * five authored bytes followed by six the expander invented, so the honest answer
 * is one run of five, not a range of eleven and not a refusal.
 *
 * Returning a hull instead would be a guess in exactly the case that matters: two
 * authored runs with a gap between them have no single range containing only
 * them, and a caller handed one would edit the text in between.
 */
export function sourceRuns(table: SpanTable, out: Run): Run[] {
  if (out.length <= 0) return [];
  const end = out.start + out.length;
  const runs: Run[] = [];
  for (const span of table.spans) {
    const spanEnd = span.outStart + span.length;
    if (spanEnd <= out.start) continue;
    if (span.outStart >= end) break;
    const from = Math.max(span.outStart, out.start);
    const to = Math.min(spanEnd, end);
    runs.push({
      start: span.inStart + (from - span.outStart),
      length: to - from,
    });
  }
  // In authored order, which is not output order: a macro may reorder what it
  // was handed, and the table is ordered by output position. Merging without
  // sorting would then leave two halves of one authored word unjoined, which
  // reads as two separate authored regions and is a different claim.
  runs.sort((a, b) => a.start - b.start);
  return merge(runs);
}

/**
 * Every output run an authored run maps to, in ascending output order.
 *
 * The plural counterpart of {@link sourceRuns}, and what a rename is answered
 * with: the authored range of a name goes in, and every place the expansion
 * wrote that name comes out, so an edit can be applied to all of them at once.
 *
 * Ascending for the same reason {@link outputOffsets} is, and with no sort for
 * the same reason. {@link sourceRuns} does sort, because its output is in
 * authored order and the table is not.
 */
export function outputRuns(table: SpanTable, source: Run): Run[] {
  if (source.length <= 0) return [];
  const end = source.start + source.length;
  const runs: Run[] = [];
  for (const span of table.spans) {
    const spanEnd = span.inStart + span.length;
    if (spanEnd <= source.start || span.inStart >= end) continue;
    const from = Math.max(span.inStart, source.start);
    const to = Math.min(spanEnd, end);
    runs.push({
      start: span.outStart + (from - span.inStart),
      length: to - from,
    });
  }
  return merge(runs);
}

/** Join runs that touch, so a table split for its own reasons does not leak that
 * split into an answer. Two spans describing adjacent bytes of one authored word
 * are one run to anybody asking. */
function merge(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.start + last.length === run.start) {
      out[out.length - 1] = {
        start: last.start,
        length: last.length + run.length,
      };
    } else out.push(run);
  }
  return out;
}
