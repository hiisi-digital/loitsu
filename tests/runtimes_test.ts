//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The register module, run by the runtimes it is written for.
 *
 * This exists because a module for node and bun shipped using `Deno.cwd()` and
 * `Deno.stat()`, and every test it had passed. They all ran under deno, where
 * those work, so the suite agreed with itself perfectly about a module neither
 * target runtime could execute.
 *
 * So these spawn the real thing. No stand-in can catch that class: a stand-in is
 * written by the same person who wrote the assumption.
 *
 * A runtime that is not installed is skipped rather than failed, because the
 * absence of bun on a machine is not a defect in this package. What is not
 * allowed is skipping quietly: a run that checked nothing says so.
 *
 * @module
 */

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

/** This repository, so a fixture can reach the module under test. */
const HERE = fromFileUrl(new URL("../", import.meta.url));

/**
 * `register.ts`, in a directory node and bun can load it from.
 *
 * Its own code, verbatim. What is replaced is the two local imports, because
 * they reach `@std/path` and `typescript` through bare specifiers that resolve
 * under deno and under the published npm mirror, and under neither when a raw
 * `.ts` file is handed to node by path. Standing them in is what makes the rest
 * of the file reachable at all.
 *
 * The part under test is what is left: which global it asks for the working
 * directory, which one it asks to stat a path, and whether the climb works. That
 * is where the defect was, and none of it is stubbed.
 */
async function portable(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "loitsu_port_" });
  const source = await Deno.readTextFile(join(HERE, "register.ts"));
  await Deno.writeTextFile(
    join(dir, "install.ts"),
    "export const install = () => ({ host: 'stub', matches: () => true, remove: () => {} });\n",
  );
  await Deno.writeTextFile(
    join(dir, "project.ts"),
    "export const CONFIG = 'loitsu.config.ts';\n" +
      "export const project = async () => ({ registry: {}, against: 'stub' });\n",
  );
  await Deno.writeTextFile(
    join(dir, "register.ts"),
    source
      .replace('from "./src/install.ts"', 'from "./install.ts"')
      .replace('from "./cli/project.ts"', 'from "./project.ts"'),
  );
  // and the preload beside it, which is the module a runtime is actually pointed
  // at and the one whose whole job is to act on being imported
  await Deno.writeTextFile(
    join(dir, "preload.ts"),
    await Deno.readTextFile(join(HERE, "preload.ts")),
  );
  return dir;
}

/** The tail of a path, which is what survives a runtime resolving symlinks.
 *
 * node's `process.cwd()` gives `/private/var/...` where deno's temp directory is
 * `/var/...`, and neither is wrong. What the assertion is about is which
 * directory the climb stopped at, so it compares the name rather than the route
 * taken to it. */
const named = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? path;

/** Whether a command is on this machine at all. */
async function have(program: string): Promise<boolean> {
  try {
    const ran = await new Deno.Command(program, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return ran.success;
  } catch {
    return false;
  }
}

/** A tree with a config in it.
 *
 * Not `project`: that name belongs to the loader in `cli/project.ts`, which takes
 * a root and reads a config, and two functions of one name with different
 * signatures is a thing to get wrong later. */
async function aTree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "loitsu_rt_" });
  await Deno.writeTextFile(
    join(root, "loitsu.config.ts"),
    `import ts from "npm:typescript@5.9.3";\n` +
      `import { registry } from "${HERE}src/macro.ts";\n` +
      `const cfg = {\n` +
      `  kind: "attribute",\n` +
      `  name: "cfg",\n` +
      `  expand: (args, item) =>\n` +
      `    ts.isIdentifier(args[0]) && args[0].text === "keep" ? [item.node] : [],\n` +
      `};\n` +
      `export default { registry: registry([cfg]), against: "rt", cacheDir: undefined };\n`,
  );
  return root;
}

