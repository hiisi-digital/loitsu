//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The seam where a source file becomes a twin, and the rule that a twin is never
 * older than the last change acknowledged for its path.
 *
 * Most of this runs against an injected reader rather than a filesystem, because
 * the interesting behaviour is what happens when two rebuilds of one path overlap,
 * and provoking that through real file writes means racing a real clock. The
 * adapter that turns filesystem events into these calls is tested separately, at
 * the bottom, where a real filesystem is the point. */
import ts from "typescript";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { registry } from "../src/macro.ts";
import { interesting, Twins, watch } from "../src/watch.ts";
import { sourceOffset } from "../src/spans.ts";
import { expand } from "../src/expand.ts";

const named = (e: ts.Expression) => ts.isIdentifier(e) ? e.text : "";

/** `cfg` again, keeping its item only for `deno`. Enough that a twin differs from
 * its source, which is what every assertion below turns on. */
function macros() {
  return registry([{
    kind: "attribute",
    name: "cfg",
    expand: (args: readonly ts.Expression[], item: { node: ts.Statement }) =>
      named(args[0]!) === "deno" ? [item.node] : [],
    // deno-lint-ignore no-explicit-any
  } as any]);
}

const KEPT = `[cfg(deno)]\nfunction kept() {\n  return 1;\n}\n`;
const DROPPED = `[cfg(node)]\nfunction gone() {\n  return 1;\n}\n`;

/** A reader over an in-memory filesystem, counting its reads, and able to hold a
 * read open so two rebuilds can be made to overlap deliberately. */
function reader(files: Record<string, string>) {
  const held = new Map<string, PromiseWithResolvers<void>>();
  const state = {
    files: { ...files },
    reads: [] as string[],
    /** Makes the next read of `path` block until `release` is called. */
    hold(path: string) {
      held.set(path, Promise.withResolvers<void>());
    },
    release(path: string) {
      held.get(path)?.resolve();
      held.delete(path);
    },
    read: async (path: string): Promise<string> => {
      state.reads.push(path);
      const gate = held.get(path);
      if (gate !== undefined) await gate.promise;
      const text = state.files[path];
      if (text === undefined) {
        throw new Deno.errors.NotFound(`no such file: ${path}`);
      }
      return text;
    },
  };
  return state;
}

const twinsOver = (fs: ReturnType<typeof reader>) =>
  new Twins({
    registry: macros(),
    against: "v1",
    cacheDir: undefined,
    read: fs.read,
  });

Deno.test("a path nobody has asked about has no twin and no failure", async () => {
  const fs = reader({});
  const twins = twinsOver(fs);
  assertEquals(twins.peek("/a.ts"), undefined);
  assertEquals(twins.failure("/a.ts"), undefined);
  assertEquals(twins.paths, []);
  assertEquals(fs.reads, [], "and nothing was read to find that out");
  await Promise.resolve();
});

Deno.test("get builds a twin for a file that has not changed since startup", async () => {
  // The case a language server hits constantly: a file is opened, nothing has
  // changed, no event has fired, and the twin still has to exist.
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  const twin = await twins.get("/a.ts");
  assert(twin !== undefined);
  assertEquals(twin.path, "/a.ts");
  assertEquals(twin.code, expand(KEPT, macros()).code);
  assertEquals(twins.paths, ["/a.ts"]);
});

Deno.test("the twin is the expansion, not the source", async () => {
  const fs = reader({ "/a.ts": DROPPED });
  const twins = twinsOver(fs);
  const twin = await twins.get("/a.ts");
  assertEquals(twin!.code.includes("gone"), false, "the item was dropped");
  assertNotEquals(twin!.code, DROPPED);
});

Deno.test("get does not read again once a twin is held", async () => {
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  await twins.get("/a.ts");
  await twins.get("/a.ts");
  await twins.get("/a.ts");
  assertEquals(fs.reads.length, 1);
});

Deno.test("changed rereads, and a new text gives a new twin", async () => {
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  const before = await twins.get("/a.ts");
  fs.files["/a.ts"] = DROPPED;
  await twins.changed("/a.ts");
  const after = twins.peek("/a.ts");
  assertEquals(fs.reads.length, 2);
  assertNotEquals(after!.code, before!.code);
  assertEquals(after!.code.includes("gone"), false);
  assert(after!.generation > before!.generation, "the generation rose");
});

Deno.test("changed on an unchanged file still produces the current twin", async () => {
  // An editor saves a file whose bytes did not change, which happens constantly.
  // The read happens, the cache absorbs the expansion, and the twin is current.
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  const before = await twins.get("/a.ts");
  await twins.changed("/a.ts");
  assertEquals(twins.peek("/a.ts")!.code, before!.code);
});

