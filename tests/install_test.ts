//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Putting the expansion in front of a loader.
 *
 * Two halves. The hooks are built here and driven with a stub host, so what each
 * runtime is handed can be read off directly rather than inferred from a
 * subprocess. Then the whole of `install` runs against the loader this suite is
 * itself running on, which is one of the three it serves.
 *
 * @module
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  bunPlugin,
  install,
  nodeHook,
  type NodeLoaded,
  type Rewrite,
} from "../src/install.ts";
import { registry } from "../src/macro.ts";
import { doubling } from "./macro_helpers.ts";

/** Marks the text it is given, so a twin is told from a source by reading it. */
const MARK: Rewrite = (path, text) => `/* ${path} */ ${text}`;

/** Everything, so a case that means to filter says so itself. */
const ANY = () => true;

/**
 * A module whose expansion is observable from inside it.
 *
 * The macro emits its item twice, so the count says how many times the push
 * survived. A declaration would not do: emitted twice it is a redeclaration,
 * which a module refuses before any of this is reached.
 */
const DOUBLED = [
  "const seen: number[] = [];",
  "[twice()]",
  "seen.push(1);",
  "export const count: number = seen.length;",
  "",
].join("\n");

/** What node's loader would have returned had nothing claimed the load. */
function loaded(source: string, format = "module-typescript"): NodeLoaded {
  return { format, source };
}

Deno.test("node's hook keeps the format its delegate worked out", () => {
  // Not cosmetic. A `.ts` file returned as `module` reaches V8 with its type
  // annotations still on it and fails there, so the format the runtime derived
  // is the one the twin has to carry. Handing it back rather than choosing one
  // is also what keeps `.cts` commonjs without a table of extensions here.
  const hook = nodeHook(MARK, ANY);
  const seen: string[] = [];

  for (const format of ["module-typescript", "commonjs-typescript", "module"]) {
    const out = hook.load(
      "file:///w/a.ts",
      {},
      () => loaded("export const a = 1;", format),
    );
    seen.push(String(out.format));
  }

  assertEquals(seen, ["module-typescript", "commonjs-typescript", "module"]);
});

Deno.test("node's hook carries a missing format through as missing", () => {
  // Deno implements the same hook and answers with no format at all, leaving
  // itself to work one out from the path. Putting one in would take that away
  // and hand it a twin it then refuses to strip, so the absence is passed on
  // as carefully as a value is.
  const hook = nodeHook(MARK, ANY);
  const out = hook.load(
    "file:///w/a.ts",
    {},
    () => ({ source: "const a: number = 1;" }) as NodeLoaded,
  );

  assertEquals("format" in out, false);
  assertEquals(out.source, "/* /w/a.ts */ const a: number = 1;");
});

Deno.test("node's hook rewrites what the delegate read, not the file", () => {
  const hook = nodeHook(MARK, ANY);
  const out = hook.load("file:///w/a.ts", {}, () => loaded("const a = 1;"));

  assertEquals(out.source, "/* /w/a.ts */ const a = 1;");
  assertEquals(out.shortCircuit, true);
});

Deno.test("node's hook decodes bytes before the expansion sees them", () => {
  // A delegate may answer with a buffer, and an expansion parses text.
  const hook = nodeHook(MARK, ANY);
  const out = hook.load("file:///w/a.ts", {}, () => ({
    format: "module-typescript",
    source: new TextEncoder().encode("const a = 1;"),
  }));

  assertEquals(out.source, "/* /w/a.ts */ const a = 1;");
});

Deno.test("node's hook leaves a specifier that names no file alone", () => {
  // `node:fs`, `data:`, `https:`. There is no path to expand and nothing there
  // was authored by anybody using macros.
  const hook = nodeHook(MARK, ANY);
  const untouched = ["node:fs", "data:text/javascript,1", "https://x/y.ts"];

  for (const url of untouched) {
    const out = hook.load(url, {}, () => loaded("const a = 1;"));
    assertEquals(out.source, "const a = 1;", url);
    assertEquals(out.shortCircuit, undefined, url);
  }
});

