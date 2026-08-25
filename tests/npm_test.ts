//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The npm package, packed and installed and run the way somebody installing it does.
 *
 * `runtimes_test.ts` spawns node and bun against the source, with the two local
 * imports stood in. That catches a module reaching for the wrong runtime's api.
 * It cannot catch anything dnt does on the way out, and dnt is a compiler: it
 * rewrites `Deno.` calls, it rewrites `import.meta`, and where it gets one of
 * those wrong the source is right and the artifact is broken.
 *
 * The command's entry guard is the standing case. `cli/mod.ts` ends in
 * `import.meta.main`, dnt lowers it to a comparison against `process.argv[1]`,
 * and npm installs a bin as a symlink, so the two never match and every install
 * path prints nothing and exits zero. Running the emitted file directly works
 * the whole time, which is what makes it invisible.
 *
 * So this builds it, packs it, installs it into an empty project and runs it
 * through the symlink npm actually creates.
 *
 * The `Twins` arm is here for a different reason. `watch_test.ts` covers the
 * default reader under deno, where `Deno.readTextFile` is simply there. What it
 * cannot say is whether the shim dnt puts in its place answers the same way, and
 * that is the reader every npm consumer gets.
 *
 * A runtime that is not installed is skipped rather than failed. Skipping says
 * so: a run that checked nothing is not a run that passed.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { have, inRuntime as ran } from "./runtime_helpers.ts";
import { VERSION } from "../src/version.ts";

/** This repository. */
const HERE = fromFileUrl(new URL("../", import.meta.url));

/** Long enough for a dnt build and an npm install on a cold cache. */
const PATIENCE = 300_000;

/** When a path was last written, or zero where there is nothing there. */
async function changed(path: string): Promise<number> {
  try {
    const seen = await Deno.stat(path);
    return seen.mtime?.getTime() ?? 0;
  } catch {
    return 0;
  }
}

/** The newest write anywhere under a directory, or of one file. */
async function newest(path: string): Promise<number> {
  let at = await changed(path);
  let dir: Deno.DirEntry[];
  try {
    dir = [...Deno.readDirSync(path)];
  } catch {
    return at;
  }
  for (const entry of dir) {
    at = Math.max(at, await newest(join(path, entry.name)));
  }
  return at;
}

/**
 * The built package, packed into a tarball, built first where it is stale.
 *
 * The build runs as a subprocess rather than in here. It writes into `./npm`,
 * which the test task deliberately does not grant, and giving the suite write
 * access to its own repository to make one test convenient is the wrong trade.
 *
 * Built once per run and shared, because a dnt build with `typeCheck: "both"`
 * is not something to do four times.
 */
const packed: Promise<string> = (async () => {
  const sources = [
    "src",
    "cli",
    "mod.ts",
    "register.ts",
    "preload.ts",
    "deno.json",
    "scripts/build-npm.ts",
  ];
  let latest = 0;
  for (const each of sources) {
    latest = Math.max(latest, await newest(join(HERE, each)));
  }
  const built = await changed(join(HERE, "npm", "package.json"));

  if (built < latest) {
    const done = await ran("deno", ["run", "-A", "scripts/build-npm.ts"], HERE);
    assertEquals(done.code, 0, `the npm build failed:\n${done.out}`);
  }

  const npm = join(HERE, "npm");
  const done = await ran("npm", ["pack", "--silent"], npm);
  assertEquals(done.code, 0, `npm pack failed:\n${done.out}`);
  const name = done.out.trim().split("\n").pop() ?? "";
  assert(name.endsWith(".tgz"), `npm pack named no tarball, said: ${done.out}`);
  return join(npm, name);
})();

/**
 * An empty project with the package installed into it.
 *
 * From the tarball, not from the directory. `npm install ../npm` symlinks, and a
 * symlinked package is not the thing anybody receives: the whole point of the
 * entry-point test below is what npm does to a real install's paths.
 */
async function consumer(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "loitsu_npm_" });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  const done = await ran("npm", ["install", "--silent", await packed], dir);
  assertEquals(done.code, 0, `the install failed:\n${done.out}`);
  return dir;
}

/** A file with nothing in it that needs expanding, and a place to cache. */
async function aFile(dir: string): Promise<string> {
  const path = join(dir, "app.ts");
  await Deno.writeTextFile(path, "export const x = 1;\n");
  return path;
}

