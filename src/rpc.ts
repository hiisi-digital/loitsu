//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The wire the language server protocol runs on, which is JSON-RPC in a header.
 *
 * A message is `Content-Length: <n>`, a blank line, and `n` bytes of UTF-8 JSON.
 * The count is bytes rather than characters, and getting that wrong reads a
 * message short on the first non-ascii identifier in a file, so it is the thing
 * this module exists to get right.
 *
 * Nothing here knows what a message means. Routing is `protocol.ts` and the
 * proxy is `server.ts`.
 *
 * @module
 */

/** A JSON-RPC message, of whichever of the four shapes. */
export interface Message {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  // deno-lint-ignore no-explicit-any
  readonly [other: string]: any;
}

/** What a malformed header is reported as, so a caller can tell it apart. */
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

const SEPARATOR = new TextEncoder().encode("\r\n\r\n");
const LENGTH = /^content-length$/i;

/** Where `needle` first sits inside `hay` at or after `from`, or -1. */
function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let at = from; at + needle.length <= hay.length; at++) {
    for (let i = 0; i < needle.length; i++) {
      if (hay[at + i] !== needle[i]) continue outer;
    }
    return at;
  }
  return -1;
}

/**
 * The byte count one header block declares.
 *
 * Every other field is ignored, `Content-Type` included: the protocol allows it,
 * nothing here varies on it, and a server that sends one is not sending an error.
 * A block with no length is, because there is then no way to know where the body
 * ends and guessing would desynchronise the stream for good.
 */
function lengthOf(header: string): number {
  for (const line of header.split("\r\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    if (!LENGTH.test(line.slice(0, at).trim())) continue;
    const said = line.slice(at + 1).trim();
    // `Number` accepts "", "0x10" and " 12 ", and a header saying any of those
    // is malformed rather than long. Digits only, and the length has to fit.
    if (!/^[0-9]+$/.test(said)) {
      throw new FramingError(`content-length is not a count: ${said}`);
    }
    return Number(said);
  }
  throw new FramingError("a header block carried no content-length");
}

/**
 * An incremental decoder over a byte stream that arrives in arbitrary chunks.
 *
 * A chunk boundary falls wherever the operating system put it, which is
 * regularly mid-header, mid-body, and mid-character of a multi-byte one. So
 * bytes accumulate and messages come out only once a whole one is present.
 */
export class Frames {
  #held: Uint8Array = new Uint8Array(0);
  #decoder = new TextDecoder();

  /** How many bytes are held back waiting for the rest of their message. */
  get pending(): number {
    return this.#held.length;
  }

  /** Take in a chunk. Nothing is parsed until `drain` asks. */
  push(chunk: Uint8Array): void {
    const grown = new Uint8Array(this.#held.length + chunk.length);
    grown.set(this.#held, 0);
    grown.set(chunk, this.#held.length);
    this.#held = grown;
  }

  /**
   * Every whole message now held, oldest first, consuming them.
   *
   * A partial message stays held and comes out of a later call once the rest
   * arrives. Throwing here leaves the buffer as it was, which is deliberate:
   * a malformed header is not recoverable by reading further, so a caller that
   * catches and continues should see the same error rather than a stream that
   * has silently skipped to somewhere plausible.
   */
  drain(): Message[] {
    const out: Message[] = [];
    for (;;) {
      const blank = indexOf(this.#held, SEPARATOR, 0);
      if (blank < 0) return out;
      const header = this.#decoder.decode(this.#held.subarray(0, blank));
      const length = lengthOf(header);
      const from = blank + SEPARATOR.length;
      if (this.#held.length - from < length) return out;
      const body = this.#decoder.decode(
        this.#held.subarray(from, from + length),
      );
      this.#held = this.#held.slice(from + length);
      out.push(JSON.parse(body) as Message);
    }
  }
}

/** One message as bytes, header and all, ready to write. */
export function frame(message: Message): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  // The length is `body.length`, which is bytes, and not the string's, which
  // is utf-16 units. The two agree on ascii and part company on the first
  // accented identifier or emoji in a document.
  const header = new TextEncoder().encode(
    `Content-Length: ${body.length}\r\n\r\n`,
  );
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** Every message on a byte stream, in order, until it ends. */
export async function* messages(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Message> {
  const frames = new Frames();
  for await (const chunk of stream) {
    frames.push(chunk);
    for (const message of frames.drain()) yield message;
  }
  if (frames.pending > 0) {
    throw new FramingError(
      `the stream ended with ${frames.pending} bytes of an unfinished message`,
    );
  }
}