/** Run one line of code in a runtime, from inside the project. */
async function inRuntime(
  program: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; out: string }> {
  const ran = await new Deno.Command(program, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const read = new TextDecoder();
  return {
    code: ran.code,
    out: read.decode(ran.stdout) + read.decode(ran.stderr),
  };
}

Deno.test("node can load the register module at all", async () => {
  if (!await have("node")) {
    console.warn("node is not on this machine; nothing was checked here");
    return;
  }
  const root = await aTree();
  const where = await portable();
  try {
    // the whole finding in one line: the module used `Deno.cwd()` and `Deno.stat()`
    // and could not be loaded by the runtime it exists for
    const { out } = await inRuntime("node", [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const m = await import("${where}/register.ts");
       console.log("loaded", typeof m.register, typeof m.rootFrom);
       console.log("root", await m.rootFrom(process.cwd()));`,
    ], root);

    assertStringIncludes(out, "loaded function function");
    assert(
      !out.includes("Deno is not defined"),
      `the module reached for Deno on node:\n${out}`,
    );
    assertStringIncludes(out, `root `);
    assertStringIncludes(
      out,
      named(root),
      "the climb has to stop at the project",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(where, { recursive: true });
  }
});

Deno.test("bun can load the register module at all", async () => {
  if (!await have("bun")) {
    console.warn("bun is not on this machine; nothing was checked here");
    return;
  }
  const root = await aTree();
  const where = await portable();
  try {
    const script = join(root, "probe.ts");
    await Deno.writeTextFile(
      script,
      `const m = await import("${where}/register.ts");\n` +
        `console.log("loaded", typeof m.register, typeof m.rootFrom);\n` +
        `console.log("root", await m.rootFrom(process.cwd()));\n`,
    );
    const { out } = await inRuntime("bun", ["run", script], root);

    assertStringIncludes(out, "loaded function function");
    assert(
      !out.includes("Deno is not defined"),
      `the module reached for Deno on bun:\n${out}`,
    );
    assertStringIncludes(out, `root `);
    assertStringIncludes(
      out,
      named(root),
      "the climb has to stop at the project",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(where, { recursive: true });
  }
});

Deno.test("the search climbs on node, from a directory below the project", async () => {
  if (!await have("node")) {
    console.warn("node is not on this machine; nothing was checked here");
    return;
  }
  const root = await aTree();
  const where = await portable();
  try {
    const below = join(root, "src", "deep");
    await Deno.mkdir(below, { recursive: true });
    const { out } = await inRuntime("node", [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const m = await import("${where}/register.ts");
       console.log("root", await m.rootFrom(process.cwd()));`,
    ], below);
    assertStringIncludes(out, `root `);
    assertStringIncludes(
      out,
      named(root),
      "the climb has to stop at the project",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(where, { recursive: true });
  }
});

Deno.test("importing register does not walk the disk or say anything", async () => {
  if (!await have("node")) {
    console.warn("node is not on this machine; nothing was checked here");
    return;
  }
  const bare = await Deno.makeTempDir({ prefix: "loitsu_quiet_" });
  const where = await portable();
  try {
    // the side effect used to fire here and print a complaint from a directory
    // that is not a project, on every import, including from this suite
    const { out } = await inRuntime("node", [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `await import("${where}/register.ts"); console.log("[done]");`,
    ], bare);
    assertStringIncludes(out, "[done]");
    assert(!out.includes("loitsu:"), `importing said something:\n${out}`);
  } finally {
    await Deno.remove(bare, { recursive: true });
    await Deno.remove(where, { recursive: true });
  }
});

Deno.test("the preload module is the one that acts on import", async () => {
  if (!await have("node")) {
    console.warn("node is not on this machine; nothing was checked here");
    return;
  }
  const bare = await Deno.makeTempDir({ prefix: "loitsu_preload_" });
  const where = await portable();
  try {
    // no project here, so it reports rather than installing. Reporting is the
    // observable half; a preload that fails silently is the thing it exists
    // against.
    const { out } = await inRuntime("node", [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `await import("${where}/preload.ts"); console.log("[ran on]");`,
    ], bare);
    assertStringIncludes(out, "loitsu: not installed");
    assertStringIncludes(
      out,
      "[ran on]",
      "a preload must not take the program down",
    );
    // and it has to fail for the right reason. Reaching for `Deno` on node also
    // produces "not installed", so without this the assertion above passes
    // against the very defect these tests exist for.
    assert(
      !out.includes("Deno is not defined"),
      `the preload reached for Deno on node:\n${out}`,
    );
    assertStringIncludes(
      out,
      "loitsu.config.ts",
      "the reason has to be the missing config, not a missing global",
    );
  } finally {
    await Deno.remove(bare, { recursive: true });
    await Deno.remove(where, { recursive: true });
  }
});

Deno.test("the working directory is found without asking for Deno", async () => {
  if (!await have("node")) {
    console.warn("node is not on this machine; nothing was checked here");
    return;
  }
  const root = await aTree();
  const where = await portable();
  try {
    // `register()` with no argument is the path a preload takes, and the only
    // one that reaches the working-directory lookup. Every other test here hands
    // it a directory, so this is the one that touches what actually broke.
    const { out } = await inRuntime("node", [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const m = await import("${where}/register.ts");
       const at = await m.register();
       console.log("installed", at.host);`,
    ], root);

    assert(
      !out.includes("Deno is not defined"),
      `the default argument reached for Deno on node:\n${out}`,
    );
    assertStringIncludes(out, "installed stub");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(where, { recursive: true });
  }
});
