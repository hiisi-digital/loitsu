//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Which files a run looks at.
 *
 * A hand-written walk rather than a glob dependency, because what has to be
 * expressible here is small: the directories to start from, the ones to stay out
 * of, and the extensions that carry bodies. `interesting` already answers the
 * last of those and is what the loader seams use, so a run and a seam agree
 * about which files exist without either being told twice.
 *
 * @module
 */

import { join } from "@std/path";
import { interesting } from "../src/syntax.ts";

/** Directories a walk stays out of unless a caller says otherwise. Each is a
 * place a tool put files there rather than a place anybody wrote them. */
export const SKIPPED: readonly string[] = [
  // this tool's own output, which sits under the root it walks. Without it a
  // second run expands the first run's twins into `.loitsu/twins/.loitsu/twins`
  // and the file count climbs by one every time, with `check` then reporting the
  // same error once per level.
  ".loitsu",
  ".git",
  "node_modules",
  "vendor",
  "coverage",
  "npm",
  "target",
  "dist",
  "build",
];

/** What `sources` needs beyond a directory to start from. */
export interface SourceOptions {
  /** Directory names to stay out of. Defaults to {@link SKIPPED}. */
  readonly skip?: readonly string[];
  /** Whether a path is worth expanding. Defaults to `interesting`, which is
   * what the loader seams use, so the two cannot disagree. */
  readonly matches?: (path: string) => boolean;
}

/**
 * Every source file under `root`, in the order the filesystem hands them over.
 *
 * A directory that cannot be read is skipped rather than thrown, because a walk
 * meeting one permission-denied directory should still report the rest of the
 * tree. A file that cannot be read is a different thing and is not this
 * function's to notice: it comes back as a path, and reading it is where the
 * failure belongs.
 */
export async function* sources(
  root: string,
  options: SourceOptions = {},
): AsyncGenerator<string> {
  const skip = new Set(options.skip ?? SKIPPED);
  const matches = options.matches ?? interesting;

  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(root);
  } catch {
    return;
  }

  const found: Deno.DirEntry[] = [];
  try {
    for await (const one of entries) found.push(one);
  } catch {
    return;
  }

  for (const one of found) {
    const path = join(root, one.name);
    if (one.isDirectory) {
      if (skip.has(one.name)) continue;
      yield* sources(path, options);
    } else if (one.isFile && matches(path)) {
      yield path;
    }
  }
}
