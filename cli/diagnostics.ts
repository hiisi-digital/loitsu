//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Reading `deno check` back.
 *
 * The type checker runs over the twin tree, so everything it says is positioned
 * in a file the author never wrote. Getting those positions back to the source
 * needs them as data first, and deno reports them as prose.
 *
 * There is no machine-readable form to ask for, so this parses the human one.
 * That is a real dependency on someone else's output format, which is why the
 * shapes it handles were taken from running the thing rather than from memory,
 * and why `still finds what deno actually prints`, in `tests/cli_test.ts`, runs
 * `deno check` over a file it knows is broken and asserts the parse finds what is
 * in it. When deno changes the
 * format that test fails, which is the whole point of it.
 *
 * @module
 */

/**
 * Something said about one point in one file.
 *
 * Shared by what the checker reports and what this tool reports back, because
 * the two carry the same four fields and differ only in what the file and the
 * position are counted in. Which text that is belongs to whoever extends this,
 * and both of them say.
 */
export interface At {
  /** Which file. */
  readonly path: string;
  /** One-based, the way every compiler and every editor counts. */
  readonly line: number;
  /** One-based. */
  readonly column: number;
  /** The first line of what was said. A type error's full text runs to several
   * lines and the rest is elaboration of this one. */
  readonly message: string;
}

/** One thing the checker said, positioned in a twin. */
export interface Reported extends At {
  /** The twin, as an absolute path. Deno reports a `file:` url and this is it
   * resolved, because everything downstream compares paths. */
  readonly path: string;
  /** `TS2322` and the like, or `undefined` for the ones deno raises itself. */
  readonly code: string | undefined;
}

/** Where a diagnostic says it is. Indented, and the last line of its block. */
const AT = /^\s+at (file:\/\/\S+?):(\d+):(\d+)\s*$/;

/** A type error's first line: the code, the severity, then the text. */
const TYPED = /^(TS\d+) \[[A-Z]+\]: (.*)$/;

/** Deno's own, which carries no code. A syntax error is one of these. */
const OWN = /^error: (.*)$/;

/**
 * Every diagnostic in a `deno check` run's output.
 *
 * Runs with the location lines as the anchor rather than the message lines,
 * because a message is one line or several and a location is always exactly one.
 * Each is attributed to the nearest message line above it, and that line is then
 * spent: a location with no message above it is dropped rather than given
 * somebody else's text.
 *
 * Colour is not stripped. The caller runs deno with `NO_COLOR`, which is one
 * environment variable against a regular expression that would have to know
 * every escape deno might emit.
 */
export function reported(output: string): Reported[] {
  const out: Reported[] = [];
  let message: string | undefined;
  let code: string | undefined;

  for (const line of output.split("\n")) {
    const typed = TYPED.exec(line);
    if (typed !== null) {
      code = typed[1];
      message = typed[2];
      continue;
    }
    const own = OWN.exec(line);
    if (own !== null) {
      code = undefined;
      message = own[1];
      continue;
    }
    const at = AT.exec(line);
    if (at === null) continue;
    if (message === undefined) continue;

    out.push({
      path: new URL(at[1]).pathname,
      line: Number(at[2]),
      column: Number(at[3]),
      message,
      code,
    });
    message = undefined;
    code = undefined;
  }

  return out;
}
