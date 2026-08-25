//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Turning a tree of sources into a tree of twins.
 *
 * The twin tree is what every frontend with no loader seam reads. `deno check`
 * cannot see anything a running program registered, so what it type-checks has
 * to already be on disk, and this is what puts it there. The layout mirrors the
 * source tree exactly, so a relative import in a twin resolves to the twin of
 * what it imported without anything being rewritten.
 *
 * @module
 */

import { dirname, join, relative } from "@std/path";
import { Twins } from "../src/watch.ts";
import type { Diagnostic } from "../src/expand.ts";
import type { SpanTable } from "../src/spans.ts";
import { CONFIG, type Project, skipped } from "./project.ts";
import { sources } from "./sources.ts";

/** One file's outcome. */
export interface Built {
  /** The source, relative to the root it was found under. */
  readonly path: string;
  /** Where its twin was written, or `undefined` when nothing was written. */
  readonly twin: string | undefined;
  /** What the expansion reported, in source coordinates. */
  readonly diagnostics: readonly Diagnostic[];
  /** The twin's text back to what was authored, or `undefined` when there is no
   * twin. Carried here rather than looked up again, because asking a second
   * time either pays for the expansion twice or trusts a cache to still hold
   * what this run just built. */
  readonly spans: SpanTable | undefined;
  /** Why there is no twin, when that is what happened. */
  readonly unreadable: string | undefined;
}

/** What a whole run came to. */
export interface Build {
  readonly files: readonly Built[];
  /** Files whose expansion reported something, or that could not be read. */
  readonly failed: number;
}

/** What `build` needs beyond the project. */
export interface BuildOptions {
  /** The tree to read. */
  readonly root: string;
  /** The tree to write, mirroring the source tree. */
  readonly out: string;
}

/**
 * Every source under the root, expanded and written to the out tree.
 *
 * A file whose expansion reports a diagnostic still gets a twin. The expansion
 * carries on past a macro it could not run, leaving the invocation where it was,
 * so what lands is the best available text and the diagnostic says what is
 * missing from it. Writing nothing would take the type checker's ability to say
 * anything about the rest of the file.
 */
export async function build(
  found: Project,
  options: BuildOptions,
): Promise<Build> {
  const twins = new Twins({
    registry: found.registry,
    against: found.against,
    cacheDir: found.cacheDir,
  });

  const files: Built[] = [];
  let failed = 0;

  for await (const path of sources(options.root, { skip: skipped(found) })) {
    const here = relative(options.root, path);
    // The config is the project's own definition rather than part of it. It has
    // already run by the time anything gets here, and a twin of it would be a
    // second copy of the macro set that nothing ever imports.
    if (here === CONFIG) continue;
    const twin = await twins.get(path);

    if (twin === undefined) {
      failed++;
      files.push({
        path: here,
        twin: undefined,
        diagnostics: [],
        spans: undefined,
        unreadable: twins.failure(path)?.why ?? "unknown",
      });
      continue;
    }

    const to = join(options.out, here);
    await Deno.mkdir(dirname(to), { recursive: true });
    await Deno.writeTextFile(to, twin.code);

    if (twin.diagnostics.length > 0) failed++;
    files.push({
      path: here,
      twin: to,
      diagnostics: twin.diagnostics,
      spans: twin.spans,
      unreadable: undefined,
    });
  }

  return { files, failed };
}
