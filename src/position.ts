//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Line and character positions, and the three encodings the protocol admits.
 *
 * Everything else in loitsu counts in UTF-16 code units, because that is what a
 * JavaScript string index is and what TypeScript reports. An editor counts in
 * whatever encoding it negotiated, which is UTF-16 unless it asked for
 * something else, and the two are the same number only while the text stays
 * ASCII. This module is the one place that difference is handled.
 *
 * The rules here are the protocol's rather than ours. A character past the end
 * of its line falls back to the line length. A line ends at `\n`, `\r\n` or
 * `\r`, and no position can name the gap inside a `\r\n`.
 *
 * @module
 */

/**
 * How an editor counts columns.
 *
 * `utf-16` is the only one every client supports and the one assumed when
 * nothing was negotiated. `utf-8` counts bytes and `utf-32` counts code points.
 */
export type Encoding = "utf-8" | "utf-16" | "utf-32";

/** The encoding to use when the client offered nothing usable. */
export const DEFAULT_ENCODING: Encoding = "utf-16";

/** A zero-based line and a column counted in the negotiated encoding. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

/** A half-open span of one document, as the protocol writes it. */
export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/**
 * Pick the encoding to answer in, from what the client said it supports.
 *
 * The client lists them in decreasing preference and only `utf-16` is
 * mandatory, so the first one recognised wins and anything unrecognised is
 * skipped rather than refused. A client that offers nothing we know still gets
 * `utf-16`, which it is required to understand.
 */
export function negotiate(offered: readonly string[] | undefined): Encoding {
  for (const one of offered ?? []) {
    if (one === "utf-8" || one === "utf-16" || one === "utf-32") return one;
  }
  return DEFAULT_ENCODING;
}

/** How many UTF-8 bytes one code point occupies. */
function utf8Width(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * One text, indexed by line, so a conversion is a search rather than a scan.
 *
 * Built once per document version and thrown away with it. The line starts are
 * UTF-16 offsets into the text, which is what every other offset in loitsu is.
 */
export class Lines {
  readonly #text: string;
  readonly #starts: number[];

  constructor(text: string) {
    this.#text = text;
    const starts = [0];
    for (let at = 0; at < text.length; at++) {
      const ch = text.charCodeAt(at);
      if (ch === 0x0a) starts.push(at + 1);
      else if (ch === 0x0d) {
        if (text.charCodeAt(at + 1) === 0x0a) at++;
        starts.push(at + 1);
      }
    }
    this.#starts = starts;
  }

  /** The text this was built from. */
  get text(): string {
    return this.#text;
  }

  /** How many lines it has. A text ending in a newline has an empty last one. */
  get count(): number {
    return this.#starts.length;
  }

  /** Where a line begins, as a UTF-16 offset. */
  startOf(line: number): number {
    return this.#starts[line]!;
  }

  /**
   * Where a line's content ends, before whatever terminates it.
   *
   * This is what the protocol means by the line length, so it is what a
   * character past the end falls back to.
   */
  endOf(line: number): number {
    const next = this.#starts[line + 1];
    if (next === undefined) return this.#text.length;
    // Step back over the terminator, which is one character or two.
    let at = next - 1;
    if (
      this.#text.charCodeAt(at) === 0x0a &&
      this.#text.charCodeAt(at - 1) === 0x0d
    ) at--;
    return at;
  }

  /**
   * The UTF-16 offset a position names.
   *
   * Out of range in either axis clamps rather than throwing: an editor sends
   * positions from a buffer it has already edited, and the protocol says a
   * character past the end of its line is the end of that line. Clamping the
   * line as well is ours, and it is the only answer that is not a crash.
   */
  offsetAt(at: Position, encoding: Encoding = DEFAULT_ENCODING): number {
    const line = Math.min(Math.max(Math.trunc(at.line), 0), this.count - 1);
    const from = this.#starts[line]!;
    const to = this.endOf(line);
    const want = Math.max(Math.trunc(at.character), 0);
    if (encoding === "utf-16") return Math.min(from + want, to);

    let counted = 0;
    for (let scan = from; scan < to;) {
      const code = this.#text.codePointAt(scan)!;
      const wide = code > 0xffff;
      const cost = encoding === "utf-8" ? utf8Width(code) : 1;
      if (counted + cost > want) return scan;
      counted += cost;
      scan += wide ? 2 : 1;
    }
    return to;
  }

  /**
   * The position naming a UTF-16 offset.
   *
   * An offset inside a `\r\n` is rounded back to the end of that line, because
   * no position can name the gap between the two. An offset inside a surrogate
   * pair is rounded back to the start of the pair under the encodings that
   * cannot split one, and is reported as it stands under UTF-16, which can.
   */
  positionAt(offset: number, encoding: Encoding = DEFAULT_ENCODING): Position {
    const want = Math.min(Math.max(Math.trunc(offset), 0), this.#text.length);
    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#starts[mid]! <= want) lo = mid;
      else hi = mid - 1;
    }
    const from = this.#starts[lo]!;
    const to = Math.min(want, this.endOf(lo));
    if (encoding === "utf-16") return { line: lo, character: to - from };

    let counted = 0;
    for (let scan = from; scan < to;) {
      const code = this.#text.codePointAt(scan)!;
      const wide = code > 0xffff;
      if (wide && scan + 2 > to) break; // the offset splits a pair
      counted += encoding === "utf-8" ? utf8Width(code) : 1;
      scan += wide ? 2 : 1;
    }
    return { line: lo, character: counted };
  }

  /** A range from two UTF-16 offsets, in the order they were given. */
  rangeAt(
    start: number,
    end: number,
    encoding: Encoding = DEFAULT_ENCODING,
  ): Range {
    return {
      start: this.positionAt(start, encoding),
      end: this.positionAt(end, encoding),
    };
  }
}
