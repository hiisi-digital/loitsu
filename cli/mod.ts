//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The command line.
 *
 * Two verbs, and they are the same machinery pointed two ways. `build` writes
 * the twin tree and `check` writes it and runs the type checker over it.
 * Nothing here decides anything the library does not already decide; it parses
 * arguments and prints.
 *
 * This is also the `./cli` export, so everything a consumer would name to drive
 * a build from its own code comes back out of here rather than from the module
 * each happens to live in.
 *
 * @module
 */

import { build } from "./build.ts";
import { check, lines, NothingToCheck } from "./check.ts";
import { CONFIG, project, ProjectError } from "./project.ts";

export { build, check, CONFIG, lines, NothingToCheck, project, ProjectError };
export type { Build, BuildOptions, Built } from "./build.ts";
export type { Checked, CheckOptions, Said } from "./check.ts";
export type { Project } from "./project.ts";
export { skipped } from "./project.ts";
export { SKIPPED, sources } from "./sources.ts";
export type { SourceOptions } from "./sources.ts";
export { reported } from "./diagnostics.ts";
export type { Reported } from "./diagnostics.ts";
import { LspError } from "./lsp.ts";
export { INNER, lsp, LspError, spawn, stdio } from "./lsp.ts";
export type { LspOptions } from "./lsp.ts";

/** Where twins go when nobody says otherwise. Under the project, so a relative
 * import in a twin resolves the way the same import in the source does. */
export const OUT = ".loitsu/twins";

/** Everything the tool answers to.
 *
 * One list rather than a literal at each of the three places that names a verb,
 * so the dispatch, the usage and the tests cannot end up disagreeing about
 * which verbs exist. */
export const VERBS = ["build", "check", "lsp"] as const;

/** One of the verbs, as a type, so a typo in a comparison will not compile. */
export type Verb = typeof VERBS[number];

/** What the arguments came to. */
interface Arguments {
  readonly verb: string | undefined;
  readonly root: string;
  readonly out: string;
  readonly help: boolean;
  readonly version: boolean;
  /** The inner language server, when something after `--` names one. */
  readonly inner: readonly string[] | undefined;
}

/** Reads the arguments, taking the last of any repeated flag. */
export function asked(args: readonly string[]): Arguments {
  let verb: string | undefined;
  let root = ".";
  let out: string | undefined;
  let help = false;
  let version = false;
  let inner: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const one = args[i];
    // everything past `--` is the command to run, not this tool's business,
    // so it is taken whole rather than parsed for flags this tool would claim
    if (one === "--") {
      inner = args.slice(i + 1);
      break;
    }
    if (one === "-h" || one === "--help") help = true;
    else if (one === "-V" || one === "--version") version = true;
    else if (one === "--root" && i + 1 < args.length) root = args[++i];
    else if (one === "--out" && i + 1 < args.length) out = args[++i];
    else if (!one.startsWith("-") && verb === undefined) verb = one;
  }

  return {
    verb,
    root,
    out: out ?? `${root}/${OUT}`,
    help,
    version,
    inner: inner !== undefined && inner.length > 0 ? inner : undefined,
  };
}

/** What the tool says when asked, and when asked for something it has not got. */
export const USAGE =
  `loitsu - macro expansion for TypeScript, ahead of the checker

USAGE:
  loitsu <verb> [options]

VERBS:
  build             Write the twin tree, expanded, mirroring the sources
  check             Write it and type check it, reported where you wrote it
  lsp               Proxy an editor to a language server, over the twins

OPTIONS:
  --root <dir>      The tree to read. Defaults to the working directory
  --out <dir>       Where twins go. Defaults to <root>/${OUT}
  -h, --help        This
  -V, --version     The version
  -- <command>      lsp only. The language server to proxy. Defaults to
                    \`deno lsp\`

Macros come from ${CONFIG} at the root, which default-exports the registry and
the name the cache is keyed on.
`;

/** Runs one invocation and returns what the process should exit with. */
export async function main(args: readonly string[]): Promise<number> {
  const it = asked(args);

  if (it.version) {
    const { VERSION } = await import("../src/version.ts");
    console.log(VERSION);
    return 0;
  }
  if (it.help || it.verb === undefined || it.verb === "help") {
    console.log(USAGE);
    return it.verb === undefined && !it.help ? 1 : 0;
  }

  try {
    const found = await project(it.root);

    if (it.verb === VERBS[0]) {
      const done = await build(found, { root: it.root, out: it.out });
      console.log(`${done.files.length} file(s) into ${it.out}`);
      if (done.failed > 0) console.log(`${done.failed} with something to say`);
      return done.failed > 0 ? 1 : 0;
    }

    if (it.verb === VERBS[1]) {
      const done = await check(found, { root: it.root, out: it.out });
      for (const line of lines(done)) console.log(line);
      console.log(`Checked ${done.files} file(s)`);
      if (done.dropped > 0) {
        console.log(
          `${done.dropped} diagnostic(s) had nowhere in the source to point at`,
        );
      }
      return done.said.length > 0 ? 1 : 0;
    }

    if (it.verb === VERBS[2]) {
      const { lsp } = await import("./lsp.ts");
      await lsp(found, { inner: it.inner });
      return 0;
    }

    console.error(`no verb ${JSON.stringify(it.verb)}`);
    console.log(USAGE);
    return 1;
  } catch (why) {
    if (
      why instanceof ProjectError || why instanceof NothingToCheck ||
      why instanceof LspError
    ) {
      console.error(why.message);
      return 1;
    }
    throw why;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
