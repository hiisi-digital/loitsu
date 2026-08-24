//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The one thing that reads the source.
 *
 * Everything downstream sees twins. The checker is handed a twin, the inner
 * language server is handed a twin, and neither is ever given the file the author
 * is actually editing, because that file contains syntax neither of them accepts.
 * This is the seam where the source turns into a twin, and it is deliberately the
 * only one: a second reader would be a second answer to what a file currently says,
 * and the two would disagree the first time an editor wrote a file twice quickly.
 *
 * So `Twins` holds the current twin of every path anybody has asked about, keeps it
 * current as files change, and is the sole place `Deno.readTextFile` is called on a
 * source file.
 *
 * Rebuilding is separated from watching on purpose. `Twins` knows what to do when a
 * path changes and nothing about where that news came from; `watch` is the adapter
 * that turns filesystem events into those calls. That split is what makes the
 * interesting behaviour testable without a real filesystem racing a real clock.
 *
 * @module
 */

import { type Cached, cached } from "./cache.ts";
import type { Registry } from "./macro.ts";

/** Reads a file's current text. Injectable so the rebuild rules can be tested
 * without a filesystem, and so a language server that already holds an unsaved
 * buffer can answer from that instead of from disk. */
export type Reader = (path: string) => Promise<string>;

/** What every rebuild's result carries, whether or not it produced a twin. */
export interface Rebuilt {
  /** The path this came from. */
  readonly path: string;
  /** Which change produced it. Rises for a given path and never falls, which is
   * what lets a slow rebuild recognise that it has been overtaken. */
  readonly generation: number;
}

/** What a path currently expands to, plus how it was obtained. */
export interface Twin extends Cached, Rebuilt {}

/** Why a path has no twin. A file being unreadable is an ordinary thing that
 * happens constantly while an editor saves, so it is reported rather than thrown. */
export interface Unreadable extends Rebuilt {
  /** What the read failed with, as its constructor name. */
  readonly why: string;
}

/** What a `Twins` needs to turn a path into a twin. */
export interface TwinsOptions {
  /** The macros in scope. */
  readonly registry: Registry;
  /** Names what the expansion was run against, so a change to the macro set
   * misses the cache rather than serving a twin built by different macros. */
  readonly against: string;
  /** Where the cache lives, or `undefined` for none. Required rather than
   * defaulted, because a caller that means "no cache" must be able to say so. */
  readonly cacheDir: string | undefined;
  /** How to read a file. Defaults to reading it off disk. */
  readonly read?: Reader;
}

/**
 * The current twin of every path anybody has asked about.
 *
 * Two rules govern everything here. A twin is never older than the last change
 * that was acknowledged for its path, and a rebuild that has been overtaken throws
 * its own result away rather than storing it.
 */
export class Twins {
  readonly #registry: Registry;
  readonly #against: string;
  readonly #cacheDir: string | undefined;
  readonly #read: Reader;

  /** The newest change acknowledged per path. */
  readonly #seen = new Map<string, number>();
  /** The generation the stored twin was built from, per path. */
  readonly #built = new Map<string, number>();
  readonly #twins = new Map<string, Twin>();
  readonly #failed = new Map<string, Unreadable>();

  constructor(options: TwinsOptions) {
    this.#registry = options.registry;
    this.#against = options.against;
    this.#cacheDir = options.cacheDir;
    this.#read = options.read ?? ((path) => Deno.readTextFile(path));
  }

  /** Every path currently holding a twin. */
  get paths(): readonly string[] {
    return [...this.#twins.keys()];
  }

  /** The twin held for a path right now, without building one. `undefined` both
   * for a path nobody has asked about and for one whose last read failed, which
   * `failure` tells apart. */
  peek(path: string): Twin | undefined {
    return this.#twins.get(path);
  }

  /** Why a path's last rebuild produced no twin, if that is what happened. */
  failure(path: string): Unreadable | undefined {
    return this.#failed.get(path);
  }

  /** The twin for a path, building one if there is none yet.
   *
   * This is what a language server calls when a file is opened: nothing has
   * changed, so nothing has been rebuilt, and the twin still has to exist. */
  async get(path: string): Promise<Twin | undefined> {
    if (!this.#seen.has(path)) {
      this.#seen.set(path, 0);
      await this.#rebuild(path);
    }
    return this.#twins.get(path);
  }

  /** Acknowledge that a path changed, and rebuild its twin.
   *
   * Returns once this change has been accounted for, which is either its own twin
   * stored or a newer change having overtaken it. Awaiting it is how a test, or a
   * caller that wants to act on the result, avoids guessing at a delay. */
  async changed(path: string): Promise<void> {
    this.#seen.set(path, (this.#seen.get(path) ?? 0) + 1);
    await this.#rebuild(path);
  }

  /** Forget a path, because the file is gone or nobody is looking at it any more.
   *
   * The generation is forgotten with it, so a rebuild still in flight for this
   * path finds no record to beat and discards itself. */
  forget(path: string): void {
    this.#seen.delete(path);
    this.#built.delete(path);
    this.#twins.delete(path);
    this.#failed.delete(path);
  }

  async #rebuild(path: string): Promise<void> {
    // Stamped before the read, so anything that changes while the read and the
    // expansion are in flight raises `#seen` above this and wins below.
    const at = this.#seen.get(path) ?? 0;

    let text: string;
    try {
      text = await this.#read(path);
    } catch (err) {
      this.#store(path, at, undefined, (err as Error).constructor.name);
      return;
    }

    const out = await cached(
      text,
      this.#against,
      this.#registry,
      this.#cacheDir,
      // The path, so a `.tsx` file is parsed as one. This is the only place that
      // knows it: `expand` sees text and nothing else.
      path,
    );
    this.#store(path, at, { ...out, path, generation: at }, "");
  }

