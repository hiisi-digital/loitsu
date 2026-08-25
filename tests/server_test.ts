//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The proxy, driven over a pair of in-memory pipes rather than a real process.
 *
 * A real language server would answer these, which is exactly why it is not one
 * here: what is under test is which bytes cross which way and what happens to the
 * locations in them, and an inner server that answers on its own schedule turns
 * every assertion into a race. */
import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Server } from "../src/server.ts";
import { frame, type Message, messages } from "../src/rpc.ts";
import { doubling, macros, pipe } from "./macro_helpers.ts";

const HERE = toFileUrl("/proj/src/a.ts").href;

/** Untouched code, then one arm a macro keeps and one it drops. */
const BOTH = `export function untouched(who: string): string {\n` +
  `  return \`hei \${who}\`;\n}\n\n` +
  `[cfg(deno)]\nfunction kept() {\n  return 1;\n}\n` +
  `[cfg(node)]\nfunction gone() {\n  return 2;\n}\n`;

/** One statement a macro emits twice, so every name in it has two images. */
const DOUBLED = `[twice()]\nfunction hello() {\n  return 1;\n}\n`;

/** Both ends of the proxy, with a reader for each direction it writes into. */
function harness(registry = macros()) {
  const fromEditor = pipe();
  const toEditor = pipe();
  const fromInner = pipe();
  const toInner = pipe();

  const server = new Server({
    registry,
    against: "test",
    cacheDir: undefined,
    read: () => Promise.reject(new Deno.errors.NotFound("nothing on disk")),
    editor: { incoming: fromEditor.readable, outgoing: toEditor.writable },
    inner: { incoming: fromInner.readable, outgoing: toInner.writable },
  });

  const running = server.run();
  const editorWriter = fromEditor.writable.getWriter();
  const innerWriter = fromInner.writable.getWriter();
  const innerReads = messages(toInner.readable);
  const editorReads = messages(toEditor.readable);

  return {
    server,
    /** Send a message as the editor would. */
    fromEditor: (message: Message) => editorWriter.write(frame(message)),
    /** Send a message as the inner server would. */
    fromInner: (message: Message) => innerWriter.write(frame(message)),
    /** The next message the proxy sent downstream. */
    toInner: async (): Promise<Message> => {
      const next = await innerReads.next();
      assert(!next.done, "the proxy sent nothing downstream");
      return next.value;
    },
    /** The next message the proxy sent back to the editor. */
    toEditor: async (): Promise<Message> => {
      const next = await editorReads.next();
      assert(!next.done, "the proxy sent nothing back to the editor");
      return next.value;
    },
    /** Shut both ends and wait for the pumps to finish. */
    done: async (): Promise<void> => {
      await editorWriter.close();
      await innerWriter.close();
      await running;
      await innerReads.return(undefined);
      await editorReads.return(undefined);
    },
  };
}

/** A `didOpen` for the fixture. */
function opening(text = BOTH): Message {
  return {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: HERE, languageId: "typescript", version: 1, text },
    },
  };
}

Deno.test("what the inner server is handed", async (t) => {
  await t.step("is the twin, under the uri the author opened", async () => {
    const h = harness();
    await h.fromEditor(opening());

    const sent = await h.toInner();
    const doc = (sent.params as Record<string, Record<string, unknown>>)
      .textDocument;

    assertEquals(doc.uri, HERE, "the uri is the whole trick and does not move");
    assert(doc.text !== BOTH, "the source went down instead of the twin");
    assert(!String(doc.text).includes("gone"), "the dropped arm survived");
    assert(String(doc.text).includes("kept"), "the kept arm did not survive");

    await h.done();
  });

  await t.step("is whole twin content on every change", async () => {
    const h = harness();
    await h.fromEditor(opening());
    await h.toInner();

    await h.fromEditor({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: HERE, version: 2 },
        contentChanges: [{
          text: `[cfg(deno)]\nfunction only() {\n  return 3;\n}\n`,
        }],
      },
    });

    const sent = await h.toInner();
    const changes = (sent.params as Record<string, unknown[]>).contentChanges;
    assertEquals(changes.length, 1);
    const one = changes[0] as Record<string, unknown>;
    assertEquals(one.range, undefined, "a whole document carries no range");
    assert(String(one.text).includes("only"), "the new twin did not go down");

    await h.done();
  });

  await t.step(
    "is nothing at all when a change carries only ranges",
    async () => {
      // The capability rewrite is what stops these arriving. If one does, there
      // is no honest way to apply it, and forwarding it would leave the inner
      // server holding a document nobody can account for.
      const h = harness();
      await h.fromEditor(opening());
      await h.toInner();

      await h.fromEditor({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri: HERE, version: 2 },
          contentChanges: [{
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            text: "x",
          }],
        },
      });
      // Followed by something that does cross, so the assertion is that the
      // ranged change was skipped rather than that nothing was read yet.
      await h.fromEditor({ jsonrpc: "2.0", method: "$/setTrace", params: {} });

      assertEquals((await h.toInner()).method, "$/setTrace");

      await h.done();
    },
  );
});

