//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The cache, against a real directory rather than a stub, because most of what it
 * has to survive is what a filesystem does to it. */
import ts from "typescript";
import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { registry } from "../src/macro.ts";
import {
  cached,
  cacheHome,
  keyOf,
  read,
  VERSION,
  write,
} from "../src/cache.ts";
import { expand } from "../src/expand.ts";
import { sourceOffset } from "../src/spans.ts";

const named = (e: ts.Expression) => ts.isIdentifier(e) ? e.text : "";

/** Counts its own runs, so a hit is proved by the macro not running rather than by
 * the flag the cache reports about itself. */
function counting() {
  const ran = { n: 0 };
  const reg = registry([{
    kind: "attribute",
    name: "cfg",
    expand: (args: readonly ts.Expression[], item: { node: ts.Statement }) => {
      ran.n++;
      return named(args[0]!) === "deno" ? [item.node] : [];
    },
    // deno-lint-ignore no-explicit-any
  } as any]);
  return { ran, reg };
}

const SRC = `[cfg(deno)]\nfunction kept(who: string) {\n  return who;\n}\n`;

const temp = () => Deno.makeTempDir({ prefix: "loitsu-cache-" });

Deno.test("the directory comes from the environment values, not from the process", () => {
  assertEquals(cacheHome("/xdg", "/home"), `/xdg/loitsu/v${VERSION}`);
  assertEquals(
    cacheHome(undefined, "/home"),
    `/home/.cache/loitsu/v${VERSION}`,
  );
  assertEquals(
    cacheHome("", "/home"),
    `/home/.cache/loitsu/v${VERSION}`,
    "empty is unset",
  );
  assertEquals(cacheHome(undefined, undefined), undefined, "no home, no cache");
  assertEquals(cacheHome("", ""), undefined);
});

Deno.test("the version is in the path, so two loitsus cannot read each other", () => {
  assertStringIncludes(cacheHome("/xdg", undefined)!, `/v${VERSION}`);
});

Deno.test("a key changes with the text and with what it was expanded against", async () => {
  const a = await keyOf("x", "one");
  assertEquals(a, await keyOf("x", "one"), "the same inputs give the same key");
  assertNotEquals(a, await keyOf("y", "one"), "different text");
  assertNotEquals(a, await keyOf("x", "two"), "different macros in scope");
});

Deno.test("moving the boundary between the two halves does not collide", () => {
  // Concatenating them with nothing between makes `ab` + `c` and `a` + `bc` one
  // buffer, so a file would be served the twin of a different file expanded against
  // different macros. The separator is a byte neither half can contain.
  return Promise.all([keyOf("bc", "a"), keyOf("c", "ab")]).then(([l, r]) =>
    assertNotEquals(l, r)
  );
});