  /** Stores a rebuild's result, unless it has been overtaken or the path was
   * forgotten while it ran. */
  #store(
    path: string,
    at: number,
    twin: Twin | undefined,
    why: string,
  ): void {
    // Not `>=`. An equal generation means this rebuild and the stored one saw the
    // same change, so redoing the work cannot have found anything different, and
    // letting it through would make two rebuilds of one change order-dependent.
    if (at <= (this.#built.get(path) ?? -1)) return;
    // A path forgotten while this ran has no `#seen` entry, and rebuilding it here
    // would resurrect a file somebody deleted.
    if (!this.#seen.has(path)) return;

    this.#built.set(path, at);
    if (twin === undefined) {
      this.#twins.delete(path);
      this.#failed.set(path, { path, generation: at, why });
    } else {
      this.#twins.set(path, twin);
      this.#failed.delete(path);
    }
  }
}

/** The signal event a watch listens for and then stops listening for. */
const ABORT = "abort";

/** Whether a path is one loitsu has any business expanding. TypeScript only, and
 * not the declaration files, which carry no bodies for a macro to be written in. */
export function interesting(path: string): boolean {
  return (path.endsWith(".ts") || path.endsWith(".tsx")) &&
    !path.endsWith(".d.ts");
}

/** What a filesystem watch needs to keep a `Twins` current. */
export interface WatchOptions {
  /** The twins to keep current. */
  readonly twins: Twins;
  /** Files and directories to watch, recursively. */
  readonly paths: readonly string[];
  /** Stops the watch. Without one it runs until the process ends. */
  readonly signal?: AbortSignal;
  /** How long to let a burst of events settle before rebuilding. An editor saving
   * one file emits several events, and rebuilding on each is work thrown away. */
  readonly settleMs?: number;
  /** Which paths to expand. Defaults to `interesting`. */
  readonly matches?: (path: string) => boolean;
  /** Called after each settled batch, with the paths that were rebuilt. The hook a
   * language server uses to push fresh diagnostics, and what a test waits on. */
  readonly onBatch?: (paths: readonly string[]) => void | Promise<void>;
}

/**
 * Keeps `twins` current as files change, until the signal aborts.
 *
 * Event kinds are deliberately not switched on. Deno reports create, modify,
 * remove and rename, editors disagree about which they produce for an ordinary
 * save, and the rename an atomic save performs arrives as a kind whose meaning
 * depends on which side of it a given path was. Asking whether the file is there
 * now is one syscall and is right in every one of those cases.
 */
export async function watch(options: WatchOptions): Promise<void> {
  const matches = options.matches ?? interesting;
  const settleMs = options.settleMs ?? 20;
  const watcher = Deno.watchFs([...options.paths], { recursive: true });

  const stop = () => watcher.close();
  options.signal?.addEventListener(ABORT, stop, { once: true });

  const pending = new Set<string>();
  // `ReturnType` rather than `number`, because the npm typescript dependency pulls
  // node's typings in and its `setTimeout` returns a `Timeout` object.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settling: PromiseWithResolvers<void> | undefined;

  const flush = async (): Promise<void> => {
    timer = undefined;
    const batch = [...pending];
    pending.clear();
    for (const path of batch) {
      if (await exists(path)) await options.twins.changed(path);
      else options.twins.forget(path);
    }
    await options.onBatch?.(batch);
    settling?.resolve();
    settling = undefined;
  };

  try {
    for await (const event of watcher) {
      for (const path of event.paths) {
        if (matches(path)) pending.add(path);
      }
      if (pending.size === 0) continue;
      settling ??= Promise.withResolvers<void>();
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void flush(), settleMs);
    }
  } catch (err) {
    // Closing the watcher to stop it makes the loop throw, which is the ordinary
    // way this ends rather than a failure.
    if (!(err instanceof Deno.errors.BadResource)) throw err;
  } finally {
    options.signal?.removeEventListener(ABORT, stop);
    if (timer !== undefined) {
      clearTimeout(timer);
      // A batch collected but never flushed would be silently dropped, leaving
      // twins older than changes the watch had already accepted.
      await flush();
    }
  }
}

/** Whether a path is there now. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
