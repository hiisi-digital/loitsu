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
 * every project, and writing it is a step nobody should have to take.
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

import { install, type Installed } from "./src/install.ts";
import { CONFIG, project } from "./cli/project.ts";

/* Path handling, inline, rather than from `@std/path`.
 *
 * This is the first module a runtime loads, before any of its own resolution is
 * set up, and node cannot resolve a bare specifier in a file loaded directly by
 * path. A preload that depends on the resolver working is a preload that fails
 * where it is least able to say why.
 *
 * What is needed is small enough to be worth having here: joining two segments,
 * taking a parent, and making a relative path absolute. */

/** One path from two segments, with a single separator between them. */
const joined = (a: string, b: string): string =>
  `${a.replace(/[\\/]+$/, "")}/${b}`;

/** The parent of a path, and a fixpoint at whatever passes for a root. */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // at 0 the parent is the root itself, and a windows drive keeps its colon
  if (at <= 0) return path.startsWith("/") ? "/" : path;
  const up = path.slice(0, at);
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
}

/** An absolute path, resolved against where the process is standing. */
const absolute = (path: string): string =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
    ? path.replace(/[\\/]+$/, "") || "/"
    : joined(whereWeAre(), path).replace(/\/\.$/, "");

/** Why a runtime could not be set up. */
export class RegisterError extends Error {
  override readonly name = "RegisterError";
}

/** What this module needs of a runtime, which is two things.
 *
 * Reached through the global rather than imported, for the reason `install.ts`
 * gives about `node:module`: naming a specifier at the top of this file makes
 * the file unloadable anywhere that specifier does not resolve. This module is
 * loaded by node and by bun, where `Deno` is not defined, and by deno, where
 * `node:fs` is. Neither may be named unconditionally. */
interface HasDeno {
  Deno: {
    cwd(): string;
    stat(path: string): Promise<unknown>;
    errors: { NotFound: new (...args: never[]) => Error };
  };
}
interface HasProcess {
  process: {
    cwd(): string;
    getBuiltinModule?(name: string): unknown;
  };
}

/** Where the process is standing, on whichever runtime is running this. */
function whereWeAre(): string {
  const deno = (globalThis as Partial<HasDeno>).Deno;
  if (deno !== undefined) return deno.cwd();
  const running = (globalThis as Partial<HasProcess>).process;
  if (running?.cwd !== undefined) return running.cwd();
  throw new RegisterError(
    "this runtime reports neither Deno nor process, so there is no working " +
      "directory to search from. Pass one to `register` instead",
  );
}

/** Whether a path is there, and a refusal that is not "it is not there". */
async function present(path: string): Promise<boolean> {
  const deno = (globalThis as Partial<HasDeno>).Deno;
  if (deno !== undefined) {
    try {
      await deno.stat(path);
      return true;
    } catch (why) {
      // only absence means keep climbing. A permission error is not absence, and
      // reporting it as one says the config is missing when it is right there.
      if (why instanceof deno.errors.NotFound) return false;
      throw why;
    }
  }

  const fs = (globalThis as Partial<HasProcess>).process?.getBuiltinModule?.(
    "node:fs/promises",
  ) as { stat(p: string): Promise<unknown> } | undefined;
  if (fs === undefined) {
    throw new RegisterError(
      "this runtime has neither Deno nor node:fs/promises, so nothing here can " +
        "look for a config",
    );
  }
  try {
    await fs.stat(path);
    return true;
  } catch (why) {
    if ((why as { code?: string }).code === "ENOENT") return false;
    throw why;
  }
}

/**
 * The nearest directory at or above `from` holding a config, or `undefined`.
 *
 * Upward rather than exact, because a program is run from wherever somebody
 * happens to be standing and a project's root is not usually that place.
 */
export async function rootFrom(from: string): Promise<string | undefined> {
  let here = absolute(from);
  for (;;) {
    if (await present(joined(here, CONFIG))) return here;
    const up = parentOf(here);
    if (up === here) return undefined;
    here = up;
  }
}

/**
 * Find the project and put its macros in front of the loader.
 *
 * Exported as well as run on import, so a program that would rather do this
 * itself can await it and know when it finished. Importing for the side effect
 * cannot be awaited, which is fine for a preload and wrong for anything else.
 */
export async function register(
  from: string = whereWeAre(),
): Promise<Installed> {
  const root = await rootFrom(from);
  if (root === undefined) {
    throw new RegisterError(
      `no ${CONFIG} at ${
        absolute(from)
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

// No side effect here. Importing `rootFrom` or `register` for their own sake
// should not walk the filesystem to the root and print a complaint, which is
// what this file did: the suite printed one on every run, from a directory that
// is not a project. The preload that does run on import is `preload.ts`, one
// file over, and that is the one a runtime is pointed at.