Deno.test("a rebuild that has been overtaken throws its own result away", async () => {
  // The load-bearing one. A slow read for generation 1 finishes after a fast read
  // for generation 2 has already stored its twin. Without the guard the stale text
  // wins because it landed last, and the editor shows diagnostics for a file the
  // author has already moved past.
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  await twins.get("/a.ts");

  fs.hold("/a.ts");
  fs.files["/a.ts"] = DROPPED;
  const slow = twins.changed("/a.ts"); // generation 1, blocked in its read

  fs.files["/a.ts"] = KEPT;
  // generation 2 reads a different path's worth of content: it is not held, so it
  // completes first and stores.
  fs.release("/a.ts");
  await slow;
  await twins.changed("/a.ts"); // generation 2, completes and stores

  const twin = twins.peek("/a.ts");
  assertEquals(twin!.generation, 2);
  assertEquals(twin!.code, expand(KEPT, macros()).code);
});

Deno.test("the overtaking is by generation, not by completion order", async () => {
  // The same property stated so it fails if the guard is changed to "last writer
  // wins": generation 1 is made to finish strictly after generation 2 has stored.
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  await twins.get("/a.ts");

  fs.files["/a.ts"] = DROPPED;
  fs.hold("/a.ts");
  const stale = twins.changed("/a.ts"); // generation 1, held

  fs.files["/a.ts"] = KEPT;
  // Generation 2 would also be held, so bump the generation directly by starting
  // it and letting both resume together; 2 stores first because it is released
  // into a queue behind 1 and its store runs last.
  const fresh = (async () => {
    await Promise.resolve();
    fs.release("/a.ts");
    await twins.changed("/a.ts");
  })();

  await Promise.all([stale, fresh]);
  const twin = twins.peek("/a.ts");
  assertEquals(
    twin!.code,
    expand(KEPT, macros()).code,
    "the newest generation's text is what is held",
  );
  assert(twin!.generation >= 2);
});

Deno.test("a rebuild for the same generation does not replace the stored twin", () => {
  // Two rebuilds of one change cannot have found anything different, so a second
  // store buys nothing and makes the held twin depend on which finished last.
  //
  // Asserted on object identity, because the generation and the code are equal
  // either way: only the identity of the stored object says whether it was written
  // over. A test comparing generations passes against a store that always happens.
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  return twins.get("/a.ts").then(async (first) => {
    const held = twins.peek("/a.ts");
    await twins.get("/a.ts");
    assertStrictEquals(
      twins.peek("/a.ts"),
      held,
      "the same object is still there, so nothing stored over it",
    );
    assertEquals(twins.peek("/a.ts")!.generation, first!.generation);

    // The control: a real change does replace it, so this is not asserting that
    // nothing is ever stored.
    fs.files["/a.ts"] = DROPPED;
    await twins.changed("/a.ts");
    assertNotStrictEquals(twins.peek("/a.ts"), held);
  });
});

Deno.test("the path reaches the expansion, so a tsx file is parsed as tsx", async () => {
  // `Twins` is the only thing that knows a path, and the dialect is decided by the
  // extension. Dropped here, every `.tsx` file in the project is expanded as `.ts`
  // and its JSX comes apart into comparisons, quietly and everywhere.
  const jsx =
    `[cfg(deno)]\nexport function View() {\n  return <div className="a">t</div>;\n}\n`;
  const fs = reader({ "/View.tsx": jsx, "/View.ts": jsx });
  const twins = twinsOver(fs);

  const tsx = await twins.get("/View.tsx");
  const tsp = await twins.get("/View.ts");
  assertNotEquals(
    tsx!.code,
    tsp!.code,
    "the same bytes under two extensions expand differently",
  );
  assertEquals(
    tsx!.code,
    expand(jsx, macros(), { fileName: "/View.tsx" }).code,
  );
});

Deno.test("forget drops the twin and everything remembered about the path", async () => {
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  await twins.get("/a.ts");
  twins.forget("/a.ts");
  assertEquals(twins.peek("/a.ts"), undefined);
  assertEquals(twins.failure("/a.ts"), undefined);
  assertEquals(twins.paths, []);
});

Deno.test("a rebuild in flight for a forgotten path does not resurrect it", async () => {
  // A file is deleted while its rebuild is reading. Storing the result would put a
  // twin back for a path that no longer exists, and nothing would ever remove it.
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  fs.hold("/a.ts");
  const inFlight = twins.changed("/a.ts");
  twins.forget("/a.ts");
  fs.release("/a.ts");
  await inFlight;
  assertEquals(twins.peek("/a.ts"), undefined);
  assertEquals(twins.paths, []);
});

