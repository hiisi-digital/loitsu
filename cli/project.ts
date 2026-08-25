/**
 * Where a run finds the macros it is meant to expand.
 *
 * A project says so in `loitsu.config.ts` at its root, which default-exports the
 * registry and the name the expansion is keyed on. A config file rather than a
 * key in a manifest, because the registry is code: a macro is a function, and no
 * amount of JSON says which one.
 *
 * The name is the load-bearing part and is the one thing a project has to keep
 * honest. It goes into the cache key, so a twin built by one set of macros is
 * never served after the set has changed. Anything that moves when the macros
 * move works: a package version, a lockfile digest, a date.
 *
 * @module
 */

import { isAbsolute, join, toFileUrl } from "@std/path";
import type { Registry } from "../src/macro.ts";
import { SKIPPED } from "./sources.ts";

/** What a project's config says. */
export interface Project {
  /** The macros in scope for every file in this project. */
  readonly registry: Registry;
  /** What the expansion is keyed on, so a change to the macro set misses the
   * cache rather than serving a twin the old set built. */
  readonly against: string;
  /** Where twins are cached, or `undefined` for no cache. Left out means the
   * default home, which is what a project usually wants. */
  readonly cacheDir?: string | undefined;
  /** Directory names to stay out of, on top of the usual ones. */
  readonly skip?: readonly string[];
}

/** The file a project puts its macros in. */
export const CONFIG = "loitsu.config.ts";

/** Why a config could not be used. Reported rather than thrown, because the
 * command line says it better than a stack trace does. */
export class ProjectError extends Error {
  override readonly name = "ProjectError";
}

/**
 * The project rooted at `root`.
 *
 * The config is imported, so it runs. That is the point of it being TypeScript
 * and it is also the reason the path is checked before the import: a config
 * outside the root would be somebody else's code running under this project's
 * name.
 */
export async function project(root: string): Promise<Project> {
  const path = isAbsolute(root)
    ? join(root, CONFIG)
    : join(Deno.cwd(), root, CONFIG);

  let loaded: { default?: unknown };
  try {
    loaded = await import(toFileUrl(path).href);
  } catch (why) {
    throw new ProjectError(
      `no ${CONFIG} at ${path}, and a run has no macros without one: ${
        why instanceof Error ? why.message : String(why)
      }`,
    );
  }

  const found = loaded.default;
  if (found === null || typeof found !== "object") {
    throw new ProjectError(
      `${path} has to default-export the project, and exports ${typeof found} instead`,
    );
  }

  const { registry, against } = found as Partial<Project>;
  if (
    registry === undefined ||
    typeof registry.attribute !== "function" ||
    typeof registry.function !== "function"
  ) {
    throw new ProjectError(
      `${path} exports no registry, so nothing would expand`,
    );
  }
  if (typeof against !== "string" || against === "") {
    throw new ProjectError(
      `${path} names nothing to key the cache on, so a twin built by older macros could be served; ` +
        "give `against` anything that moves when the macros move",
    );
  }

  return found as Project;
}

/** Every directory a run stays out of, the usual ones plus the project's. */
export function skipped(found: Project): readonly string[] {
  return [...SKIPPED, ...(found.skip ?? [])];
}
