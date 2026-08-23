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
        `a span starting at ${span.outStart} overlaps the one ending at ${reach}, `
          + "so a position inside the overlap has two answers",
      );
    }
    if (span.inStart < 0) {
      throw new RangeError(`a span from source offset ${span.inStart} starts before the text`);
    }
    reach = span.outStart + span.length;
  }
  return { spans: [...spans] };
}

/** The identity table for a transform that moved nothing, over a text of `length` bytes. */
export function identity(length: number): SpanTable {
  return length === 0 ? { spans: [] } : spanning([{ outStart: 0, length, inStart: 0 }]);
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
export function sourceOffset(table: SpanTable, out: number): number | undefined {
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
