/**
 * Constructors both span suites build their tables from.
 *
 * Shared rather than repeated because the lint gate is right that two identical
 * helpers are one helper written twice, and because a fixture built two ways is a
 * fixture two suites can silently disagree about.
 *
 * @module
 */

import type { Run, Span } from "../src/spans.ts";

/** A span, positionally, so a table reads as a table rather than as prose. */
export const span = (
  outStart: number,
  length: number,
  inStart: number,
): Span => ({
  outStart,
  length,
  inStart,
});

/** A run in whichever text the function under test names. */
export const run = (start: number, length: number): Run => ({ start, length });