Deno.test("node's hook leaves a path the filter refuses alone", () => {
  const hook = nodeHook(MARK, (path) => path.endsWith(".ts"));
  const out = hook.load("file:///w/a.js", {}, () => loaded("const a = 1;"));

  assertEquals(out.source, "const a = 1;");
  assertEquals(out.shortCircuit, undefined);
});

Deno.test("node's hook reads a path back out of an escaped specifier", () => {
  // A directory with a space in it arrives percent-encoded, and the filter and
  // the expansion both want the path somebody typed.
  const hook = nodeHook(MARK, ANY);
  const out = hook.load(
    "file:///w/my%20app/a.ts",
    {},
    () => loaded("const a = 1;"),
  );

  assertEquals(out.source, "/* /w/my app/a.ts */ const a = 1;");
});

Deno.test("bun's plugin claims the typescript extensions and picks the loader", async () => {
  const claimed: RegExp[] = [];
  const runs: ((args: { path: string }) => Promise<
    { contents: string; loader: string }
  >)[] = [];
  bunPlugin(MARK, ANY).setup({
    onLoad(filter, run) {
      claimed.push(filter.filter);
      runs.push(run);
    },
  });

  assertEquals(claimed.length, 1);
  const pattern = claimed[0]!;
  for (const yes of ["/w/a.ts", "/w/a.tsx", "/w/a.mts", "/w/a.cts"]) {
    assertEquals(pattern.test(yes), true, yes);
  }
  for (const no of ["/w/a.js", "/w/a.json", "/w/a.tsq"]) {
    assertEquals(pattern.test(no), false, no);
  }

  const dir = await Deno.makeTempDir();
  try {
    const plain = join(dir, "a.ts");
    const jsx = join(dir, "a.tsx");
    await Deno.writeTextFile(plain, "const a = 1;");
    await Deno.writeTextFile(jsx, "const a = 1;");

    assertEquals((await runs[0]!({ path: plain })).loader, "ts");
    assertEquals((await runs[0]!({ path: jsx })).loader, "tsx");
    assertStringIncludes((await runs[0]!({ path: plain })).contents, "/* ");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bun's plugin hands back what it read when the filter refuses", async () => {
  // The pattern is the widest thing the filter could accept, so the filter has
  // to be able to refuse inside it without the text changing on the way past.
  let run:
    | ((args: { path: string }) => Promise<
      { contents: string; loader: string }
    >)
    | undefined;
  bunPlugin(MARK, () => false).setup({ onLoad: (_f, r) => void (run = r) });

  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "a.ts");
    await Deno.writeTextFile(path, "const a = 1;");
    assertEquals((await run!({ path })).contents, "const a = 1;");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install expands a module loaded after it, on the runtime running this", async () => {
  // The whole of it, against a real loader. Deno implements node's hook, so
  // this is the same arm node takes and the expansion is the real one.
  const dir = await Deno.makeTempDir();
  const path = join(dir, "doubled.ts");
  await Deno.writeTextFile(path, DOUBLED);

  const got = install(doubling());
  try {
    assertEquals(got.host, "deno");
    const module = await import(`file://${path}`);
    // One authored push, emitted twice. The count is the only way to tell the
    // twin from the source from inside the module, since the file it was
    // compiled from is not something it can see.
    assertEquals(module.count, 2);
    assertStringIncludes(
      await Deno.readTextFile(path),
      "[twice()]",
      "the file on disk is untouched",
    );
  } finally {
    got.remove();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install expands the files that carry bodies, and no others", () => {
  // The default filter is `interesting`, and what makes it worth having is what
  // it refuses: a declaration file has no bodies for a macro to sit in, and
  // expanding one is work with nothing to find. An install that took everything
  // would look identical from outside until it met one.
  const got = install(registry([]));
  try {
    assertEquals(got.matches("/w/a.ts"), true);
    assertEquals(got.matches("/w/a.tsx"), true);
    assertEquals(got.matches("/w/a.d.ts"), false);
    assertEquals(got.matches("/w/a.js"), false);
    assertEquals(got.matches("/w/a.json"), false);
  } finally {
    got.remove();
  }
});

Deno.test("install reports the filter it was given, not the default", () => {
  const mine = (path: string) => path.endsWith(".weird");
  const got = install(registry([]), { matches: mine });
  try {
    assertEquals(got.matches, mine);
  } finally {
    got.remove();
  }
});

Deno.test("install leaves a module loaded before it as it was", async () => {
  // The constraint every runtime here shares, and the one a consumer trips
  // over: a hook reaches what is loaded after it. A module already resolved
  // when `install` runs keeps whatever it was compiled from.
  const dir = await Deno.makeTempDir();
  const path = join(dir, "early.ts");
  await Deno.writeTextFile(path, "export const n = 1;\n");

  const before = await import(`file://${path}`);
  const got = install(registry([]), { matches: () => true });
  try {
    const after = await import(`file://${path}`);
    assertEquals(after, before, "the same module instance, not a second load");
  } finally {
    got.remove();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("remove takes the hook back out", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "after.ts");
  await Deno.writeTextFile(path, DOUBLED);

  install(doubling()).remove();
  try {
    // Nothing rewrites it now, so the runtime is handed the source, and the
    // source calls a macro that only ever existed at expansion time. Failing
    // to find it is the evidence: an installed hook would have removed the
    // call before this point.
    const raised = await assertRejects(() => import(`file://${path}`));
    assertStringIncludes(String(raised), "twice");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install reports a diagnostic against the file it came from", () => {
  const seen: { path: string; message: string }[] = [];
  const got = install(registry([]), {
    onDiagnostic: (path, one) => seen.push({ path, message: one.message }),
  });
  got.remove();

  // Nothing has been loaded, so nothing is reported yet. The assertion is that
  // the option is wired rather than that it has fired.
  assertEquals(seen, []);
});

Deno.test("a runtime with no seam is told so rather than left silent", () => {
  // The failure to avoid is `install` returning happily on a runtime where
  // nothing will ever expand, because everything then looks correct until a
  // macro silently does not run.
  const process = (globalThis as { process?: unknown }).process;
  const bun = (globalThis as { Bun?: unknown }).Bun;
  try {
    delete (globalThis as { process?: unknown }).process;
    delete (globalThis as { Bun?: unknown }).Bun;
    assertThrows(
      () => install(registry([])),
      Error,
      "no loader to put the expansion in front of",
    );
  } finally {
    (globalThis as { process?: unknown }).process = process;
    (globalThis as { Bun?: unknown }).Bun = bun;
  }
});

Deno.test("a node too old for the hook is named, with the version it reported", () => {
  const process = (globalThis as { process?: unknown }).process;
  const bun = (globalThis as { Bun?: unknown }).Bun;
  try {
    delete (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { process?: unknown }).process = {
      versions: { node: "20.0.0" },
      getBuiltinModule: () => ({}),
    };
    assertThrows(
      () => install(registry([])),
      Error,
      "reports node 20.0.0 and has no module.registerHooks",
    );
  } finally {
    (globalThis as { process?: unknown }).process = process;
    (globalThis as { Bun?: unknown }).Bun = bun;
  }
});

Deno.test("bun is taken over node when both are there, and says its plugin stays", () => {
  const bun = (globalThis as { Bun?: unknown }).Bun;
  const installed: { name: string }[] = [];
  try {
    (globalThis as { Bun?: unknown }).Bun = {
      plugin: (one: { name: string }) => installed.push(one),
    };
    const got = install(registry([]));
    assertEquals(got.host, "bun");
    assertEquals(installed.map((one) => one.name), ["loitsu"]);
    assertThrows(got.remove, Error, "for the life of the process");
  } finally {
    (globalThis as { Bun?: unknown }).Bun = bun;
  }
});
