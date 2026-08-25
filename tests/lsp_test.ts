//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The adapter that gives the proxy a real editor and a real language server.
 *
 * `Server` is tested over in-memory pipes in `server_test.ts`, so what is left
 * here is the wiring: that the project's macros reach the proxy, that a command
 * which is not a program says so rather than hanging, and that the inner process
 * does not outlive the proxy. Every one of those is a way the verb can be broken
 * while the proxy underneath it is perfect. */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { INNER, lsp, LspError, spawn } from "../cli/lsp.ts";
import type { Project } from "../cli/project.ts";
import { frame, type Message, messages } from "../src/rpc.ts";
import { macros, pipe } from "./macro_helpers.ts";

const HERE = toFileUrl("/proj/src/a.ts").href;

/** One arm a macro keeps and one it drops, so a twin is visibly not the source. */
const BOTH = `[cfg(deno)]\nfunction kept() {\n  return 1;\n}\n` +
  `[cfg(node)]\nfunction gone() {\n  return 2;\n}\n`;

/** A project whose macros are the test ones.\n *\n * Not `project`: that name belongs to the loader in `cli/project.ts`, which takes\n * a root and reads a config, and two functions of one name with different\n * signatures is a thing to get wrong later. */
function aProject(over?: Partial<Project>): Project {
  return { registry: macros(), against: "test", cacheDir: undefined, ...over };
}

Deno.test("the default inner server is deno's own", () => {
  assertEquals([...INNER], ["deno", "lsp"]);
});

Deno.test("a command naming no program is refused rather than spawned", () => {
  const why = assertThrows(() => spawn([]), LspError);
  assert(
    why.message.includes("nothing to proxy"),
    `said ${JSON.stringify(why.message)}`,
  );
});

Deno.test("a program that is not on the machine says so, naming the command", () => {
  const why = assertThrows(
    () => spawn(["loitsu-no-such-language-server", "--stdio"]),
    LspError,
  );
  assert(
    why.message.includes("loitsu-no-such-language-server --stdio"),
    "the message has to name what it tried to run",
  );
});

Deno.test("spawning gives a pipe that carries bytes both ways", async () => {
  const { channel, process } = spawn(["cat"]);
  const writer = channel.outgoing.getWriter();
  await writer.write(new TextEncoder().encode("hei\n"));
  await writer.close();

  const read = await new Response(channel.incoming).text();
  assertEquals(read, "hei\n");
  await process.status;
});

Deno.test("what the editor sends reaches the inner server, expanded", async () => {
  const fromEditor = pipe();
  const toEditor = pipe();
  const fromInner = pipe();
  const toInner = pipe();

  const running = lsp(aProject(), {
    editor: { incoming: fromEditor.readable, outgoing: toEditor.writable },
    channel: { incoming: fromInner.readable, outgoing: toInner.writable },
  });

  const editor = fromEditor.writable.getWriter();
  const inner = messages(toInner.readable);

  await editor.write(frame({
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
  }));

  const sent = await inner.next();
  assert(!sent.done, "nothing crossed to the inner server");
  const params = (sent.value as Message).params as Record<string, unknown>;
  const document = params.textDocument as Record<string, unknown>;

  assertEquals(
    document.uri,
    HERE,
    "the inner server sees the source's own uri",
  );
  const text = document.text as string;
  assert(text.includes("kept"), "the arm the macro keeps has to survive");
  assert(
    !text.includes("gone"),
    "the arm the macro drops reached the inner server, so nothing expanded",
  );

  await editor.close();
  await fromInner.writable.close();
  await running;
});

Deno.test("the proxy lets go when the editor does, rather than waiting forever", async () => {
  const fromEditor = pipe();
  const toEditor = pipe();

  // `cat` stands in for a language server: it holds its end open until killed,
  // which is what a real one does. `Server.run` waits on both directions, so
  // without something noticing the editor's end this call never returns and the
  // process is never killed. The race is what turns that into a failure rather
  // than a test that hangs.
  const running = lsp(aProject(), {
    inner: ["cat"],
    editor: { incoming: fromEditor.readable, outgoing: toEditor.writable },
  });

  await fromEditor.writable.close();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooLong = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), 5_000);
  });
  const outcome = await Promise.race([running.then(() => "returned"), tooLong]);
  if (timer !== undefined) clearTimeout(timer);

  assertEquals(
    outcome,
    "returned",
    "the editor went away and the proxy kept waiting on a process it had spawned",
  );
});

Deno.test("a project with no macros still proxies, rather than refusing", async () => {
  const fromEditor = pipe();
  const toEditor = pipe();
  const fromInner = pipe();
  const toInner = pipe();

  const running = lsp(aProject(), {
    editor: { incoming: fromEditor.readable, outgoing: toEditor.writable },
    channel: { incoming: fromInner.readable, outgoing: toInner.writable },
  });

  const editor = fromEditor.writable.getWriter();
  const inner = messages(toInner.readable);
  await editor.write(frame({ jsonrpc: "2.0", id: 1, method: "shutdown" }));

  const sent = await inner.next();
  assert(!sent.done, "a request with no document in it still has to cross");
  assertEquals((sent.value as Message).method, "shutdown");

  await editor.close();
  await fromInner.writable.close();
  await running;
});

Deno.test("lsp rejects with LspError when the inner command is not a program", async () => {
  const fromEditor = pipe();
  const toEditor = pipe();
  await assertRejects(
    () =>
      lsp(aProject(), {
        inner: ["loitsu-no-such-language-server"],
        editor: { incoming: fromEditor.readable, outgoing: toEditor.writable },
      }),
    LspError,
  );
});
