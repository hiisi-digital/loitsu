//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  frame,
  Frames,
  FramingError,
  type Message,
  messages,
} from "../src/rpc.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A header and a body, with the count written by hand so a test can lie. */
function wire(
  body: string,
  length = bytes(body).length,
  name = "Content-Length",
): Uint8Array {
  const header = bytes(`${name}: ${length}\r\n\r\n`);
  const rest = bytes(body);
  const out = new Uint8Array(header.length + rest.length);
  out.set(header, 0);
  out.set(rest, header.length);
  return out;
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

Deno.test("framing", async (t) => {
  await t.step("one message arriving whole comes back out", () => {
    const frames = new Frames();
    frames.push(wire('{"jsonrpc":"2.0","id":1,"method":"initialize"}'));
    const out = frames.drain();
    assertEquals(out.length, 1);
    assertEquals(out[0]!.method, "initialize");
    assertEquals(out[0]!.id, 1);
    assertEquals(frames.pending, 0);
  });

  await t.step("two messages in one chunk come back as two, in order", () => {
    const frames = new Frames();
    const both = new Uint8Array([
      ...wire('{"id":1}'),
      ...wire('{"id":2}'),
    ]);
    frames.push(both);
    assertEquals(frames.drain().map((m) => m.id), [1, 2]);
    assertEquals(frames.pending, 0);
  });

  await t.step(
    "a message split at every byte boundary still arrives once",
    () => {
      // The exhaustive form rather than a sample. A decoder that mishandles one
      // specific boundary, the one inside the separator most of all, passes any
      // test that happens not to cut there.
      const whole = wire('{"id":7,"method":"hover"}');
      for (let at = 0; at <= whole.length; at++) {
        const frames = new Frames();
        frames.push(whole.subarray(0, at));
        const early = frames.drain();
        frames.push(whole.subarray(at));
        const late = frames.drain();
        const seen = [...early, ...late];
        assertEquals(
          seen.length,
          1,
          `split at ${at} gave ${seen.length} messages`,
        );
        assertEquals(seen[0]!.id, 7, `split at ${at}`);
        assertEquals(frames.pending, 0, `split at ${at} left bytes behind`);
      }
    },
  );

  await t.step("a body split inside a multi-byte character survives", () => {
    // The control for decoding per chunk rather than per message. A decoder
    // that ran TextDecoder over each chunk as it arrived would produce a
    // replacement character here and the JSON would still parse, so the
    // assertion is on the value rather than on not throwing.
    const whole = wire('{"name":"tervehdiä🐍"}');
    for (let at = 0; at <= whole.length; at++) {
      const frames = new Frames();
      frames.push(whole.subarray(0, at));
      frames.push(whole.subarray(at));
      const out = frames.drain();
      assertEquals(out.length, 1, `split at ${at}`);
      assertEquals(out[0]!.name, "tervehdiä🐍", `split at ${at}`);
    }
  });

  await t.step(
    "the count is bytes, so a non-ascii body is not read short",
    () => {
      const body = '{"say":"äöå"}';
      assert(
        bytes(body).length > body.length,
        "the control needs a body whose byte count and utf-16 count differ",
      );
      const frames = new Frames();
      frames.push(wire(body));
      assertEquals(frames.drain()[0]!.say, "äöå");
      assertEquals(frames.pending, 0);
    },
  );

  await t.step(
    "a count written in utf-16 units reads the message short",
    () => {
      // The negative of the one above, and the reason it is worth pinning: a
      // wrong count does not fail loudly, it takes a prefix and leaves the tail
      // in the buffer where it desynchronises everything after it.
      const body = '{"say":"äöå"}';
      const frames = new Frames();
      frames.push(wire(body, body.length));
      assertThrows(() => frames.drain(), SyntaxError);
    },
  );

  await t.step("a header carrying other fields is accepted", () => {
    const frames = new Frames();
    frames.push(
      bytes(
        'Content-Length: 8\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{"id":3}',
      ),
    );
    assertEquals(frames.drain()[0]!.id, 3);
  });

  await t.step("the length field is matched without regard to case", () => {
    const frames = new Frames();
    frames.push(wire('{"id":4}', undefined, "content-length"));
    assertEquals(frames.drain()[0]!.id, 4);
  });

  await t.step(
    "a header with no length is refused rather than guessed at",
    () => {
      const frames = new Frames();
      frames.push(bytes('Content-Type: text/plain\r\n\r\n{"id":5}'));
      assertThrows(() => frames.drain(), FramingError, "no content-length");
    },
  );

  await t.step("a length that is not a plain count is refused", () => {
    // Every one of these is something `Number` would accept, which is why the
    // check is a digit test rather than a conversion.
    for (
      const said of ["", " ", "0x10", "1e3", "-4", "1.5", "+7", "Infinity"]
    ) {
      const frames = new Frames();
      frames.push(bytes(`Content-Length: ${said}\r\n\r\n{"id":6}`));
      assertThrows(
        () => frames.drain(),
        FramingError,
        "not a count",
        `"${said}" was accepted as a length`,
      );
    }
  });

  await t.step(
    "a plain count is accepted, which is the control for the refusals",
    () => {
      const frames = new Frames();
      frames.push(bytes('Content-Length: 8\r\n\r\n{"id":6}'));
      assertEquals(frames.drain()[0]!.id, 6);
    },
  );

  await t.step("a bare newline does not end the header block", () => {
    // Lenient here would be worse than strict: a server sending \n alone is
    // sending something this cannot frame, and treating the body as a header
    // would desynchronise instead of reporting.
    const frames = new Frames();
    frames.push(bytes('Content-Length: 8\n\n{"id":9}'));
    assertEquals(frames.drain(), []);
    assert(frames.pending > 0, "the bytes should still be held");
  });

  await t.step(
    "a malformed header throws again rather than being skipped",
    () => {
      const frames = new Frames();
      frames.push(bytes('Content-Type: text/plain\r\n\r\n{"id":5}'));
      assertThrows(() => frames.drain(), FramingError);
      assertThrows(() => frames.drain(), FramingError);
    },
  );

  await t.step("pending reports the bytes held back", () => {
    const frames = new Frames();
    assertEquals(frames.pending, 0);
    const whole = wire('{"id":1}');
    frames.push(whole.subarray(0, whole.length - 3));
    assertEquals(frames.drain(), []);
    assertEquals(frames.pending, whole.length - 3);
    frames.push(whole.subarray(whole.length - 3));
    assertEquals(frames.drain().length, 1);
    assertEquals(frames.pending, 0);
  });

  await t.step("a zero-length body is a message, not a wait", () => {
    const frames = new Frames();
    frames.push(bytes("Content-Length: 0\r\n\r\n"));
    assertThrows(() => frames.drain(), SyntaxError);
    assertEquals(frames.pending, 0, "the empty body should have been consumed");
  });
});

Deno.test("writing", async (t) => {
  await t.step("what frame writes is what Frames reads back", () => {
    const message: Message = {
      jsonrpc: "2.0",
      id: 11,
      method: "textDocument/rename",
      params: { newName: "tervehdiä" },
    };
    const frames = new Frames();
    frames.push(frame(message));
    assertEquals(frames.drain(), [message]);
  });

  await t.step("the header counts the body's bytes", () => {
    const written = new TextDecoder().decode(frame({ say: "äöå" }));
    const [header, body] = written.split("\r\n\r\n");
    assertEquals(header, `Content-Length: ${bytes(body!).length}`);
    assert(
      bytes(body!).length !== body!.length,
      "the control needs a body whose two counts differ",
    );
  });

  await t.step(
    "two written messages concatenate into one readable stream",
    () => {
      const frames = new Frames();
      frames.push(new Uint8Array([...frame({ id: 1 }), ...frame({ id: 2 })]));
      assertEquals(frames.drain().map((m) => m.id), [1, 2]);
    },
  );
});

Deno.test("reading a stream", async (t) => {
  await t.step("every message comes out in order", async () => {
    const seen: unknown[] = [];
    for await (
      const message of messages(
        streamOf([frame({ id: 1 }), frame({ id: 2 }), frame({ id: 3 })]),
      )
    ) {
      seen.push(message.id);
    }
    assertEquals(seen, [1, 2, 3]);
  });

  await t.step("chunking is invisible to the caller", async () => {
    const whole = new Uint8Array([...frame({ id: 1 }), ...frame({ id: 2 })]);
    const single = [...whole].map((b) => new Uint8Array([b]));
    const seen: unknown[] = [];
    for await (const message of messages(streamOf(single))) {
      seen.push(message.id);
    }
    assertEquals(seen, [1, 2]);
  });

  await t.step("a stream ending mid-message is reported", async () => {
    const whole = frame({ id: 1 });
    const cut = streamOf([whole.subarray(0, whole.length - 2)]);
    let why: unknown;
    try {
      for await (const _ of messages(cut)) { /* nothing arrives */ }
    } catch (err) {
      why = err;
    }
    assert(why instanceof FramingError, `expected a FramingError, got ${why}`);
    assert(
      (why as Error).message.includes("unfinished"),
      (why as Error).message,
    );
  });

  await t.step("a stream ending cleanly is not reported", async () => {
    // The control for the one above. Without it that test passes against a
    // reader that throws at the end of every stream.
    const seen: unknown[] = [];
    for await (const message of messages(streamOf([frame({ id: 1 })]))) {
      seen.push(message.id);
    }
    assertEquals(seen, [1]);
  });

  await t.step(
    "an empty stream yields nothing and does not complain",
    async () => {
      const seen: unknown[] = [];
      for await (const message of messages(streamOf([]))) seen.push(message);
      assertEquals(seen, []);
    },
  );
});