Deno.test("a miss runs the macros, a hit does not", async () => {
  const dir = await temp();
  try {
    const { ran, reg } = counting();
    const first = await cached(SRC, "v1", reg, dir);
    assertEquals(first.hit, false);
    assertEquals(ran.n, 1);

    const second = await cached(SRC, "v1", reg, dir);
    assertEquals(second.hit, true);
    assertEquals(
      ran.n,
      1,
      "the macro did not run again, which is what a hit means",
    );
    assertEquals(second.code, first.code);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the spans survive the round trip, not just the text", async () => {
  // Storing the twin and losing the map would look entirely correct until the first
  // diagnostic, which would land wherever the identity happened to put it.
  const dir = await temp();
  try {
    const { reg } = counting();
    const fresh = await cached(SRC, "v1", reg, dir);
    const restored = await cached(SRC, "v1", reg, dir);
    assertEquals(restored.hit, true);
    for (let at = 0; at < restored.code.length; at++) {
      assertEquals(
        sourceOffset(restored.spans, at),
        sourceOffset(fresh.spans, at),
        `offset ${at}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the diagnostics survive too", async () => {
  const dir = await temp();
  try {
    const { reg } = counting();
    const src = `const a = 1;\n[cfg(deno)]\n`;
    const fresh = await cached(src, "v1", reg, dir);
    const restored = await cached(src, "v1", reg, dir);
    assertEquals(restored.hit, true);
    assertEquals(restored.diagnostics, fresh.diagnostics);
    assertEquals(restored.diagnostics.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("changing what it was expanded against is a miss, not a stale hit", async () => {
  // The one failure the design cannot detect is a caller that does not change this
  // when its macros change. It can at least honour it when the caller does.
  const dir = await temp();
  try {
    const { ran, reg } = counting();
    await cached(SRC, "v1", reg, dir);
    const second = await cached(SRC, "v2", reg, dir);
    assertEquals(second.hit, false);
    assertEquals(ran.n, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an entry from another version is not read", async () => {
  const dir = await temp();
  try {
    const key = await keyOf(SRC, "v1");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/${key}.json`,
      JSON.stringify({
        version: VERSION + 1,
        code: "wrong",
        spans: [],
        diagnostics: [],
      }),
    );
    assertEquals(await read(dir, key), undefined);

    const { ran, reg } = counting();
    const out = await cached(SRC, "v1", reg, dir);
    assertEquals(out.hit, false);
    assertEquals(
      ran.n,
      1,
      "and it expanded rather than serving the foreign entry",
    );
    assertEquals(out.code.includes("wrong"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a corrupt entry is discarded rather than parsed hopefully", async () => {
  const dir = await temp();
  try {
    await Deno.mkdir(dir, { recursive: true });
    for (
      const [name, body] of [
        ["truncated", '{"version":1,"code":"a"'],
        ["empty", ""],
        ["not an object", "[]"],
        [
          "code is not a string",
          '{"version":1,"code":7,"spans":[],"diagnostics":[]}',
        ],
        [
          "spans is not an array",
          '{"version":1,"code":"a","spans":3,"diagnostics":[]}',
        ],
      ]
    ) {
      await Deno.writeTextFile(`${dir}/${name}.json`, body!);
      assertEquals(await read(dir, name!), undefined, name);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a stored span table that no longer holds is refused, not trusted", async () => {
  // The one worth having. Nothing stops a file under a cache directory from being
  // edited or half-written, and a table with overlapping spans answers two things
  // for one position. Rebuilding it through the same constructor that refused it
  // when it was first built is what makes the stored form no more trusted than any
  // other input.
  const dir = await temp();
  try {
    await Deno.mkdir(dir, { recursive: true });
    const overlapping = JSON.stringify({
      version: VERSION,
      code: "abcdef",
      spans: [{ outStart: 0, length: 4, inStart: 0 }, {
        outStart: 2,
        length: 4,
        inStart: 0,
      }],
      diagnostics: [],
    });
    await Deno.writeTextFile(`${dir}/bad.json`, overlapping);
    assertEquals(await read(dir, "bad"), undefined);

    // the control: the same file with a table that does hold, and it reads back
    const sound = JSON.stringify({
      version: VERSION,
      code: "abcdef",
      spans: [{ outStart: 0, length: 4, inStart: 0 }],
      diagnostics: [],
    });
    await Deno.writeTextFile(`${dir}/good.json`, sound);
    assertEquals((await read(dir, "good"))?.code, "abcdef");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a write that cannot happen loses the entry and nothing else", async () => {
  // A caller holding a correct expansion must not lose it to a full disk or a
  // read-only directory, so the store cannot throw. The path is outside what the
  // test task grants write to, which makes the refusal a property of the run rather
  // than of whether this particular machine lets anybody write to `/`.
  const { reg } = counting();
  const out = await cached(SRC, "v1", reg, "/loitsu-cannot-write-here");
  assertEquals(out.hit, false);
  assertStringIncludes(
    out.code,
    "kept",
    "the expansion is still the expansion",
  );
});

Deno.test("no cache home means expand, not fail", async () => {
  // `dir` is required rather than defaulted, and this test is why. Written the other
  // way, `undefined` fell through to the default and this ran against the machine's
  // own cache directory, where it found the entry an earlier test had left and
  // reported a hit. It also wrote there, which a test has no business doing.
  const { ran, reg } = counting();
  const out = await cached(SRC, "v1", reg, undefined);
  assertEquals(out.hit, false);
  assertEquals(ran.n, 1);
  assertEquals(out.code, expand(SRC, reg).code);
});

Deno.test("nothing half-written is left behind after a store", async () => {
  const dir = await temp();
  try {
    const { reg } = counting();
    await cached(SRC, "v1", reg, dir);
    const left: string[] = [];
    for await (const e of Deno.readDir(dir)) left.push(e.name);
    assertEquals(
      left.filter((n) => n.endsWith(".tmp")),
      [],
      "no temporary files remain",
    );
    assertEquals(left.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the environment is not read on the way to an expansion", async () => {
  // The library never reaches for `HOME` in the middle of its own work: a caller says
  // where the cache is or says there is none. `defaultHome` exists and is one call,
  // at the caller, where it can be seen.
  const dir = await temp();
  try {
    const { reg } = counting();
    const xdg = Deno.env.get("XDG_CACHE_HOME"), home = Deno.env.get("HOME");
    Deno.env.delete("XDG_CACHE_HOME");
    Deno.env.delete("HOME");
    try {
      const out = await cached(SRC, "v1", reg, dir);
      assertEquals(out.hit, false);
      assertStringIncludes(
        out.code,
        "kept",
        "with no home set at all, it still expanded",
      );
      assertEquals(
        (await cached(SRC, "v1", reg, dir)).hit,
        true,
        "and still cached",
      );
    } finally {
      if (xdg !== undefined) Deno.env.set("XDG_CACHE_HOME", xdg);
      if (home !== undefined) Deno.env.set("HOME", home);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the harness can fail, so the agreements above mean something", async () => {
  const dir = await temp();
  try {
    assertEquals(await read(dir, "never-written"), undefined);
    await write(dir, "written", expand(SRC, counting().reg));
    assertNotEquals(
      await read(dir, "written"),
      undefined,
      "read must be able to say yes",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("two dialects with the same bytes do not share an entry", async () => {
  // The bytes are identical and the expansions are not, so a key over the text
  // alone serves a `.tsx` file the twin of a `.ts` one. The failure is silent: the
  // entry is well-formed, its spans hold, and it is a twin of a different language.
  const dir = await temp();
  try {
    const { reg } = counting();
    // A macro has to fire, or both dialects hand the text straight back and the two
    // codes match for a reason that has nothing to do with the key.
    const src =
      `[cfg(deno)]\nexport function View() {\n  return <div className="a">t</div>;\n}\n`;
    const asTs = await cached(src, "v1", reg, dir, "a.ts");
    const asTsx = await cached(src, "v1", reg, dir, "a.tsx");
    assertEquals(asTs.hit, false);
    assertEquals(
      asTsx.hit,
      false,
      "the second is a miss, so it is not served the first's twin",
    );
    assertNotEquals(asTsx.code, asTs.code, "and the two twins differ");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("two files of one dialect with the same bytes do share an entry", async () => {
  // The control. Keying on the file name instead of the dialect would pass the
  // test above and lose this, which is most of what a cache buys over a repository.
  const dir = await temp();
  try {
    const { reg } = counting();
    const first = await cached(SRC, "v1", reg, dir, "a.ts");
    const second = await cached(SRC, "v1", reg, dir, "deep/b.ts");
    assertEquals(first.hit, false);
    assertEquals(second.hit, true);
    assertEquals(second.code, first.code);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
