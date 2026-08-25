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
    // `register.ts` and `preload.ts` deliberately do not depend on it: they ask
    // which runtime they are on and reach for that one's api. They are the two
    // modules node loads first, before anything has had a chance to shim.
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
      bin: { [BIN]: "./esm/cli/mod.js" },
    },
    postBuild(): void {
      Deno.copyFileSync("LICENSE", `${outDir}/LICENSE`);
      Deno.copyFileSync("README.md", `${outDir}/README.md`);

      // npm's own documentation is explicit that without this "the scripts are
      // started without the node executable". dnt does not add it.
      const cli = `${outDir}/esm/cli/mod.js`;
      const text = Deno.readTextFileSync(cli);
      if (!text.startsWith("#!")) {
        Deno.writeTextFileSync(cli, `#!/usr/bin/env node\n${text}`);
      }
    },
  });
} finally {
  await Deno.remove(importMapPath).catch(() => {});
}

console.log(`built ${NPM_NAME}@${manifest.version} into ${outDir}`);
