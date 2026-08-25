/**
 * The command line, end to end over a real project on disk.
 *
 * Everything below builds an actual tree with an actual `loitsu.config.ts` and
 * runs the real verbs over it. The reason is the thing being tested: a config is
 * TypeScript and gets imported, a build writes files, and a check shells out to
 * a type checker. Mocking any of those would test the mock.
 *
 * The one seam that does get stood in for is the type checker itself, through
 * `CheckOptions.checker`, because a real `deno check` costs seconds per run and
 * most of these assertions are about what happens either side of it. One test
 * runs the real thing, so the standing in cannot drift from what deno says.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { sources } from "../cli/sources.ts";
import { CONFIG, project, ProjectError } from "../cli/project.ts";
import { build } from "../cli/build.ts";
import { check, lines, NothingToCheck } from "../cli/check.ts";
import { reported } from "../cli/diagnostics.ts";
import { asked, main, USAGE, VERBS } from "../cli/mod.ts";

/** The two verbs, named once here so the fixtures below read as invocations
 * rather than as a spelling test. What they are actually spelled is pinned in
 * `names every verb in the usage`, and nowhere else. */
const [BUILD, CHECK] = VERBS;

/** This repo, so a fixture config can import the registry from where it lives. */
const HERE = new URL("../", import.meta.url).href;

/** A config that keeps `[cfg(deno)]` and drops everything else. */
const CONFIGURED = `
import ts from "typescript";
import { registry } from "${HERE}src/macro.ts";

const cfg = {
  kind: "attribute",
  name: "cfg",
  expand: (args, item) =>
    ts.isIdentifier(args[0]) && args[0].text === "deno" ? [item.node] : [],
};

export default {
  registry: registry([cfg]),
  against: "fixture-1",
  cacheDir: undefined,
};
`;

