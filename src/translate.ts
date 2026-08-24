//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Moving one document's protocol payloads between what was written and what was
 * checked.
 *
 * The editor sends positions in the file the author opened. The server behind
 * this one only ever sees the twin, and answers in the twin's coordinates. Both
 * directions run through the span table, and neither is a plain offset shift:
 * downward is one to many, because a macro may write an authored name into
 * several arms, and upward is partial, because most of a twin came from nowhere.
 *
 * The two asymmetries are the whole module. A request goes down to every image
 * and the answers come back unioned. An answer whose range has no authored image
 * is dropped, because there is nowhere honest to put it.
 *
 * @module
 */

import {
  DEFAULT_ENCODING,
  type Encoding,
  Lines,
  type Position,
  type Range,
} from "./position.ts";
import {
  outputOffsets,
  outputRuns,
  type Run,
  sourceOffset,
  sourceRuns,
  type SpanTable,
} from "./spans.ts";

/** Where something is, as the protocol writes it. */
export interface Location {
  readonly uri: string;
  readonly range: Range;
}

/** One note hanging off a diagnostic, pointing somewhere else. */
export interface Related {
  readonly location: Location;
  readonly message: string;
}

/**
 * A diagnostic as the protocol writes one, carrying only the fields this has an
 * opinion about. Not the expander's `Diagnostic` from `expand.ts`, which reports what a
 * macro did; this is what a language server sends about a document.
 *
 * Everything else a server sends is passed through untouched, which is why the
 * index signature is here: a field this does not know about is not a field it
 * may drop.
 */
export interface ProtocolDiagnostic {
  readonly range: Range;
  readonly message: string;
  readonly relatedInformation?: readonly Related[];
  // deno-lint-ignore no-explicit-any
  readonly [other: string]: any;
}

/** One replacement, as a rename or a code action returns it. */
export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

/** One source and the twin built from it, with the table between them. */
export interface Pair {
  readonly source: string;
  readonly twin: string;
  readonly spans: SpanTable;
}

/** A range as a run of the text it indexes, or nothing if it runs backwards. */
function runOf(lines: Lines, range: Range, encoding: Encoding): Run {
  const start = lines.offsetAt(range.start, encoding);
  const end = lines.offsetAt(range.end, encoding);
  return { start, length: end - start };
}

/**
 * One document's two coordinate systems, and the crossings between them.
 *
 * Built per twin and thrown away with it. Holding one across a rebuild would
 * answer about a table that no longer describes either text.
 */
export class Mapping {
  readonly #pair: Pair;
  readonly #encoding: Encoding;
  readonly #source: Lines;
  readonly #twin: Lines;

  constructor(pair: Pair, encoding: Encoding = DEFAULT_ENCODING) {
    this.#pair = pair;
    this.#encoding = encoding;
    this.#source = new Lines(pair.source);
    this.#twin = new Lines(pair.twin);
  }

  /** The text the author wrote, indexed by line. */
  get source(): Lines {
    return this.#source;
  }

  /** The text the inner server was handed, indexed by line. */
  get twin(): Lines {
    return this.#twin;
  }

  /** The span table this was built over. */
  get spans(): SpanTable {
    return this.#pair.spans;
  }

