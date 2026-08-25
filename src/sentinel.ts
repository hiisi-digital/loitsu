//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Finding out where a printed node landed, when the node itself will not say.
 *
 * A node a macro constructs carries `pos = end = -1`, and stays that way through
 * printing: a constructed `FunctionDeclaration` reports `-1 -1` where a parsed
 * one reports `0 31`. So an expansion arrives with no positions in it, and
 * `spans.ts` has nothing to build a table from.
 *
 * TypeScript has machinery that would answer this and does not expose it. The
 * public `Printer` declares only `print*` methods returning `string`; the
 * `write*` overloads that take a writer exist at runtime and are not declared.
 * `createSourceMapGenerator` is present at runtime and appears nowhere in the
 * public `.d.ts`. Reaching for either means depending on a surface the compiler
 * does not promise, across a version range this package does not control.
 *
 * So the position is recovered from the text instead. Every node worth mapping
 * is given a synthetic comment carrying a unique marker before printing, the
 * markers are located in the printed output, and then they are removed. The
 * printer is being asked only to emit a comment it was handed, which is the
 * least it can be asked to do and the part of it least likely to change.
 *
 * @module
 */

import ts from "typescript";

/** The marker's shape. Unlikely by construction rather than by hope: a run of
 * characters no formatter produces, plus a counter, plus a per-run nonce so two
 * expansions of one file cannot collide even if one is nested in the other. */
const SIGIL = "\u0192";

/** One marked node, and where it came from in the authored text. */
export interface Marked {
  readonly id: number;
  readonly sourceStart: number;
  readonly sourceLength: number;
}

/**
 * Marks handed out during one expansion, and the text they were found in.
 *
 * A `Marker` is single-use on purpose. Reusing one across two files would let a
 * marker from the first resolve against the second, and the failure would be a
 * span pointing into a file nobody asked about.
 */
/** A tag for one expansion run.
 *
 * Not `Math.random().toString(36).slice(2, 10)`. `Math.random()` may return exactly
 * 0, whose base-36 form is `"0"`, so slicing from index 2 gives the empty string and
 * the constructor below throws on it. Nor a loop topping that up, which was the first
 * repair and does not terminate for the same input.
 *
 * `getRandomValues` has no such value. It fills the array, every byte becomes exactly
 * two hex digits, and the length is fixed by construction rather than by trimming
 * something of unknown size.
 */
function randomNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Marker {
  readonly #nonce: string;
  #next = 0;
  readonly #marked: Marked[] = [];

  /** This marker's own tag, which is what keeps one run's pairs out of another's text. */
  get nonce(): string {
    return this.#nonce;
  }

  constructor(nonce: string = randomNonce()) {
    if (!/^[a-z0-9]+$/.test(nonce)) {
      throw new RangeError(
        `a nonce is lower-case alphanumeric so it survives a comment; got ${
          JSON.stringify(nonce)
        }`,
      );
    }
    this.#nonce = nonce;
  }

  /** The opening marker's text, without the comment syntax around it. */
  open(id: number): string {
    return `${SIGIL}${this.#nonce}${id}o`;
  }

  /** The closing marker's text, without the comment syntax around it. */
  close(id: number): string {
    return `${SIGIL}${this.#nonce}${id}c`;
  }

  /**
   * Mark `node` as having come from `[sourceStart, sourceStart + sourceLength)`.
   *
   * The synthetic comments go on the node itself, so the printer emits them
   * around whatever it prints for that node, wherever it decides to put it.
   *
   * @throws {RangeError} on a length that maps nothing, since a zero-length
   * region is a marker pair with no text between them and no span to record.
   */
  mark<N extends ts.Node>(
    node: N,
    sourceStart: number,
    sourceLength: number,
  ): N {
    if (sourceLength <= 0) {
      throw new RangeError(
        `a marked region of ${sourceLength} bytes maps nothing`,
      );
    }
    if (sourceStart < 0) {
      throw new RangeError(
        `a marked region starting at ${sourceStart} is before the text`,
      );
    }
    const id = this.#next++;
    this.#marked.push({ id, sourceStart, sourceLength });
    ts.addSyntheticLeadingComment(
      node,
      ts.SyntaxKind.MultiLineCommentTrivia,
      this.open(id),
    );
    ts.addSyntheticTrailingComment(
      node,
      ts.SyntaxKind.MultiLineCommentTrivia,
      this.close(id),
    );
    return node;
  }

  /** Everything marked so far, in the order it was marked. */
  get marked(): readonly Marked[] {
    return this.#marked;
  }
}

/** One marker pair found in printed text, and what it enclosed. */
export interface Found {
  readonly id: number;
  /** Where the enclosed text starts, once every marker has been removed. */
  readonly outStart: number;
  readonly length: number;
}

/**
 * Trim the padding a removed marker leaves behind.
 *
 * The printer separates a comment from what follows it, so `inner` marked and
 * printed comes back as `/*..*\/ inner /*..*\/` and strips to `" inner "`. Those
 * two spaces are the marker's, not the node's, and leaving them in makes a
 * seven-byte region claim to map five bytes of source, which `spans.ts` cannot
 * express and should not be asked to.
 *
 * Only whitespace is trimmed, and only at the edges, so nothing a node actually
 * printed is lost.
 */
function trimmed(
  text: string,
  start: number,
  length: number,
): { start: number; length: number } {
  let from = start, to = start + length;
  while (from < to && /\s/.test(text[from]!)) from++;
  while (to > from && /\s/.test(text[to - 1]!)) to--;
  return { start: from, length: to - from };
}

/**
 * Strip every marker from `printed` and say where each pair's contents ended up.
 *
 * Offsets are into the returned text rather than into `printed`, because the
 * markers are not in the returned text and a caller mapping into a string that
 * no longer exists is the whole class of bug this module is for.
 *
 * A pair whose halves are crossed or missing is reported rather than guessed at:
 * the printer is free to drop a comment it does not know where to put, and a
 * dropped marker means that node's position is unknown, which is a smaller
 * problem than a position that is confidently wrong.
 */
export function strip(
  printed: string,
  marker: Marker,
): { text: string; found: Found[]; lost: number[] } {
  const opens = new Map<number, number>();
  const found: Found[] = [];
  let text = "";
  let at = 0;

  // One pass, because two passes over a moving string is where the offsets drift.
  // This marker's own nonce, and nothing else. A pattern accepting any nonce
  // finds another run's pairs and resolves them against this text, which names a
  // position in a file nobody asked about, and nothing downstream could tell.
  const re = new RegExp(`/\\*${SIGIL}${marker.nonce}(\\d+)([oc])\\*/`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(printed)) !== null) {
    text += printed.slice(at, m.index);
    at = m.index + m[0].length;
    const id = Number(m[1]);
    if (m[2] === "o") opens.set(id, text.length);
    else {
      const start = opens.get(id);
      if (start === undefined) continue; // a close with no open: crossed, reported below
      opens.delete(id);
      const cut = trimmed(text, start, text.length - start);
      if (cut.length > 0) {
        found.push({ id, outStart: cut.start, length: cut.length });
      }
    }
  }
  text += printed.slice(at);

  // Whatever did not end up in `found`, whichever way it failed to. Enumerating the
  // ways (never seen, opened and never closed, crossed, enclosing nothing) reads as
  // thorough and is one condition written four times: each of them ends with the id
  // absent from `found`, so three of the four can never be the reason.
  const located = new Set(found.map((f) => f.id));
  const lost = marker.marked.map((mk) => mk.id).filter((id) =>
    !located.has(id)
  );
  return { text, found, lost };
}