describe("the command line over a project on disk", () => {
  let root = "";
  let out = "";

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "loitsu_cli_" });
    out = join(root, "twins");
    await Deno.writeTextFile(join(root, CONFIG), CONFIGURED);
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /** Writes a source under the fixture root, making its directory. */
  async function source(where: string, text: string): Promise<void> {
    const to = join(root, where);
    await Deno.mkdir(join(to, ".."), { recursive: true });
    await Deno.writeTextFile(to, text);
  }

  describe("finding sources", () => {
    it("walks the tree and leaves the tool directories alone", async () => {
      await source("src/one.ts", "export const one = 1;\n");
      await source("src/deep/two.ts", "export const two = 2;\n");
      await source("node_modules/pkg/three.ts", "export const three = 3;\n");
      await source("notes.md", "not a source\n");

      const found = [];
      for await (const one of sources(root)) found.push(one);
      const names = found.map((one) => one.slice(root.length + 1)).sort();
      // The config is a source like any other to the walk. Leaving it out is
      // the build's business, and `does not build a twin of the config` is
      // where that is pinned.
      assertEquals(names, [CONFIG, "src/deep/two.ts", "src/one.ts"]);
    });

    it("takes the skip list it is handed instead of the usual one", async () => {
      await source("node_modules/pkg/three.ts", "export const three = 3;\n");
      const found = [];
      for await (const one of sources(root, { skip: [] })) found.push(one);
      assert(found.some((one) => one.includes("node_modules")));
    });

    it("says nothing about a directory it cannot read, rather than throwing", async () => {
      const found = [];
      for await (const one of sources(join(root, "no-such-place"))) {
        found.push(one);
      }
      assertEquals(found, []);
    });
  });

  describe("reading the project", () => {
    it("gives back what the config exported", async () => {
      const found = await project(root);
      assertEquals(found.against, "fixture-1");
      assertEquals(typeof found.registry.attribute, "function");
    });

    it("refuses a root with no config in it", async () => {
      const bare = await Deno.makeTempDir({ prefix: "loitsu_bare_" });
      try {
        const why = await assertRejects(() => project(bare), ProjectError);
        assertStringIncludes(why.message, CONFIG);
      } finally {
        await Deno.remove(bare, { recursive: true });
      }
    });

    it("refuses a config that exports no registry", async () => {
      await Deno.writeTextFile(
        join(root, CONFIG),
        `export default { against: "x" };\n`,
      );
      const why = await assertRejects(() => project(root), ProjectError);
      assertStringIncludes(why.message, "nothing would expand");
    });

    it("refuses a config that names nothing to key the cache on", async () => {
      await Deno.writeTextFile(
        join(root, CONFIG),
        CONFIGURED.replace(`against: "fixture-1",`, `against: "",`),
      );
      const why = await assertRejects(() => project(root), ProjectError);
      assertStringIncludes(why.message, "older macros");
    });

    it("refuses a registry with only half of itself", async () => {
      await Deno.writeTextFile(
        join(root, CONFIG),
        `export default { registry: { function: () => undefined }, against: "x" };\n`,
      );
      const why = await assertRejects(() => project(root), ProjectError);
      assertStringIncludes(why.message, "nothing would expand");
    });

    it("refuses a config whose default export is not an object", async () => {
      await Deno.writeTextFile(join(root, CONFIG), `export default 7;\n`);
      const why = await assertRejects(() => project(root), ProjectError);
      assertStringIncludes(why.message, "default-export");
    });
  });

  describe("building the twin tree", () => {
    it("mirrors the source tree and expands what it writes", async () => {
      await source("src/one.ts", "[cfg(deno)]\nexport const kept = 1;\n");
      await source("src/deep/two.ts", "[cfg(node)]\nexport const gone = 2;\n");

      const done = await build(await project(root), { root, out });
      assertEquals(done.files.length, 2);
      assertEquals(done.failed, 0);

      const kept = await Deno.readTextFile(join(out, "src/one.ts"));
      assertStringIncludes(kept, "kept");
      const dropped = await Deno.readTextFile(join(out, "src/deep/two.ts"));
      assert(!dropped.includes("gone"), dropped);
    });

    it("does not build a twin of the config that defined the project", async () => {
      await source("src/one.ts", "export const one = 1;\n");
      const done = await build(await project(root), { root, out });
      assertEquals(done.files.map((one) => one.path), ["src/one.ts"]);
      await assertRejects(
        () => Deno.stat(join(out, CONFIG)),
        Deno.errors.NotFound,
      );
    });

    it("counts a file the expansion had something to say about", async () => {
      await source("src/fine.ts", "export const fine = 1;\n");
      await source("src/loose.ts", "export const one = 1;\n[cfg(deno)]\n");
      const done = await build(await project(root), { root, out });
      assertEquals(done.files.length, 2);
      assertEquals(done.failed, 1);
    });

    it("carries a span table for every twin it wrote", async () => {
      await source("src/one.ts", "[cfg(deno)]\nexport const kept = 1;\n");
      const done = await build(await project(root), { root, out });
      for (const one of done.files) {
        assert(one.spans !== undefined, one.path);
      }
    });
  });

  describe("checking", () => {
    it("refuses a tree with no sources in it", async () => {
      const found = await project(root);
      await assertRejects(() => check(found, { root, out }), NothingToCheck);
    });

    it("checks a tree that has sources, which is the control", async () => {
      await source("src/one.ts", "export const one: number = 1;\n");
      const done = await check(await project(root), {
        root,
        out,
        checker: () => Promise.resolve(""),
      });
      assertEquals(done.said, []);
      assertEquals(done.files, 1);
    });

    it("reports a type error where the author wrote it, not where the twin put it", async () => {
      // `cfg(node)` drops its item, leaving the twin as a blank line and then
      // what survived. So the authored line 3 sits at twin line 2, and carrying
      // a report there back to 3 is the only reason any of this machinery
      // exists. The twin's exact shape was read off the expander rather than
      // assumed, because assuming it is how this test would pass at the wrong
      // number.
      await source(
        "src/one.ts",
        "[cfg(node)]\nexport const gone = 0;\nexport const bad: number = 1;\n",
      );
      const found = await project(root);
      const twin = join(out, "src/one.ts");

      const done = await check(found, {
        root,
        out,
        checker: () =>
          Promise.resolve(
            `TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.\n` +
              `    at ${new URL(`file://${twin}`).href}:2:14\n`,
          ),
      });

      assertEquals(done.said.length, 1);
      assertEquals(done.said[0].path, "src/one.ts");
      assertEquals(done.said[0].line, 3);
      assertEquals(done.said[0].from, "types");
      assertStringIncludes(done.said[0].message, "TS2322");
    });

    it("drops a diagnostic with nowhere in the source to point at, and counts it", async () => {
      await source("src/one.ts", "export const one: number = 1;\n");
      const done = await check(await project(root), {
        root,
        out,
        checker: () =>
          Promise.resolve(
            `TS2322 [ERROR]: about a file nobody here wrote.\n` +
              `    at file:///nowhere/at/all.ts:1:1\n`,
          ),
      });
      assertEquals(done.said, []);
      assertEquals(done.dropped, 1);
    });

    it("reports what the expansion said, in the source's own coordinates", async () => {
      // An attribute with nothing under it. An unknown name is not a diagnostic,
      // because `[nosuch]` on its own line is also an ordinary array literal and
      // nothing here can tell the two apart.
      await source("src/one.ts", "export const one = 1;\n[cfg(deno)]\n");
      const done = await check(await project(root), {
        root,
        out,
        checker: () => Promise.resolve(""),
      });
      const said = done.said.filter((one) => one.from === "expansion");
      assertEquals(said.length, 1, JSON.stringify(done.said));
      assertEquals(said[0].path, "src/one.ts");
      // The attribute is the whole of line 2 and starts at its first column.
      assertEquals(said[0].line, 2);
      assertEquals(said[0].column, 1);
    });

    it("prints one line per thing said", async () => {
      await source("src/one.ts", "export const one: number = 1;\n");
      const done = await check(await project(root), {
        root,
        out,
        checker: () => Promise.resolve(""),
      });
      assertEquals(lines(done), []);
    });
  });

  describe("the entry point", () => {
    it("exits non-zero and prints usage when handed no verb", async () => {
      assertEquals(await quiet(() => main([])), 1);
    });

    it("exits zero for help, which is the control", async () => {
      assertEquals(await quiet(() => main(["--help"])), 0);
    });

    it("exits non-zero for a verb it has not got", async () => {
      await source("src/one.ts", "export const one = 1;\n");
      assertEquals(await quiet(() => main(["frobnicate", "--root", root])), 1);
    });

    it("builds, and says where it put things", async () => {
      await source("src/one.ts", "[cfg(deno)]\nexport const one = 1;\n");
      assertEquals(
        await quiet(() => main([BUILD, "--root", root, "--out", out])),
        0,
      );
      assertStringIncludes(
        await Deno.readTextFile(join(out, "src/one.ts")),
        "one",
      );
    });

    it("exits non-zero when a build could not expand something", async () => {
      await source("src/one.ts", "export const one = 1;\n[cfg(deno)]\n");
      assertEquals(
        await quiet(() => main([BUILD, "--root", root, "--out", out])),
        1,
      );
    });

    it("exits non-zero when a check found something to say", async () => {
      await source("src/one.ts", "export const one = 1;\n[cfg(deno)]\n");
      assertEquals(
        await quiet(() => main([CHECK, "--root", root, "--out", out])),
        1,
      );
    });

    it("exits zero when a check found nothing, which is the control on both", async () => {
      await source("src/one.ts", "export const one: number = 1;\n");
      assertEquals(
        await quiet(() => main([CHECK, "--root", root, "--out", out])),
        0,
      );
    });

    it("says so and exits non-zero when the root has no config", async () => {
      const bare = await Deno.makeTempDir({ prefix: "loitsu_bare_" });
      try {
        assertEquals(await quiet(() => main([BUILD, "--root", bare])), 1);
      } finally {
        await Deno.remove(bare, { recursive: true });
      }
    });
  });
});