  /**
   * Every place in the twin an authored position ended up, in twin order.
   *
   * Empty is a real answer and the common one for a position inside a macro
   * invocation, which the expander deleted. A request there is answered by
   * nothing rather than by whatever happens to sit at the same offset.
   */
  toTwin(at: Position): Position[] {
    const offset = this.#source.offsetAt(at, this.#encoding);
    return outputOffsets(this.#pair.spans, offset)
      .map((to) => this.#twin.positionAt(to, this.#encoding));
  }

  /**
   * The authored position a twin position came from, or nothing.
   *
   * Nothing is the answer for every position in text a macro invented, which is
   * most of what makes a twin differ from its source.
   */
  toSource(at: Position): Position | undefined {
    const offset = this.#twin.offsetAt(at, this.#encoding);
    const back = sourceOffset(this.#pair.spans, offset);
    return back === undefined
      ? undefined
      : this.#source.positionAt(back, this.#encoding);
  }

  /**
   * Carry a range across, in whichever direction the two functions describe.
   *
   * The two crossings are mirror images and differ only in which text indexes
   * the incoming range, which text indexes the answer, and which of the span
   * module's two questions is asked. Written twice they drift.
   */
  #cross(
    range: Range,
    from: Lines,
    to: Lines,
    ask: (spans: SpanTable, run: Run) => Run[],
  ): Range[] {
    return ask(this.#pair.spans, runOf(from, range, this.#encoding))
      .map((run) =>
        to.rangeAt(run.start, run.start + run.length, this.#encoding)
      );
  }

  /** Every twin range an authored range covers, in twin order. */
  toTwinRanges(range: Range): Range[] {
    return this.#cross(range, this.#source, this.#twin, outputRuns);
  }

  /**
   * The authored ranges a twin range came from, in authored order.
   *
   * Several is unusual and is not a hull: two authored regions with text between
   * them that the expansion did not touch stay two, because a caller handed one
   * range covering both would edit what sits in the middle.
   */
  toSourceRanges(range: Range): Range[] {
    return this.#cross(range, this.#twin, this.#source, sourceRuns);
  }
}

/**
 * Which of two positions comes first, as a sort comparison.
 *
 * Positions rather than ranges, and that is the whole comparison there is here.
 * Two edits sharing a start overlap unless both are empty, and overlapping ones
 * are refused below, so nothing downstream can be distinguished by where an edit
 * ends. A comparison including the end would be a clause no input could reach.
 */
function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

/** A range as one string, so two of them are the same when the strings are. */
function rangeKey(range: Range): string {
  return `${range.start.line}:${range.start.character}-` +
    `${range.end.line}:${range.end.character}`;
}

/**
 * Move a diagnostic onto the text the author wrote, or drop it.
 *
 * Dropped is the answer whenever the range has no authored image, and that is
 * not a failure: `'greet__node' is declared but its value is never read` is a
 * fact about an arm the twin carries and the target does not use. Nobody wrote
 * it, so there is nowhere to put it, and reporting it against whatever sits at
 * the same offset would be an invention.
 *
 * A range with several authored images keeps the first and hangs the rest off
 * as related information rather than reporting the diagnostic several times or
 * covering the gap between them. The `uri` is needed for exactly that, since a
 * related location is a location and a location names a file.
 *
 * A related location this document owns is moved the same way and dropped the
 * same way. One naming another file is passed through, because this knows one
 * document and guessing about another would be worse than leaving it.
 */
export function toSourceDiagnostic(
  map: Mapping,
  uri: string,
  diagnostic: ProtocolDiagnostic,
): ProtocolDiagnostic | undefined {
  const ranges = map.toSourceRanges(diagnostic.range);
  const here = ranges[0];
  if (here === undefined) return undefined;

  const related: Related[] = [];
  for (const rest of ranges.slice(1)) {
    related.push({
      location: { uri, range: rest },
      message: "and here, from the same authored text",
    });
  }
  for (const one of diagnostic.relatedInformation ?? []) {
    if (one.location.uri !== uri) {
      related.push(one);
      continue;
    }
    const moved = map.toSourceRanges(one.location.range)[0];
    if (moved === undefined) continue;
    related.push({ ...one, location: { uri, range: moved } });
  }

  const out = { ...diagnostic, range: here };
  if (related.length > 0) return { ...out, relatedInformation: related };
  // An empty list and an absent one read differently to a client, and a
  // diagnostic that arrived without the field should leave without it.
  delete (out as { relatedInformation?: unknown }).relatedInformation;
  return out;
}

/** Every diagnostic that has somewhere to go, in the order they arrived. */
export function toSourceDiagnostics(
  map: Mapping,
  uri: string,
  diagnostics: readonly ProtocolDiagnostic[],
): ProtocolDiagnostic[] {
  const out: ProtocolDiagnostic[] = [];
  for (const one of diagnostics) {
    const moved = toSourceDiagnostic(map, uri, one);
    if (moved !== undefined) out.push(moved);
  }
  return out;
}

/** What a rename came back with, and what it could not use. */
export interface Renamed {
  /** The edits to make, in authored order, none overlapping another. */
  readonly edits: readonly TextEdit[];
  /** How many incoming edits named text nobody wrote. */
  readonly dropped: number;
}

/**
 * Union the renames from every twin onto the one text the author wrote.
 *
 * There is one twin per target and a rename reaches one of them per request,
 * because each is a separate document to the checker. So loitsu issues one per
 * twin and this is where the answers meet. Every twin was built from the same
 * source, so their authored ranges are comparable and the union is over one
 * coordinate system.
 *
 * **The incoming `newText` is deliberately not used.** A twin may hold a name a
 * macro derived rather than the one that was written, and splicing its
 * replacement onto the authored range would put text nobody typed into the
 * author's file. The edits are here to say *where*, and `newName` is what goes
 * there: no twin is ever edited by anybody, each is rebuilt once the source
 * changes.
 *
 * Identical edits from different twins collapse, which is the normal case: a
 * declaration outside any conditional appears in every twin and is one authored
 * symbol. Distinct edits do not, which is the other normal case: two arms
 * written separately are two declarations and both want renaming.
 *
 * @throws {RangeError} on two edits overlapping without being equal, which the
 * protocol forbids in one array and which no honest rename produces. Emitting
 * them would leave the client to resolve a conflict it cannot see the cause of.
 */
export function renameEdits(
  newName: string,
  perTwin: Iterable<readonly [Mapping, readonly TextEdit[]]>,
): Renamed {
  const edits: TextEdit[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const [map, arm] of perTwin) {
    for (const edit of arm) {
      const ranges = map.toSourceRanges(edit.range);
      if (ranges.length === 0) dropped++;
      for (const range of ranges) {
        const key = rangeKey(range);
        if (seen.has(key)) continue;
        seen.add(key);
        edits.push({ range, newText: newName });
      }
    }
  }
  edits.sort((a, b) => comparePositions(a.range.start, b.range.start));
  for (let at = 1; at < edits.length; at++) {
    const last = edits[at - 1]!.range, next = edits[at]!.range;
    if (comparePositions(next.start, last.end) < 0) {
      throw new RangeError(
        `two rename edits overlap: ${JSON.stringify(last)} and ` +
          `${JSON.stringify(next)}, which the protocol forbids in one array`,
      );
    }
  }
  return { edits, dropped };
}