Deno.test("what the editor is told it may send", async (t) => {
  await t.step(
    "is whole documents, whatever the inner server said",
    async () => {
      const h = harness();
      await h.fromEditor({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      await h.toInner();

      await h.fromInner({
        jsonrpc: "2.0",
        id: 1,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 2 },
            hoverProvider: true,
          },
        },
      });

      const answer = await h.toEditor();
      const caps = (answer.result as Record<string, Record<string, unknown>>)
        .capabilities;
      assertEquals(
        (caps.textDocumentSync as Record<string, unknown>).change,
        1,
        "incremental sync would send source coordinates for twin content",
      );
      assertEquals(
        (caps.textDocumentSync as Record<string, unknown>).openClose,
        true,
        "the rest of the sync options are the inner server's to decide",
      );
      assertEquals(caps.hoverProvider, true, "nothing else was touched");

      await h.done();
    },
  );

  await t.step(
    "is whole documents when the shorthand form is used",
    async () => {
      const h = harness();
      await h.fromEditor({
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: {},
      });
      await h.toInner();

      await h.fromInner({
        jsonrpc: "2.0",
        id: 7,
        result: { capabilities: { textDocumentSync: 2 } },
      });

      const caps = (await h.toEditor()).result as Record<
        string,
        Record<string, unknown>
      >;
      assertEquals(caps.capabilities.textDocumentSync, 1);

      await h.done();
    },
  );

  await t.step("leaves a later answer with the same id alone", async () => {
    // The id is only special for as long as the initialize answer is owed. A
    // server reusing it later must not have its result rewritten.
    const h = harness();
    await h.fromEditor({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    await h.toInner();
    await h.fromInner({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await h.toEditor();

    await h.fromInner({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { textDocumentSync: 2 } },
    });
    const again = (await h.toEditor()).result as Record<
      string,
      Record<string, unknown>
    >;
    assertEquals(again.capabilities.textDocumentSync, 2);

    await h.done();
  });
});

Deno.test("a location on its way through", async (t) => {
  await t.step("goes down onto the twin", async () => {
    const h = harness();
    await h.fromEditor(opening());
    await h.toInner();

    const line = BOTH.split("\n").indexOf("function kept() {");
    await h.fromEditor({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: HERE },
        position: { line, character: 9 },
      },
    });

    const sent = await h.toInner();
    const where = (sent.params as Record<string, Record<string, number>>)
      .position;
    const open = h.server.documents.get(HERE);
    assert(open !== undefined);

    assert(
      open.twin.split("\n")[where.line]!.slice(where.character).startsWith(
        "kept",
      ),
      "the position landed somewhere other than the name it came from",
    );
    assert(
      where.line !== line,
      "the attribute line above it is gone from the twin, so the line moves",
    );

    await h.done();
  });

  await t.step("comes back up onto what the author wrote", async () => {
    const h = harness();
    await h.fromEditor(opening());
    await h.toInner();

    const line = BOTH.split("\n").indexOf("function kept() {");
    const open = h.server.documents.get(HERE);
    assert(open !== undefined);
    const inTwin = open.mapping.toTwin({ line, character: 9 })[0];
    assert(inTwin !== undefined);

    await h.fromInner({
      jsonrpc: "2.0",
      id: 3,
      result: {
        uri: HERE,
        range: {
          start: inTwin,
          end: { line: inTwin.line, character: inTwin.character + 4 },
        },
      },
    });

    const answer = await h.toEditor();
    const back =
      (answer.result as Record<string, Record<string, Record<string, number>>>)
        .range;
    assertEquals(back.start.line, line);
    assertEquals(back.start.character, 9);

    await h.done();
  });

  await t.step(
    "is answered with nothing when it names text with no twin",
    async () => {
      const h = harness();
      await h.fromEditor(opening());
      await h.toInner();

      const line = BOTH.split("\n").indexOf("function gone() {");
      await h.fromEditor({
        jsonrpc: "2.0",
        id: 4,
        method: "textDocument/hover",
        params: {
          textDocument: { uri: HERE },
          position: { line, character: 9 },
        },
      });
      // The inner server never hears about it, so the next thing it does hear
      // is what proves the request stopped here.
      await h.fromEditor({ jsonrpc: "2.0", method: "$/setTrace", params: {} });

      assertEquals(await h.toEditor(), { jsonrpc: "2.0", id: 4, result: null });
      assertEquals((await h.toInner()).method, "$/setTrace");

      await h.done();
    },
  );

  await t.step(
    "is dropped without an answer when it was a notification",
    async () => {
      const h = harness();
      await h.fromEditor(opening());
      await h.toInner();

      const line = BOTH.split("\n").indexOf("function gone() {");
      await h.fromEditor({
        jsonrpc: "2.0",
        method: "$/somethingPositional",
        params: {
          textDocument: { uri: HERE },
          position: { line, character: 9 },
        },
      });
      await h.fromEditor({ jsonrpc: "2.0", method: "$/setTrace", params: {} });

      assertEquals((await h.toInner()).method, "$/setTrace");

      // And nothing went back up. A notification is owed no answer, so an empty
      // one is a message the editor never asked for and cannot match to
      // anything: the first thing it hears is the next real one.
      await h.fromInner({
        jsonrpc: "2.0",
        method: "window/logMessage",
        params: {},
      });
      assertEquals((await h.toEditor()).method, "window/logMessage");

      await h.done();
    },
  );

  await t.step("in another file crosses unchanged", async () => {
    const h = harness();
    await h.fromEditor(opening());
    await h.toInner();

    const elsewhere = toFileUrl("/proj/src/other.ts").href;
    const position = { line: 3, character: 1 };
    await h.fromEditor({
      jsonrpc: "2.0",
      id: 5,
      method: "textDocument/hover",
      params: { textDocument: { uri: elsewhere }, position },
    });

    const sent = await h.toInner();
    assertEquals((sent.params as Record<string, unknown>).position, position);

    await h.done();
  });
});

