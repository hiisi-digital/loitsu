//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The four places a review found defects, none of which any test reached.
 *
 * They were not hard cases. They were the cases nobody sampled: the `--`
 * argument, the second shape a workspace edit comes in, a request travelling the
 * other way, and running the same command twice. Each one is here with the
 * control that shows the check can fail, because a test written after the fix it
 * describes is worth exactly what its negative control is worth.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { join } from "@std/path";
import { asked } from "../cli/mod.ts";
import { crossed, DROPPED } from "../src/protocol.ts";
import { SKIPPED, sources } from "../cli/sources.ts";
import { Server } from "../src/server.ts";
import { frame, type Message, messages } from "../src/rpc.ts";
import { macros, pipe } from "./macro_helpers.ts";

const HERE = toFileUrl("/proj/src/a.ts").href;

/** One arm kept, one dropped, so a twin position is not a source position. */
const BOTH = `[cfg(deno)]\nfunction kept() {\n  return 1;\n}\n` +
  `[cfg(node)]\nfunction gone() {\n  return 2;\n}\n`;

// --------------------------------------------------------------------------
// the `--` argument, which carried a surviving mutation
// --------------------------------------------------------------------------

Deno.test("everything after -- is the command, taken whole", () => {
  const it = asked(["lsp", "--", "typescript-language-server", "--stdio"]);
  assertEquals(it.verb, "lsp");
  assertEquals(it.inner, ["typescript-language-server", "--stdio"]);
});

Deno.test("the word straight after -- is not skipped", () => {
  // the mutation that survived read `slice(i + 2)`, which loses the program and
  // leaves its arguments, so the tool would run `--stdio` as a command
  const it = asked(["lsp", "--", "deno", "lsp"]);
  assertEquals(it.inner?.[0], "deno", "the program itself has to survive");
  assertEquals(it.inner?.length, 2);
});

Deno.test("flags after -- belong to the command, not to this tool", () => {
  const it = asked(["lsp", "--root", "/a", "--", "server", "--root", "/b"]);
  assertEquals(it.root, "/a", "our flag before the marker still applies");
  assertEquals(
    it.inner,
    ["server", "--root", "/b"],
    "theirs is not read as ours",
  );
});

Deno.test("a bare -- names no command rather than an empty one", () => {
  assertEquals(asked(["lsp", "--"]).inner, undefined);
});

Deno.test("no -- at all leaves the command unset", () => {
  assertEquals(asked(["lsp"]).inner, undefined);
  assertEquals(asked(["build", "--root", "/a"]).inner, undefined);
});

// --------------------------------------------------------------------------
// the second shape a workspace edit arrives in
// --------------------------------------------------------------------------

/** A crossing that moves every line down by ten, so a miss is unmistakable. */
const shifted = {
  range: (
    r: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    },
    uri?: string,
  ) =>
    uri === HERE
      ? {
        start: { line: r.start.line + 10, character: r.start.character },
        end: { line: r.end.line + 10, character: r.end.character },
      }
      : undefined,
  point: (p: { line: number; character: number }, uri?: string) =>
    uri === HERE ? { line: p.line + 10, character: p.character } : undefined,
};

const RANGE = {
  start: { line: 1, character: 0 },
  end: { line: 1, character: 4 },
};

Deno.test("a documentChanges edit is crossed, not passed through unchanged", () => {
  const out = crossed(
    {
      documentChanges: [{
        textDocument: { uri: HERE, version: 1 },
        edits: [{ range: RANGE, newText: "x" }],
      }],
    },
    shifted,
    undefined,
  );

  assert(out !== DROPPED);
  const doc =
    (out as { documentChanges: { edits: { range: typeof RANGE }[] }[] })
      .documentChanges[0]!;
  assertEquals(
    doc.edits[0]!.range.start.line,
    11,
    "the uri under textDocument has to be found, or the range comes back as it went in",
  );
});

Deno.test("the changes shape still crosses, which is the control", () => {
  const out = crossed(
    { changes: { [HERE]: [{ range: RANGE, newText: "x" }] } },
    shifted,
    undefined,
  );
  assert(out !== DROPPED);
  const edits = (out as { changes: Record<string, { range: typeof RANGE }[]> })
    .changes[HERE]!;
  assertEquals(edits[0]!.range.start.line, 11);
});

Deno.test("a document the proxy never opened is passed through untouched", () => {
  // deliberate, and worth pinning because it looks like the bug next door: a
  // document nobody opened has no twin, so its positions are already source
  // positions and crossing them would be the error. `Documents.crossing` returns
  // the range unchanged for exactly this case.
  const asIs = {
    range: (r: typeof RANGE, uri?: string) => uri === HERE ? undefined : r,
    point: (pt: { line: number; character: number }, uri?: string) =>
      uri === HERE ? undefined : pt,
  };
  const other = toFileUrl("/proj/src/other.ts").href;
  const out = crossed(
    {
      documentChanges: [{
        textDocument: { uri: other, version: 1 },
        edits: [{ range: RANGE, newText: "x" }],
      }],
    },
    asIs,
    undefined,
  );
  assert(out !== DROPPED);
  const doc =
    (out as { documentChanges: { edits: { range: typeof RANGE }[] }[] })
      .documentChanges[0]!;
  assertEquals(doc.edits[0]!.range.start.line, 1, "untouched, not shifted");
});

// --------------------------------------------------------------------------
// a request travelling the other way
// --------------------------------------------------------------------------

