//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The npm half, built from the same source jsr publishes.
 *
 * Two registries and one tree. jsr takes the TypeScript as it stands; npm wants
 * JavaScript with a `package.json`, which is what dnt produces here.
 *
 * The name differs between them and that is deliberate. jsr scopes everything,
 * so it is `@hiisi/loitsu` there. npm has `loitsu` free, and an unscoped name is
 * what somebody types.
 *
 * ```bash
 * deno task build:npm
 * ```
 *
 * @module
 */

import { build, emptyDir } from "jsr:@deno/dnt@0.41.3";

/** Unscoped, because npm has the name and a scope buys nothing here. */
const NPM_NAME = "loitsu";
/** What `npm install -g` should put on the path. */
const BIN = "loitsu";

// A mutation run rewrites source files in place and puts them back afterwards,
// so a build started while one is live compiles a deliberate defect and leaves
// it in `npm/` looking like any other artifact. Nothing about the result says
// where it came from, and a reader who finds it has found a shipped bug that
// does not exist.
//
// The lock is `tools/mutate.ts`'s own, so this refuses on the same fact the
// sweep refuses a second sweep on.
const MUTATE_LOCK = Deno.env.get("MUTATE_LOCK") ?? ".mutate.lock";
if (await Deno.stat(MUTATE_LOCK).then(() => true).catch(() => false)) {
  console.error(
    `${MUTATE_LOCK} is there, so a mutation run holds the source right now and ` +
      `anything built from it would carry the mutant. Wait for it to finish.`,
  );
  Deno.exit(1);
}

const manifest = JSON.parse(await Deno.readTextFile("deno.json")) as {
  version: string;
  license: string;
  imports: Record<string, string>;
};
const outDir = "./npm";
await emptyDir(outDir);

// dnt is given deno.json's own import map rather than a second copy of it.
// Ante learned this the expensive way: a hand-written list drifted from the
// manifest by one entry, dnt met a specifier it could not resolve, left it in
// the output and declared no dependency for it, and the published package threw
// on first use.
const importMapPath = "./npm_import_map.json";
await Deno.writeTextFile(
  importMapPath,
  JSON.stringify({ imports: manifest.imports }, null, 2),
);

try {
  await build({
    entryPoints: [
      "./mod.ts",
      { name: "./syntax", path: "./src/syntax.ts" },
      { name: "./macro", path: "./src/macro.ts" },
      { name: "./register", path: "./register.ts" },
      { name: "./preload", path: "./preload.ts" },
      { name: "./cli", path: "./cli/mod.ts" },
    ],
    outDir,
    importMap: importMapPath,
    // The whole shim, not the test-only form. The command reads and writes files
    // and spawns a type checker, and `{ test: false }` puts the shim nowhere, so
    // the built package throws `Deno is not defined` on the first call.
    //
    // `register.ts` and `preload.ts` ask which runtime they are on rather than
    // assuming, because they are the two modules a runtime loads first. dnt
    // shims them anyway: it rewrites their `globalThis` to a proxy that answers
    // `Deno` unconditionally, so on node they take the branch they were written
    // to avoid and reach `@deno/shim-deno` instead. That works, and it is not
    // what the source says happens, so it is written down here.
    shims: { deno: true },
    typeCheck: "both",
    // ESM only. The command uses top-level await, which no commonjs form has.
    scriptModule: false,
    test: false,
    skipSourceOutput: true,
    compilerOptions: { lib: ["ES2022"], target: "ES2022" },
    package: {
      name: NPM_NAME,
      version: manifest.version,
      description:
        "Macro expansion for TypeScript, ahead of the type checker. Your editor shows the file you wrote, carrying the diagnostics the expansion produced.",
      license: manifest.license,
      type: "module",
      repository: {
        type: "git",
        url: "git+https://github.com/hiisi-digital/loitsu.git",
      },
      bugs: { url: "https://github.com/hiisi-digital/loitsu/issues" },
      homepage: "https://github.com/hiisi-digital/loitsu#readme",
      keywords: [
        "macro",
        "typescript",
        "transform",
        "language-server",
        "source-map",
        "cfg",
      ],
      // `module.registerHooks` is what the expansion goes in front of, and it
      // arrived in 22.15 and 23.5. Below that the package installs and the hook
      // has nowhere to go, which `install.ts` says out loud rather than failing
      // somewhere further along.
      engines: { node: ">=22.15" },
      bin: { [BIN]: "./esm/bin.js" },
    },
    postBuild(): void {
      Deno.copyFileSync("LICENSE", `${outDir}/LICENSE`);
      Deno.copyFileSync("README.md", `${outDir}/README.md`);

      // The command's own entry point, written here rather than taken from
      // `cli/mod.ts`.
      //
      // That module ends in `if (import.meta.main)`, and dnt lowers it to a
      // comparison between `import.meta.url` and `process.argv[1]`. npm installs
      // a bin as a symlink, so node reports the link in `argv[1]` and the real
      // path in `import.meta.url`, the two never match, and the command exits
      // zero having printed nothing. Every documented install path goes through
      // that symlink: `npm install -g`, `bun install -g`, `npx`, `bunx`.
      //
      // So the bin does not ask whether it is the program being run. It is.
      //
      // npm's own documentation is explicit that without the shebang "the
      // scripts are started without the node executable". dnt does not add it.
      Deno.writeTextFileSync(
        `${outDir}/esm/bin.js`,
        `#!/usr/bin/env node
import { main } from "./cli/mod.js";
process.exitCode = await main(process.argv.slice(2));
`,
      );
    },
  });
} finally {
  await Deno.remove(importMapPath).catch(() => {});
}

console.log(`built ${NPM_NAME}@${manifest.version} into ${outDir}`);
