#!/usr/bin/env -S deno run -A
/**
 * viola, run on this package, by the library rather than through the cli.
 *
 * The cli adds two things to a run: argument parsing, and a subprocess
 * carrying a merged import map. That subprocess exists to bridge a project
 * whose config names plugins the cli has never heard of. Run from inside the
 * package its own manifest is already in effect, so the config's imports
 * resolve and the run is a function call.
 *
 * So the gate needs no published cli, which is what used to let a package be
 * blocked from checking itself by where it sat in the release order. It is the
 * same `runProject` the cli calls, so the two cannot check different things.
 *
 * @module
 */

import config from "./viola.config.ts";
import { runProject } from "@hiisi/viola";

if (import.meta.main) {
  Deno.exit(
    await runProject({
      projectRoot: new URL(".", import.meta.url).pathname,
      // The whole package. Every one of these ran `--include .` before, and
      // the in-process crawler takes a file as readily as a directory, so
      // nothing has to be enumerated and nothing gets left out by an enumeration
      // that went stale.
      include: ["."],
      preloadedConfig: config,
      env: Deno.env.toObject(),
    }),
  );
}
