//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Putting the expansion in front of a runtime's loader.
 *
 * Node and bun both let a module claim a load before the runtime compiles it,
 * and that is the whole seam: the text the runtime is handed is the twin rather
 * than what is on disk. Neither installs itself out of `node_modules`, so a
 * project names the module that calls `install` once, in the one place its
 * runtime reads.
 *
 * Deno implements node's hook and it works, so one arm serves both. What deno
 * has no seam for is checking: `deno check` reads what is on disk and cannot
 * see anything a running program registered, which is why the check verb exists
 * and why the editor is fronted by the proxy rather than hooked.
 *
 * One constraint holds on every runtime here. A hook reaches what is loaded
 * after it, so a module statically imported alongside the one that calls
 * `install` is already resolved by the time it runs. Reach the program with a
 * dynamic import, or name the installing module where the runtime reads one
 * first.
 *
 * Measured, with the controls, at
 * `.shared/design/ts-stack/probes/frontend-seams/`.
 *
 * @module
 */

import { type Diagnostic, expand } from "./expand.ts";
import type { Registry } from "./macro.ts";
import { interesting } from "./syntax.ts";

/** What a loader hands over and takes back: a path, its text, its text again. */
export type Rewrite = (path: string, text: string) => string;

/** Which runtime a seam was found in. */
export type Host = "node" | "bun" | "deno";

/** What `install` found, so a caller can say which seam it got rather than
 * inferring it from the runtime a second time. */
export interface Installed {
  /** The runtime the hook went into. */
  readonly host: Host;
  /** Which paths this seam will expand. The one the options named, or the
   * default, so a caller reporting on a run says what was considered rather
   * than working the answer out a second time and getting a different one. */
  readonly matches: (path: string) => boolean;
  /** Takes the hook back out. Bun keeps its plugins for the life of the
   * process, so this throws there rather than pretending. */
  readonly remove: () => void;
}

/** What `install` needs beyond the macros. */
export interface InstallOptions {
  /** Which paths to expand. Defaults to the ones that carry bodies. */
  readonly matches?: (path: string) => boolean;
  /** Reported per file, once per expansion, with the path it came from. A
   * diagnostic is positioned in the authored text, so a caller reporting one is
   * pointing at the file somebody wrote rather than at the twin. */
  readonly onDiagnostic?: (path: string, diagnostic: Diagnostic) => void;
}

/**
 * Node's loader, as the hook shape `module.registerHooks` takes.
 *
 * The load is delegated first and its result rewritten, rather than read off
 * disk directly. That is not a shortcut: the delegated result carries the
 * format node worked out for the file, and a `.ts` file returned as `module`
 * reaches V8 with its type annotations still on it and fails there. Handing the
 * format back unchanged is what keeps the twin a TypeScript twin.
 */
export function nodeHook(
  rewrite: Rewrite,
  matches: (path: string) => boolean,
): NodeHooks {
  return {
    load: (url, context, next) =>
      loadRewritten(rewrite, matches, url, context, next),
  };
}

/** One load, delegated and then rewritten. Named rather than inlined above so
 * the hook object stays the shape it is and the work stays readable. */
function loadRewritten(
  rewrite: Rewrite,
  matches: (path: string) => boolean,
  url: string,
  context: unknown,
  next: (url: string, context: unknown) => NodeLoaded,
): NodeLoaded {
  const got = next(url, context);
  const path = pathOf(url);
  if (path === undefined || !matches(path)) return got;
  const text = typeof got.source === "string"
    ? got.source
    : new TextDecoder().decode(got.source);
  return { ...got, source: rewrite(path, text), shortCircuit: true };
}