Deno.test("diagnostics the twin invented", async (t) => {
  await t.step("are dropped, and the rest come through", async () => {
    const h = harness();
    await h.fromEditor(opening());
    await h.toInner();

    const open = h.server.documents.get(HERE);
    assert(open !== undefined);

    const real = open.mapping.toTwinRanges({
      start: { line: 0, character: 16 },
      end: { line: 0, character: 25 },
    })[0];
    assert(real !== undefined, "the fixture should have an untouched name");

    // A place in the twin that came from nowhere: past the end of it.
    const past = open.twin.split("\n").length + 5;
    const invented = {
      start: { line: past, character: 0 },
      end: { line: past, character: 1 },
    };

    await h.fromInner({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: HERE,
        diagnostics: [
          { range: real, message: "about something the author wrote" },
          { range: invented, message: "about something a macro made up" },
        ],
      },
    });

    const sent = await h.toEditor();
    const carried = (sent.params as Record<string, Record<string, unknown>[]>)
      .diagnostics;
    assertEquals(carried.length, 1);
    assertEquals(carried[0].message, "about something the author wrote");

    await h.done();
  });
});

Deno.test("closing a document", async (t) => {
  await t.step("forgets it here and says so downstream", async () => {
    const h = harness();
    await h.fromEditor(opening());
    await h.toInner();
    assertEquals(h.server.documents.uris, [HERE]);

    await h.fromEditor({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: HERE } },
    });

    assertEquals((await h.toInner()).method, "textDocument/didClose");
    assertEquals(h.server.documents.uris, []);
    assertEquals(h.server.documents.buffered, []);

    await h.done();
  });
});