Deno.test("the installed command runs from the path npm puts it on", async () => {
  if (!await have("node")) {
    console.warn("node is not on this machine; nothing was checked here");
    return;
  }
  const dir = await consumer();

  // Executed rather than passed to a runtime, because that is what a shell does
  // when somebody types the command. npm writes `.bin/loitsu` as a symlink and
  // the shebang sends it to node, so this is the path behind `npm install -g`,
  // `bun install -g` and `npx` alike: which package manager installed it does
  // not decide which runtime runs it.
  const bin = join(dir, "node_modules", ".bin", "loitsu");
  const done = await ran(bin, ["--version"], dir);

  assertEquals(done.code, 0, `the command failed:\n${done.out}`);
  assertStringIncludes(
    done.out,
    VERSION,
    `the command printed no version, which is what an entry guard comparing ` +
      `import.meta.url against a symlinked argv[1] does:\n${done.out}`,
  );
});

Deno.test("the installed command runs when bun is the one running it", async () => {
  if (!await have("bun")) {
    console.warn("bun is not on this machine; nothing was checked here");
    return;
  }
  const dir = await consumer();

  // The same symlink as the test above, handed to bun instead of executed. That
  // is `bun run` and `bunx --bun`, and it is deliberately the symlink rather
  // than the file behind it, because the link is where the two runtimes parted:
  // node reports the link in `argv[1]` and the realpath in `import.meta.url`,
  // bun reports the realpath in both.
  //
  // So this pair is the whole finding. Against the entry point this replaced,
  // the test above goes red and this one stays green, which is a shape worse
  // than plain broken: a bun user reaching for `bun run` would have concluded
  // the command was fine. Against the entry point here, both are green, because
  // nothing is asking who is running it any more.
  const bin = join(dir, "node_modules", ".bin", "loitsu");
  const done = await ran("bun", [bin, "--version"], dir);

  assertEquals(done.code, 0, `the command failed under bun:\n${done.out}`);
  assertStringIncludes(done.out, VERSION, done.out);
});

for (const runtime of ["node", "bun"] as const) {
  Deno.test(`a Twins built with no reader works on ${runtime}`, async () => {
    if (!await have(runtime)) {
      console.warn(
        `${runtime} is not on this machine; nothing was checked here`,
      );
      return;
    }
    const dir = await consumer();
    const path = await aFile(dir);
    await Deno.writeTextFile(
      join(dir, "twin.mjs"),
      `import { Twins } from "loitsu";\n` +
        `import { registry } from "loitsu/macro";\n` +
        `const twins = new Twins({\n` +
        `  registry: registry([]),\n` +
        `  against: "npm-test",\n` +
        `  cacheDir: undefined,\n` +
        `});\n` +
        `const twin = await twins.get(${JSON.stringify(path)});\n` +
        `console.log(twin === undefined\n` +
        `  ? "NO TWIN: " + JSON.stringify(twins.failure(${
          JSON.stringify(path)
        }))\n` +
        `  : "TWIN: " + twin.code.trim());\n`,
    );
    const done = await ran(runtime, [join(dir, "twin.mjs")], dir);

    assertEquals(done.code, 0, `the script failed:\n${done.out}`);
    assertStringIncludes(
      done.out,
      "TWIN:",
      `no twin came back on ${runtime} with the reader a consumer gets by ` +
        `default:\n${done.out}`,
    );
    assertStringIncludes(done.out, "export const x = 1;", done.out);
  });
}

Deno.test("the package declares the entry points it is documented with", async () => {
  await packed;
  const manifest = JSON.parse(
    await Deno.readTextFile(join(HERE, "npm", "package.json")),
  ) as { exports?: Record<string, unknown>; bin?: Record<string, string> };

  // Every specifier the readme and the module docs tell somebody to type. A
  // package can build, install and run and still have the one line in the docs
  // point at an export it does not have.
  for (
    const named of [
      ".",
      "./syntax",
      "./macro",
      "./register",
      "./preload",
      "./cli",
    ]
  ) {
    assert(
      manifest.exports?.[named] !== undefined,
      `the package declares no ${named} export, and something documents it`,
    );
  }
  assertEquals(
    manifest.bin?.loitsu,
    "./esm/bin.js",
    "the command has to be its own entry point rather than the module that " +
      "ends in an entry guard dnt cannot lower through a symlink",
  );
});
