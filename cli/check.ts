//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Type checking a tree through its twins.
 *
 * `deno check` reads disk and nothing else. Nothing a running program registers
 * reaches it, which is why the twin tree exists at all: the checker is pointed
 * at text that is already expanded, and everything it says is then carried back
 * to the file the author wrote.
 *
 * A diagnostic with no authored image is dropped. That is the same rule the
 * editor proxy follows, and for the same reason: a position inside text no macro
 * came from has nowhere in the source to point at, and reporting it against
 * whatever happens to sit at the same offset would be worse than silence.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import { Mapping } from "../src/translate.ts";
import { Lines } from "../src/position.ts";
import { build, type BuildOptions } from "./build.ts";
import type { Project } from "./project.ts";
import { type At, reported } from "./diagnostics.ts";

/** One thing to say to whoever ran the check, in the text they wrote. */
export interface Said extends At {
  /** The source, relative to the root it was found under. */
  readonly path: string;
  /** Which half said it. The expansion runs first and a macro that could not
   * run usually explains every type error under it. */
  readonly from: "expansion" | "types";
}

/** What a whole check came to. */
export interface Checked {
  /** Everything with somewhere in the source to point at, source order. */
  readonly said: readonly Said[];
  /** How many source files were looked at. */
  readonly files: number;
  /** Type diagnostics whose position had no authored image, so were dropped.
   * Counted rather than hidden: a run dropping many of them is a run whose span
   * table is wrong, and a silent zero would say nothing about that. */
  readonly dropped: number;
}

/** Nothing was found to check, so the run established nothing. */
export class NothingToCheck extends Error {
  override readonly name = "NothingToCheck";
  constructor(root: string) {
    super(
      `no source files under ${
        JSON.stringify(root)
      }, so the check looked at nothing. ` +
        "A run that certifies nothing is not a run that passed.",
    );
  }
}

/** What `check` needs beyond the project. */
export interface CheckOptions extends BuildOptions {
  /** How to run the type checker. Defaults to `deno check` over the twin tree,
   * and is a seam so a test can hand back a known output instead of paying for
   * a real check. */
  readonly checker?: (twins: readonly string[]) => Promise<string>;
}

/** `deno check` over the twins, with colour off so the output parses. */
async function denoCheck(twins: readonly string[]): Promise<string> {
  const ran = await new Deno.Command(Deno.execPath(), {
    args: ["check", ...twins],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const read = new TextDecoder();
  return read.decode(ran.stdout) + read.decode(ran.stderr);
}

/**
 * Every source under the root, expanded, checked, and reported where it was
 * written.
 *
 * Expansion diagnostics come first and already carry authored offsets, so they
 * only need turning into line and column. Type diagnostics arrive positioned in
 * a twin and cross back through that twin's span table.
 */
export async function check(
  found: Project,
  options: CheckOptions,
): Promise<Checked> {
  const built = await build(found, options);
  if (built.files.length === 0) throw new NothingToCheck(options.root);

  const said: Said[] = [];
  const twins: string[] = [];
  // Keyed on the resolved twin path, because that is what deno names back.
  const back = new Map<string, { path: string; map: Mapping }>();

  for (const one of built.files) {
    if (one.unreadable !== undefined) {
      said.push({
        path: one.path,
        line: 1,
        column: 1,
        message: `could not be read: ${one.unreadable}`,
        from: "expansion",
      });
      continue;
    }
    if (one.twin === undefined) continue;

    const source = await Deno.readTextFile(join(options.root, one.path));
    const lines = new Lines(source);
    for (const why of one.diagnostics) {
      const at = lines.positionAt(why.start);
      said.push({
        path: one.path,
        line: at.line + 1,
        column: at.character + 1,
        message: why.message,
        from: "expansion",
      });
    }

    twins.push(one.twin);
    if (one.spans === undefined) continue;
    const twin = await Deno.readTextFile(one.twin);
    back.set(resolve(one.twin), {
      path: one.path,
      map: new Mapping({ source, twin, spans: one.spans }),
    });
  }

  let dropped = 0;
  const checker = options.checker ?? denoCheck;
  for (const one of reported(await checker(twins))) {
    const here = back.get(resolve(one.path));
    if (here === undefined) {
      dropped++;
      continue;
    }
    const at = here.map.toSource({
      line: one.line - 1,
      character: one.column - 1,
    });
    if (at === undefined) {
      dropped++;
      continue;
    }
    said.push({
      path: here.path,
      line: at.line + 1,
      column: at.character + 1,
      message: one.code === undefined
        ? one.message
        : `${one.code}: ${one.message}`,
      from: "types",
    });
  }

  said.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column
  );
  return { said, files: built.files.length, dropped };
}

/** One line per thing said, in the shape editors and terminals both read. */
export function lines(checked: Checked): string[] {
  return checked.said.map((one) =>
    `${one.path}:${one.line}:${one.column}: ${one.message}`
  );
}