Deno.test("a file that cannot be read is reported rather than thrown", async () => {
  // Constant during an editor's save, so it is an ordinary outcome. Throwing here
  // would take down whatever is driving the watch.
  const fs = reader({});
  const twins = twinsOver(fs);
  assertEquals(await twins.get("/gone.ts"), undefined);
  const why = twins.failure("/gone.ts");
  assert(why !== undefined);
  assertEquals(why.why, "NotFound");
  assertEquals(why.path, "/gone.ts");
});

Deno.test("a file that becomes readable clears the failure", async () => {
  const fs = reader({});
  const twins = twinsOver(fs);
  await twins.get("/a.ts");
  assert(twins.failure("/a.ts") !== undefined);

  fs.files["/a.ts"] = KEPT;
  await twins.changed("/a.ts");
  assertEquals(twins.failure("/a.ts"), undefined, "the failure is gone");
  assert(twins.peek("/a.ts") !== undefined, "and there is a twin");
});

Deno.test("a file that becomes unreadable drops its twin", async () => {
  // The other direction, and the one that matters: a stale twin left behind for a
  // file that no longer reads would be served to the checker forever.
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  await twins.get("/a.ts");
  delete fs.files["/a.ts"];
  await twins.changed("/a.ts");
  assertEquals(twins.peek("/a.ts"), undefined);
  assertEquals(twins.failure("/a.ts")!.why, "NotFound");
  assertEquals(twins.paths, []);
});

Deno.test("the diagnostics and the spans reach the twin", async () => {
  // A twin without its span table maps nothing back, and a diagnostic that never
  // arrives is one the author never sees.
  const fs = reader({ "/a.ts": `const a = 1;\n[cfg(deno)]\n` });
  const twins = twinsOver(fs);
  const twin = await twins.get("/a.ts");
  assertEquals(twin!.diagnostics.length, 1, "the dangling attribute");
  const direct = expand(fs.files["/a.ts"]!, macros());
  for (let at = 0; at < twin!.code.length; at++) {
    assertEquals(
      sourceOffset(twin!.spans, at),
      sourceOffset(direct.spans, at),
      `offset ${at}`,
    );
  }
});

Deno.test("two paths are independent", async () => {
  const fs = reader({ "/a.ts": KEPT, "/b.ts": DROPPED });
  const twins = twinsOver(fs);
  await twins.get("/a.ts");
  await twins.get("/b.ts");
  assertEquals(twins.paths.length, 2);

  twins.forget("/a.ts");
  assertEquals(twins.paths, ["/b.ts"]);
  assert(twins.peek("/b.ts") !== undefined, "b was untouched");
});