Deno.test("renaming a name a macro put in two places", async (t) => {
  /** The proxy, an open doubled document, and where `hello` sits in it. */
  async function ready() {
    const h = harness(doubling());
    await h.fromEditor({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: HERE,
          languageId: "typescript",
          version: 1,
          text: DOUBLED,
        },
      },
    });
    await h.toInner();

    const line = DOUBLED.split("\n").indexOf("function hello() {");
    const at = { line, character: 9 };
    const open = h.server.documents.get(HERE);
    assert(open !== undefined);
    assertEquals(
      h.server.documents.images(HERE, { start: at, end: at }).length,
      2,
      "the fixture should put the name in two places",
    );
    return { h, at, open };
  }

  await t.step("asks once per place, each at its own position", async () => {
    const { h, at } = await ready();

    await h.fromEditor({
      jsonrpc: "2.0",
      id: 9,
      method: "textDocument/rename",
      params: { textDocument: { uri: HERE }, position: at, newName: "hei" },
    });

    const first = await h.toInner();
    const second = await h.toInner();

    assertEquals(first.method, "textDocument/rename");
    assertEquals(second.method, "textDocument/rename");
    assertEquals(
      (first.params as Record<string, unknown>).newName,
      "hei",
      "the new name is the same question asked twice",
    );
    assert(first.id !== 9 && second.id !== 9, "the editor's id was reused");
    assert(first.id !== second.id, "two arms cannot share one id");

    const one =
      (first.params as Record<string, Record<string, number>>).position;
    const two = (second.params as Record<string, Record<string, number>>)
      .position;
    assert(
      one.line !== two.line || one.character !== two.character,
      "both requests asked about the same place",
    );

    await h.done();
  });

  await t.step(
    "answers with the arms added up, under the editor's own id",
    async () => {
      const { h, at, open } = await ready();

      await h.fromEditor({
        jsonrpc: "2.0",
        id: 9,
        method: "textDocument/rename",
        params: { textDocument: { uri: HERE }, position: at, newName: "hei" },
      });
      const first = await h.toInner();
      const second = await h.toInner();

      // Each arm answers about its own copy. Both copies came from the one
      // authored name, so both edits land on the same source range and the sum is
      // one edit rather than two.
      const images = h.server.documents.images(HERE, { start: at, end: at });
      await h.fromInner({
        jsonrpc: "2.0",
        id: first.id,
        result: {
          changes: {
            [HERE]: [{ range: images[0], newText: "hei" }],
          },
        },
      });
      await h.fromInner({
        jsonrpc: "2.0",
        id: second.id,
        result: {
          changes: {
            [HERE]: [{ range: images[1], newText: "hei" }],
          },
        },
      });

      const answer = await h.toEditor();
      assertEquals(answer.id, 9);
      const edits = (answer.result as Record<
        string,
        Record<string, Record<string, unknown>[]>
      >)
        .changes[HERE];
      assertEquals(edits.length, 1, "the same authored edit arrived twice");
      assertEquals(edits[0].newText, "hei");
      assertEquals(
        edits[0].range,
        open.mapping.toSourceRanges(images[0])[0],
        "the edit is in the coordinates the author is looking at",
      );

      await h.done();
    },
  );

  await t.step(
    "keeps two edits when the arms disagree about where",
    async () => {
      // The control for the case above: collapsing to one is the mapping saying
      // both arms named the same authored range, not the proxy discarding an arm.
      const { h, at, open } = await ready();

      await h.fromEditor({
        jsonrpc: "2.0",
        id: 9,
        method: "textDocument/rename",
        params: { textDocument: { uri: HERE }, position: at, newName: "hei" },
      });
      const first = await h.toInner();
      const second = await h.toInner();

      const images = h.server.documents.images(HERE, { start: at, end: at });
      const other = open.mapping.toTwinRanges({
        start: { line: 2, character: 9 },
        end: { line: 2, character: 10 },
      })[0];
      assert(
        other !== undefined,
        "the fixture should have a second mapped range",
      );

      await h.fromInner({
        jsonrpc: "2.0",
        id: first.id,
        result: { changes: { [HERE]: [{ range: images[0], newText: "hei" }] } },
      });
      await h.fromInner({
        jsonrpc: "2.0",
        id: second.id,
        result: { changes: { [HERE]: [{ range: other, newText: "hei" }] } },
      });

      const edits = ((await h.toEditor()).result as Record<
        string,
        Record<string, unknown[]>
      >).changes[HERE];
      assertEquals(edits.length, 2);

      await h.done();
    },
  );

  await t.step("still answers when one arm fails", async () => {
    const { h, at } = await ready();

    await h.fromEditor({
      jsonrpc: "2.0",
      id: 9,
      method: "textDocument/rename",
      params: { textDocument: { uri: HERE }, position: at, newName: "hei" },
    });
    const first = await h.toInner();
    const second = await h.toInner();

    const images = h.server.documents.images(HERE, { start: at, end: at });
    await h.fromInner({
      jsonrpc: "2.0",
      id: first.id,
      error: { code: -32603, message: "cannot rename here" },
    });
    await h.fromInner({
      jsonrpc: "2.0",
      id: second.id,
      result: { changes: { [HERE]: [{ range: images[1], newText: "hei" }] } },
    });

    const answer = await h.toEditor();
    assertEquals(answer.id, 9);
    const edits = (answer.result as Record<string, Record<string, unknown[]>>)
      .changes[HERE];
    assertEquals(
      edits.length,
      1,
      "the arm that answered was lost with the one that did not",
    );

    await h.done();
  });

  await t.step("does not fan out where the name landed once", async () => {
    const h = harness();
    await h.fromEditor(opening());
    await h.toInner();

    const line = BOTH.split("\n").indexOf("function kept() {");
    await h.fromEditor({
      jsonrpc: "2.0",
      id: 11,
      method: "textDocument/rename",
      params: {
        textDocument: { uri: HERE },
        position: { line, character: 9 },
        newName: "hei",
      },
    });

    const sent = await h.toInner();
    assertEquals(sent.id, 11, "one place needs no bookkeeping");

    await h.done();
  });
});