/** Both ends of the proxy, with a reader for each direction it writes into.
 *
 * Not `harness`: `server_test.ts` has one of that name taking a registry, and two
 * functions sharing a name with different signatures is a thing to get wrong
 * later. This one is fixed on the test macros and returns the readers, because
 * what these tests watch is which way a message went. */
function bothEnds() {
  const fromEditor = pipe(), toEditor = pipe();
  const fromInner = pipe(), toInner = pipe();
  const server = new Server({
    registry: macros(),
    against: "test",
    cacheDir: undefined,
    read: () => Promise.reject(new Deno.errors.NotFound("nothing on disk")),
    editor: { incoming: fromEditor.readable, outgoing: toEditor.writable },
    inner: { incoming: fromInner.readable, outgoing: toInner.writable },
  });
  const running = server.run();
  const editorWriter = fromEditor.writable.getWriter();
  const innerWriter = fromInner.writable.getWriter();
  return {
    fromEditor: (m: Message) => editorWriter.write(frame(m)),
    fromInner: (m: Message) => innerWriter.write(frame(m)),
    innerReads: messages(toInner.readable),
    editorReads: messages(toEditor.readable),
    async close() {
      await editorWriter.close().catch(() => {});
      await innerWriter.close().catch(() => {});
      await running.catch(() => {});
      // a generator nobody finished keeps a read pending, and deno calls that a
      // leak rather than a tidy end
      await Promise.all([
        toInner.readable.cancel().catch(() => {}),
        toEditor.readable.cancel().catch(() => {}),
      ]);
    },
  };
}

Deno.test("a dropped request from the inner server is answered to the inner server", async () => {
  const h = bothEnds();
  try {
    await h.fromEditor({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: HERE,
          languageId: "typescript",
          version: 1,
          text: BOTH,
        },
      },
    });
    await h.innerReads.next();

    // a position inside the arm the macro dropped has no authored image
    await h.fromInner({
      jsonrpc: "2.0",
      id: 7,
      method: "window/showDocument",
      params: {
        uri: HERE,
        selection: {
          start: { line: 99, character: 0 },
          end: { line: 99, character: 1 },
        },
      },
    });

    const back = await h.innerReads.next();
    assert(
      !back.done,
      "the server that asked has to be answered, or it waits forever",
    );
    assertEquals((back.value as Message).id, 7);
    assertEquals((back.value as Message).result, null);
  } finally {
    await h.close();
  }
});

Deno.test("a dropped request from the editor is answered to the editor", async () => {
  const h = bothEnds();
  try {
    await h.fromEditor({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: HERE,
          languageId: "typescript",
          version: 1,
          text: BOTH,
        },
      },
    });
    await h.innerReads.next();

    // line 5 is inside the arm the macro drops, so it has no image in the twin
    // and the request cannot be carried down
    await h.fromEditor({
      jsonrpc: "2.0",
      id: 3,
      method: "textDocument/definition",
      params: {
        textDocument: { uri: HERE },
        position: { line: 5, character: 10 },
      },
    });

    const back = await h.editorReads.next();
    assert(!back.done, "the editor asked and has to be answered, or it waits");
    assertEquals((back.value as Message).id, 3);
    assertEquals((back.value as Message).result, null);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------------------------
// running the same command twice
// --------------------------------------------------------------------------

Deno.test("the tool's own output is not a source", async () => {
  assert(
    SKIPPED.includes(".loitsu"),
    "without this a second build expands the first build's twins",
  );

  const root = await Deno.makeTempDir({ prefix: "loitsu_walk_" });
  try {
    await Deno.mkdir(join(root, ".loitsu", "twins", "src"), {
      recursive: true,
    });
    await Deno.writeTextFile(join(root, "src.ts"), "export const one = 1;\n");
    await Deno.mkdir(join(root, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "src", "a.ts"),
      "export const a = 1;\n",
    );
    await Deno.writeTextFile(
      join(root, ".loitsu", "twins", "src", "a.ts"),
      "export const a = 1;\n",
    );

    const found: string[] = [];
    for await (const one of sources(root)) {
      found.push(one.slice(root.length + 1));
    }
    assertEquals(found.sort(), ["src.ts", "src/a.ts"]);

    // the control: told to skip nothing, the walk does find the twin, so the
    // assertion above is about the skip list rather than about the fixture
    const all: string[] = [];
    for await (const one of sources(root, { skip: [] })) all.push(one);
    assert(
      all.some((one) => one.includes(".loitsu")),
      "the twin is there to be found; the skip list is what leaves it alone",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --------------------------------------------------------------------------
// a load that carries no source
// --------------------------------------------------------------------------

Deno.test("a module node returns no source for is left alone", async () => {
  const { nodeHook } = await import("../src/install.ts");
  const { load } = nodeHook(() => "/* expanded */\n", () => true);

  // node returns no source for some formats, `commonjs` among them, and
  // decoding undefined gives "" rather than throwing, so the module was being
  // replaced with the expansion of nothing
  const bare = load(
    "file:///proj/src/a.cts",
    undefined,
    () => ({ format: "commonjs", shortCircuit: true }),
  );
  assertEquals(
    bare.source,
    undefined,
    "nothing to expand means nothing changed",
  );
  assertEquals(bare.format, "commonjs");

  // the control: when there is source, it is expanded
  const carried = load(
    "file:///proj/src/a.ts",
    undefined,
    () => ({
      format: "module",
      source: "export const a = 1;\n",
      shortCircuit: true,
    }),
  );
  assertEquals(carried.source, "/* expanded */\n");
});
