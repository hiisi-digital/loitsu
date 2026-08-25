//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The module a runtime is pointed at, so nobody has to write one.
 *
 * `install` takes a registry, which means a project using it writes a small
 * module of its own that imports its macros and calls it, and then names that
 * module wherever its runtime reads one. That module is the same three lines in
 * every project, and writing it is the step that makes this not turnkey.
 *
 * So this is that module. It finds the project the way the command line does,
 * from `loitsu.config.ts` upward from the working directory, imports it, and
 * installs its registry. Importing this for its side effect is the whole setup:
 *
 * ```bash
 * node --import loitsu/register app.js
 * bun --preload loitsu/register app.ts
 * ```
 *
 * A hook reaches what is loaded after it, so the program has to come after this
 * on the command line, or be reached through a dynamic import. That is a fact
 * about loaders rather than about this module, and it is why the line goes where
 * the runtime reads one rather than at the top of a source file.
 *
 * Deno needs none of this to run: it executes TypeScript, and what it cannot do
 * is check text a running program registered, which is why `loitsu check` and
 * `loitsu lsp` are commands rather than a hook.
 *
 * @module
 */

import { dirname, join, resolve } from "@std/path";
import { install, type Installed } from "./src/install.ts";
import { CONFIG, project } from "./cli/project.ts";

/** Why a runtime could not be set up. */
export class RegisterError extends Error {
  override readonly name = "RegisterError";
}

/**
 * The nearest directory at or above `from` holding a config, or `undefined`.
 *
 * Upward rather than exact, because a program is run from wherever somebody
 * happens to be standing and a project's root is not usually that place.
 */
export async function rootFrom(from: string): Promise<string | undefined> {
  let here = resolve(from);
  for (;;) {
    try {
      await Deno.stat(join(here, CONFIG));
      return here;
    } catch {
      const up = dirname(here);
      if (up === here) return undefined;
      here = up;
    }
  }
}

/**
 * Find the project and put its macros in front of the loader.
 *
 * Exported as well as run on import, so a program that would rather do this
 * itself can await it and know when it finished. Importing for the side effect
 * cannot be awaited, which is fine for a preload and wrong for anything else.
 */
export async function register(from: string = Deno.cwd()): Promise<Installed> {
  const root = await rootFrom(from);
  if (root === undefined) {
    throw new RegisterError(
      `no ${CONFIG} at ${
        resolve(from)
      } or above it, so there are no macros to install`,
    );
  }
  const found = await project(root);
  return install(found.registry, {
    onDiagnostic: (path, why) => {
      // A macro that could not run leaves its invocation where it was, so the
      // program keeps going and fails somewhere further along with no sign of
      // why. This is the sign.
      console.error(`loitsu: ${path}: ${why.message}`);
    },
  });
}

// The side effect this module exists for. A preload is imported and never
// called, so the work has to happen here rather than waiting to be asked.
if (import.meta.main !== true) {
  await register().catch((why: unknown) => {
    console.error(
      `loitsu: ${why instanceof Error ? why.message : String(why)}`,
    );
  });
}