Deno.test("the cache is used, so an identical file is not expanded twice", async () => {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "loitsu-watch-" }),
  );
  try {
    const fs = reader({ "/a.ts": KEPT, "/b.ts": KEPT });
    const twins = new Twins({
      registry: macros(),
      against: "v1",
      cacheDir: dir,
      read: fs.read,
    });
    const a = await twins.get("/a.ts");
    const b = await twins.get("/b.ts");
    assertEquals(a!.hit, false, "the first is a miss");
    assertEquals(b!.hit, true, "the second is the same bytes, so a hit");
    assertEquals(a!.code, b!.code);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("interesting accepts what carries a body and refuses what does not", () => {
  for (const yes of ["/a.ts", "/deep/b.tsx", "a.ts"]) {
    assertEquals(interesting(yes), true, yes);
  }
  for (
    const no of [
      "/a.d.ts",
      "/a.js",
      "/a.json",
      "/a.md",
      "/a.tsx.bak",
      "/a",
      "",
    ]
  ) {
    assertEquals(interesting(no), false, no);
  }
});

Deno.test("the watch rebuilds a file that is written, and forgets one deleted", async () => {
  // The adapter, against a real filesystem, because what it exists to get right is
  // the mapping from real events to the two calls above.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "loitsu-watch-" }),
  );
  const path = `${dir}/a.ts`;
  const twins = new Twins({
    registry: macros(),
    against: "v1",
    cacheDir: undefined,
  });
  const stop = new AbortController();
  let batches = 0;
  const settled = Promise.withResolvers<void>();

  const running = watch({
    twins,
    paths: [dir],
    signal: stop.signal,
    settleMs: 5,
    onBatch: () => {
      batches++;
      settled.resolve();
    },
  });

  try {
    await Deno.writeTextFile(path, KEPT);
    await settled.promise;
    assert(twins.peek(path) !== undefined, "the written file has a twin");
    assertEquals(twins.peek(path)!.code, expand(KEPT, macros()).code);
    assert(batches >= 1);
  } finally {
    stop.abort();
    await running;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the watch ignores a file it has no business expanding", async () => {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "loitsu-watch-" }),
  );
  const twins = new Twins({
    registry: macros(),
    against: "v1",
    cacheDir: undefined,
  });
  const stop = new AbortController();
  const sawTs = Promise.withResolvers<void>();

  const running = watch({
    twins,
    paths: [dir],
    signal: stop.signal,
    settleMs: 5,
    onBatch: () => sawTs.resolve(),
  });

  try {
    await Deno.writeTextFile(`${dir}/notes.md`, "not typescript");
    await Deno.writeTextFile(`${dir}/types.d.ts`, "export {};");
    // The control: a file it should pick up, written last, so its batch arriving
    // proves the watch was running while the other two were written.
    await Deno.writeTextFile(`${dir}/a.ts`, KEPT);
    await sawTs.promise;
    assertEquals(twins.paths, [`${dir}/a.ts`]);
  } finally {
    stop.abort();
    await running;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aborting stops the watch", async () => {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "loitsu-watch-" }),
  );
  const twins = new Twins({
    registry: macros(),
    against: "v1",
    cacheDir: undefined,
  });
  const stop = new AbortController();
  const running = watch({ twins, paths: [dir], signal: stop.signal });
  stop.abort();
  await running; // resolves rather than hanging, which is the whole assertion
  try {
    await Deno.writeTextFile(`${dir}/a.ts`, KEPT);
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(twins.paths, [], "nothing was picked up after the abort");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the harness can fail, so the agreements above mean something", async () => {
  const fs = reader({ "/a.ts": KEPT });
  const twins = twinsOver(fs);
  assertEquals(twins.peek("/a.ts"), undefined, "before, there is nothing");
  await twins.get("/a.ts");
  assertNotEquals(twins.peek("/a.ts"), undefined, "after, there is");
  assertEquals(fs.reads, ["/a.ts"], "and the reader really was called");
});

Deno.test("the watch forgets a file that is deleted", async () => {
  // The other half of the adapter, and the one that was named in a test title and
  // never actually exercised. A twin left behind for a file that is gone is served
  // to the checker forever, and nothing will ever come along to remove it.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "loitsu-watch-" }),
  );
  const path = `${dir}/a.ts`;
  const twins = new Twins({
    registry: macros(),
    against: "v1",
    cacheDir: undefined,
  });
  const stop = new AbortController();
  let batch = Promise.withResolvers<void>();

  const running = watch({
    twins,
    paths: [dir],
    signal: stop.signal,
    settleMs: 5,
    onBatch: () => batch.resolve(),
  });

  try {
    await Deno.writeTextFile(path, KEPT);
    await batch.promise;
    assert(twins.peek(path) !== undefined, "the control: it was picked up");

    batch = Promise.withResolvers<void>();
    await Deno.remove(path);
    await batch.promise;
    assertEquals(twins.peek(path), undefined, "and dropped when it went away");
    assertEquals(twins.paths, []);
    // The assertion that separates forgetting from rebuilding. Rebuilding a deleted
    // file also clears the twin, because the read fails, so the two look identical
    // from `peek`. They differ here: a forgotten path is not a path that failed, and
    // recording it as one would report a diagnostic about a file nobody has.
    assertEquals(
      twins.failure(path),
      undefined,
      "forgotten, not recorded as an unreadable file",
    );
  } finally {
    stop.abort();
    await running;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a batch still settling when the watch stops is not dropped", async () => {
  // The events have been accepted and the rebuild has not happened yet. Dropping
  // that batch leaves twins older than changes the watch already took, which is the
  // one thing `Twins` exists to make impossible, reintroduced by the adapter.
  //
  // The settle window is made long and the abort lands inside it.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "loitsu-watch-" }),
  );
  const path = `${dir}/a.ts`;
  const twins = new Twins({
    registry: macros(),
    against: "v1",
    cacheDir: undefined,
  });
  const stop = new AbortController();
  const running = watch({
    twins,
    paths: [dir],
    signal: stop.signal,
    settleMs: 10_000,
  });

  try {
    await Deno.writeTextFile(path, KEPT);
    // Long enough for the event to arrive and be queued, far short of the settle.
    await new Promise((r) => setTimeout(r, 120));
    stop.abort();
    await running;
    assert(
      twins.peek(path) !== undefined,
      "the pending batch was flushed on the way out",
    );
    assertEquals(twins.peek(path)!.code, expand(KEPT, macros()).code);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