/** Bun's loader, as the plugin shape `Bun.plugin` takes. */
export function bunPlugin(
  rewrite: Rewrite,
  matches: (path: string) => boolean,
): BunPlugin {
  return {
    name: "loitsu",
    setup(build) {
      // Bun filters by pattern rather than by predicate, so the pattern is the
      // widest thing `matches` could accept and `matches` decides inside.
      build.onLoad({ filter: /\.[cm]?tsx?$/ }, async (args) => {
        const text = await readSource(args.path);
        return {
          contents: matches(args.path) ? rewrite(args.path, text) : text,
          loader: args.path.endsWith("x") ? "tsx" : "ts",
        };
      });
    },
  };
}

/** Put the expansion in front of whichever loader this runtime has. */
export function install(
  registry: Registry,
  options: InstallOptions = {},
): Installed {
  const matches = options.matches ?? interesting;
  const rewrite: Rewrite = (path, text) => {
    const out = expand(text, registry, { fileName: path });
    for (const one of out.diagnostics) options.onDiagnostic?.(path, one);
    return out.code;
  };

  const bun = (globalThis as Partial<HasBun>).Bun;
  if (bun !== undefined) {
    bun.plugin(bunPlugin(rewrite, matches));
    return {
      host: "bun",
      matches,
      remove: () => {
        throw new Error(
          "bun keeps a plugin for the life of the process, so this one cannot be taken out; " +
            "start a process without the preload instead",
        );
      },
    };
  }

  const running = (globalThis as Partial<HasProcess>).process;
  const version = running?.versions?.node;
  if (version !== undefined) {
    // Reached through `getBuiltinModule` rather than imported, because naming
    // `node:module` at the top of this file would make the module itself
    // unloadable anywhere the specifier does not resolve.
    const builtin = running?.getBuiltinModule?.("node:module") as
      | NodeModuleApi
      | undefined;
    if (builtin?.registerHooks === undefined) {
      throw new Error(
        `this runtime reports node ${version} and has no module.registerHooks, which is ` +
          "where the expansion goes. node 22.15 and 23.5 are where it arrived",
      );
    }
    const { deregister } = builtin.registerHooks(nodeHook(rewrite, matches));
    return {
      host: (globalThis as Partial<HasDeno>).Deno === undefined
        ? "node"
        : "deno",
      matches,
      remove: deregister,
    };
  }

  throw new Error(
    "this runtime has no loader to put the expansion in front of, so nothing here would " +
      "ever expand. bun, and anything implementing node's module hooks, are what is served",
  );
}

/** The filesystem path a loader's specifier names, or nothing when it names
 * something that is not a file, such as a data or node builtin specifier. */
function pathOf(url: string): string | undefined {
  if (!url.startsWith("file://")) return undefined;
  return decodeURIComponent(new URL(url).pathname);
}

/** Reads a file, through whichever runtime is asking. Only bun reaches this,
 * and bun implements node's `fs`. */
async function readSource(path: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return await fs.readFile(path, "utf8");
}

/** The half of node's hook api this uses. Declared rather than imported,
 * because importing node's types would make deno's check need them. */
export interface NodeHooks {
  load(
    url: string,
    context: unknown,
    next: (url: string, context: unknown) => NodeLoaded,
  ): NodeLoaded;
}

/** What node's `load` hook passes along. */
export interface NodeLoaded {
  readonly format: string | null | undefined;
  readonly source?: string | Uint8Array;
  readonly shortCircuit?: boolean;
}

interface NodeModuleApi {
  registerHooks?: (hooks: NodeHooks) => { deregister: () => void };
}

interface HasProcess {
  process: {
    versions?: { node?: string };
    getBuiltinModule?: (name: string) => unknown;
  };
}

/** The half of bun's plugin api this uses. */
export interface BunPlugin {
  readonly name: string;
  setup(build: BunBuilder): void;
}

/** What bun hands a plugin's `setup`. */
export interface BunBuilder {
  onLoad(
    filter: { filter: RegExp },
    run: (
      args: { path: string },
    ) => Promise<{ contents: string; loader: string }>,
  ): void;
}

interface HasBun {
  Bun: { plugin: (plugin: BunPlugin) => void };
}

interface HasDeno {
  Deno: unknown;
}
