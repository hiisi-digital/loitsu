//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Carrying every position in a protocol message across, without enumerating the
 * protocol.
 *
 * A message is JSON, and the two shapes that carry a location in it are fixed:
 * a position is `{ line, character }` and a range is a pair of them under
 * `start` and `end`. So the walk here is structural. It finds those two shapes
 * wherever they sit, hands each to a crossing, and puts back what comes out.
 * A message shape nobody has written support for is carried across anyway, and
 * a version of the protocol that adds one needs no change here.
 *
 * The alternative was a table of methods and the fields each one carries, which
 * is a claim to be exhaustive over a protocol that grows, made by somebody
 * reading its specification once.
 *
 * ## What this cannot see
 *
 * Three things, and they are not covered by anything below:
 *
 * - **A line without a character.** `FoldingRange` says `startLine` and
 *   `endLine`, so a fold marker crosses unchanged and lands on whatever line
 *   holds that number in the other document.
 * - **Positions encoded as numbers.** `SemanticTokens` is a flat integer array
 *   of line and character deltas. Nothing here recognises it.
 * - **Positions inside a string.** A message that spells a location into its
 *   own prose, which diagnostics from some servers do, keeps the twin's
 *   numbers in that prose while its range moves.
 *
 * Each is a real gap rather than a case that does not arise, and each wants its
 * own handling in the router rather than a widening of this walk.
 *
 * @module
 */

import type { Position, Range } from "./position.ts";

/**
 * What a value becomes when the thing it names has no image in the other
 * document.
 *
 * Not `undefined`, which is a value a message can legitimately carry, and not
 * `null`, which the protocol uses to mean an empty answer.
 */
export const DROPPED: unique symbol = Symbol("dropped");

/** What one direction does with a position and with a range. */
export interface Crossing {
  /**
   * Where a range lands, or nothing.
   *
   * `uri` is the document the range belongs to, taken from whatever named one
   * on the way down, and is undefined when nothing did. A crossing that holds
   * no twin for that document returns the range unchanged rather than nothing,
   * because a location in another file is not this layer's to move.
   */
  range(range: Range, uri: string | undefined): Range | undefined;
  /** The same for a position that is not part of a range. */
  point(at: Position, uri: string | undefined): Position | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is written the way the protocol writes a position. */
export function isPosition(value: unknown): value is Position {
  return isRecord(value) &&
    typeof value.line === "number" &&
    typeof value.character === "number";
}

/** Whether a value is written the way the protocol writes a range. */
export function isRange(value: unknown): value is Range {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

/**
 * Every position and range in a value, carried across.
 *
 * Dropping propagates outward through objects and stops at arrays. A hover
 * whose range has no authored image is not a hover; the array of locations a
 * definition request answers with keeps the ones that do cross and loses the
 * ones that do not. That is the difference between an answer that is wrong and
 * an answer that is shorter.
 *
 * `uri` is the document a range belongs to when nothing further down names one.
 * Anything carrying its own `uri`, which is how the protocol writes a location,
 * replaces it for that subtree, so a rename touching three files asks the right
 * crossing about each.
 */
export function crossed<T>(
  value: T,
  crossing: Crossing,
  uri?: string,
): T | typeof DROPPED {
  return carry(value, crossing, uri) as T | typeof DROPPED;
}

function carry(
  value: unknown,
  crossing: Crossing,
  uri: string | undefined,
): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const one of value) {
      const crossed = carry(one, crossing, uri);
      if (crossed !== DROPPED) out.push(crossed);
    }
    return out;
  }
  if (!isRecord(value)) return value;

  if (isRange(value)) {
    // The range is asked about whole. Crossing its two ends separately would
    // ask the span table about two points where it can answer about a run, and
    // a run is what the table is built to describe.
    return crossing.range(value, uri) ?? DROPPED;
  }
  if (isPosition(value)) return crossing.point(value, uri) ?? DROPPED;

  // A document naming itself governs everything under it. `changes` in a
  // workspace edit is the one place the name is a key rather than a field, so
  // it is handled where it sits rather than by a rule about keys generally.
  const here = typeof value.uri === "string" ? value.uri : uri;

  const out: Record<string, unknown> = {};
  for (const [key, one] of Object.entries(value)) {
    const crossed = key === "changes" && isChanges(one)
      ? byUri(one, crossing)
      : carry(one, crossing, here);
    if (crossed === DROPPED) return DROPPED;
    out[key] = crossed;
  }
  return out;
}

/**
 * Whether a value is written the way a workspace edit writes `changes`: every
 * key a document, every value that document's edits.
 *
 * The list requirement is what keeps this from claiming any field named
 * `changes`, and it is also what makes `byUri` total: a list is the one thing
 * the walk never drops whole, so every entry has an answer.
 */
function isChanges(value: unknown): value is Record<string, unknown[]> {
  return isRecord(value) && Object.values(value).every(Array.isArray);
}

/** A workspace edit's `changes`, where each key names the document its value edits. */
function byUri(
  changes: Record<string, unknown[]>,
  crossing: Crossing,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [uri, edits] of Object.entries(changes)) {
    // A file whose every edit dropped contributes no entry rather than an empty
    // one, which an editor would otherwise open and touch for nothing.
    const crossed = carry(edits, crossing, uri) as unknown[];
    if (crossed.length === 0) continue;
    out[uri] = crossed;
  }
  return out;
}
