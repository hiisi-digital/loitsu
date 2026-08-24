//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Keeping an expansion off the critical path, without keeping it on disk as truth.
 *
 * The twin is never committed and never authoritative. It is derived, it is
 * regenerated whenever the file it came from changes, and the only reason to store
 * one at all is that regenerating it on every keystroke is work already done. So
 * this is a cache in the strict sense: losing all of it costs time and nothing else,
 * and anything it cannot verify it discards rather than trusts.
 *
 * The directory follows what the workspace already does: the XDG variable when it is
 * set to something, `$HOME/.cache` otherwise, a directory named for the tool, and a
 * version underneath so two versions of loitsu on one machine cannot read each
 * other's entries. The resolution is a pure function of the two environment values
 * so it can be tested without touching the process.
 *
 * @module
 */

import { expand, type Expanded } from "./expand.ts";
import type { Registry } from "./macro.ts";
import { dialectOf } from "./syntax.ts";
import { type Span, spanning } from "./spans.ts";

/**
 * What an entry's format is.
 *
 * Bumped whenever a stored entry's meaning changes, which retires every entry
 * written by an older loitsu without deleting anything: the old directory simply
 * stops being read. Cheaper than a migration and impossible to get half right.
 */
export const VERSION = 1;

/**
 * Where entries live, from the two environment values rather than from the process.
 *
 * `undefined` when neither is set, which is a real answer: there is no user home to
 * put a cache in, so the caller expands without one rather than inventing a path.
 */
export function cacheHome(
  xdg: string | undefined,
  home: string | undefined,
): string | undefined {
  const base = xdg && xdg.length > 0
    ? xdg
    : home && home.length > 0
    ? `${home}/.cache`
    : undefined;
  return base === undefined ? undefined : `${base}/loitsu/v${VERSION}`;
}

/** The default location, read from this process. */
export const defaultHome = (): string | undefined =>
  cacheHome(Deno.env.get("XDG_CACHE_HOME"), Deno.env.get("HOME"));

/** Separates the two halves of a key. A byte no source file and no sensible tag
 * contains, so no pair of inputs can be rearranged into one buffer: without it,
 * moving the boundary one character produces the same bytes and the same entry. */
const SEPARATOR = "\u0000";

/**
 * The name an expansion is stored under.
 *
 * `against` is everything other than the text that decides the answer: which macros
 * were in scope and what they are, the target being expanded for, any flag a macro
 * reads. loitsu cannot work that out for itself, because a macro is a function and
 * a function has no honest fingerprint, so the caller states it and is believed. A
 * caller that states it wrongly gets a stale twin, which is the one failure this
 * design cannot detect and the reason the parameter is not optional.
 */
export async function keyOf(text: string, against: string): Promise<string> {
  const buf = new TextEncoder().encode(`${against}${SEPARATOR}${text}`);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** What is written to disk. A plain object rather than the live shape, because a
 * `SpanTable` is built by a constructor that refuses malformed input, and reading
 * one back has to go through that same refusal rather than around it. */
interface Stored {
  readonly version: number;
  readonly code: string;
  readonly spans: readonly Span[];
  readonly diagnostics: Expanded["diagnostics"];
}

/**
 * Read an entry, or `undefined` if there is not a usable one.
 *
 * Every way this can fail is the same answer: no entry. A missing file, an
 * unreadable one, malformed JSON, a version from another loitsu, or a span table
 * that no longer satisfies its own invariants. The last is the one worth having.
 * Nothing stops a file under a cache directory from being edited, truncated by a
 * full disk, or written by a version that had a bug, and a span table trusted
 * without rechecking would put diagnostics on the wrong lines with no way to tell.
 */
export async function read(
  dir: string,
  key: string,
): Promise<Expanded | undefined> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(`${dir}/${key}.json`);
  } catch {
    return undefined;
  }
  try {
    const stored = JSON.parse(raw) as Stored;
    if (stored.version !== VERSION) return undefined;
    if (typeof stored.code !== "string" || !Array.isArray(stored.spans)) {
      return undefined;
    }
    return {
      code: stored.code,
      spans: spanning(stored.spans),
      diagnostics: stored.diagnostics ?? [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Store an entry, and say nothing if it cannot be stored.
 *
 * A cache that throws is worse than no cache: the caller has a correct expansion in
 * hand and would lose it to a read-only directory or a full disk.
 *
 * Written under a temporary name and renamed, so a reader never sees half a file. A
 * rename within one directory is atomic; a write to the final name truncates it
 * first and leaves it short for as long as the payload takes to land.
 *
 * **No test here distinguishes the two, and one was written and deleted rather than
 * kept.** The failure the rename removes needs the process to die mid-write, or a
 * reader to be scheduled into a window that a single `writeTextFile` call does not
 * yield inside. A test that provokes neither passes against both spellings, which
 * makes it a test that cannot fail. The reason lives here instead, where somebody
 * simplifying this will read it.
 */
export async function write(
  dir: string,
  key: string,
  value: Expanded,
): Promise<void> {
  const stored: Stored = {
    version: VERSION,
    code: value.code,
    spans: value.spans.spans,
    diagnostics: value.diagnostics,
  };
  const temp = `${dir}/${key}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(temp, JSON.stringify(stored));
    await Deno.rename(temp, `${dir}/${key}.json`);
  } catch {
    await Deno.remove(temp).catch(() => {});
  }
}

/** Where an expansion came from, which a caller watching its own hit rate wants and
 * a caller that only wants the twin can ignore. */
export interface Cached extends Expanded {
  readonly hit: boolean;
}

/**
 * The expansion, from the cache when there is one and from the macros otherwise.
 *
 * `dir` being `undefined` is the no-home case and is not an error: the macros run,
 * nothing is stored, and the answer is the same answer.
 *
 * It is required rather than defaulted to `defaultHome()`, for two reasons that only
 * showed up once it was written the other way. A default cannot be overridden with
 * `undefined`, so a caller with no home to use had no way to say so and silently got
 * the real one. And a library that reads the environment somewhere in the middle of
 * its main path is a library whose tests write to the machine they run on, which is
 * what happened. `defaultHome()` is one call and belongs at the caller.
 */
export async function cached(
  text: string,
  against: string,
  reg: Registry,
  dir: string | undefined,
  fileName?: string,
): Promise<Cached> {
  const options = { fileName };
  if (dir === undefined) return { ...expand(text, reg, options), hit: false };
  // The dialect joins the tag rather than the text, because it is the other thing
  // the expansion depends on. The file's name is deliberately not in the key: two
  // files with the same bytes and the same dialect expand identically and should
  // share an entry, which is most of what a cache buys across a repository. Two
  // files with the same bytes and different dialects do not, and keying on the name
  // would miss the first while keying on nothing would confuse the second.
  const key = await keyOf(text, `${against}:${dialectOf(fileName ?? "")}`);
  const found = await read(dir, key);
  if (found !== undefined) return { ...found, hit: true };
  const fresh = expand(text, reg, options);
  await write(dir, key, fresh);
  return { ...fresh, hit: false };
}