describe("reading arguments", () => {
  it("defaults the root to here and the out under it", () => {
    const it = asked([BUILD]);
    assertEquals(it.verb, BUILD);
    assertEquals(it.root, ".");
    assertStringIncludes(it.out, ".loitsu/twins");
  });

  it("puts the default out under whichever root was named", () => {
    assertStringIncludes(asked([BUILD, "--root", "/tmp/x"]).out, "/tmp/x/");
  });

  it("takes the last of a repeated flag", () => {
    assertEquals(asked([BUILD, "--root", "a", "--root", "b"]).root, "b");
  });

  it("takes the first bare word as the verb and ignores later ones", () => {
    assertEquals(asked([CHECK, BUILD]).verb, CHECK);
  });

  it("ignores a flag with nothing after it rather than eating the next verb", () => {
    assertEquals(asked(["--root"]).root, ".");
  });

  it("names every verb in the usage, so none can be added without it", () => {
    // The one place the verbs are spelled out, and joined rather than listed
    // so that it is one literal naming the whole set. Everything else names
    // them through `VERBS`, so a rename is one edit and this is what catches it.
    assertEquals(VERBS.join(" "), "build check");
    for (const one of VERBS) assertStringIncludes(USAGE, one);
  });
});

describe("reading deno check back", () => {
  it("finds a type error with its code and its position", () => {
    const got = reported(
      `Check file:///x/a.ts\n` +
        `TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.\n` +
        `export const x: number = "a";\n` +
        `             ^\n` +
        `    at file:///x/a.ts:1:14\n`,
    );
    assertEquals(got.length, 1);
    assertEquals(got[0].code, "TS2322");
    assertEquals(got[0].path, "/x/a.ts");
    assertEquals(got[0].line, 1);
    assertEquals(got[0].column, 14);
    assertStringIncludes(got[0].message, "not assignable");
  });

  it("finds one deno raised itself, which carries no code", () => {
    const got = reported(
      `error: SyntaxError: Unexpected token \`=\`.\n` +
        `  |\n` +
        `1 | export const q: = 1;\n` +
        `  |                 ~\n` +
        `    at file:///x/b.ts:1:17\n`,
    );
    assertEquals(got.length, 1);
    assertEquals(got[0].code, undefined);
    assertEquals(got[0].column, 17);
  });

  it("finds one with no source excerpt between the message and the position", () => {
    const got = reported(
      `TS2307 [ERROR]: Cannot find module 'file:///x/nothing.ts'.\n` +
        `    at file:///x/c.ts:1:22\n`,
    );
    assertEquals(got.length, 1);
    assertEquals(got[0].line, 1);
  });

  it("keeps several apart rather than giving them all one message", () => {
    const got = reported(
      `TS1 [ERROR]: first.\n    at file:///x/a.ts:1:1\n\n` +
        `TS2 [ERROR]: second.\n    at file:///x/a.ts:2:2\n`,
    );
    assertEquals(got.map((one) => one.message), ["first.", "second."]);
  });

  it("drops a position with no message above it rather than attributing it", () => {
    assertEquals(reported(`    at file:///x/a.ts:1:1\n`), []);
    assertEquals(
      reported(
        `TS1 [ERROR]: only one.\n    at file:///x/a.ts:1:1\n    at file:///x/a.ts:9:9\n`,
      ).length,
      1,
    );
  });

  it("does not take a position out of the source line deno quotes back", () => {
    // Deno prints the offending line of the file underneath the message, flush
    // left. If that line happens to end in something shaped like a location,
    // and a comment carrying a link is exactly that, then only the indentation
    // tells the two apart. So the anchor is `^\s+at`, and this is what stops it
    // being loosened to `at`.
    const got = reported(
      `TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.\n` +
        `const x: number = load(); // see the note at file:///x/a.ts:9:9\n` +
        `      ^\n` +
        `    at file:///x/b.ts:1:7\n`,
    );
    assertEquals(got.length, 1);
    assertEquals(got[0].path, "/x/b.ts");
    assertEquals(got[0].line, 1);
    assertEquals(got[0].column, 7);
  });

  it("says nothing about a clean run", () => {
    assertEquals(reported(`Check file:///x/a.ts\n`), []);
  });

  it("still finds what deno actually prints, which is the control on all of the above", async () => {
    // The one test here that pays for a real check. Everything above is a
    // string somebody typed, and a string somebody typed stays the same shape
    // forever whatever deno does.
    const where = await Deno.makeTempDir({ prefix: "loitsu_deno_" });
    try {
      const file = join(where, "bad.ts");
      await Deno.writeTextFile(file, `export const x: number = "a";\n`);
      const ran = await new Deno.Command(Deno.execPath(), {
        args: ["check", file],
        env: { NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const read = new TextDecoder();
      const got = reported(read.decode(ran.stdout) + read.decode(ran.stderr));

      assertEquals(got.length, 1, read.decode(ran.stderr));
      // Deno reports the path it was handed rather than the resolved one, and on
      // macOS a temporary directory is a symlink, so the two differ.
      assertEquals(got[0].path, file);
      assertEquals(got[0].code, "TS2322");
      assertEquals(got[0].line, 1);
    } finally {
      await Deno.remove(where, { recursive: true });
    }
  });
});

/** Runs something with `console.log` silenced, so a suite stays readable. */
function quiet<T>(body: () => Promise<T>): Promise<T> {
  const said = console.log;
  const shouted = console.error;
  console.log = () => {};
  console.error = () => {};
  return body().finally(() => {
    console.log = said;
    console.error = shouted;
  });
}
