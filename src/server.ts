//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The proxy that sits between an editor and an ordinary language server.
 *
 * The editor opens the file the author wrote. What goes down the wire under that
 * same uri is the twin, so the inner server is only ever handed code with no
 * macros left in it, and never learns the source exists. Every location in every
 * message is translated on the way through: down on the way in, back up on the
 * way out. A location in text a macro invented has nowhere to land in the source
 * and is dropped rather than reported against whatever happens to sit at the
 * same offset.
 *
 * One thing is rewritten rather than translated. A source edit is not a twin
 * edit: renaming one name moves several regions of the twin at once, and no
 * incremental change expressed in source coordinates says that. So the sync
 * capability the inner server advertises is replaced with the full-document one
 * before the editor sees it, and whole twin content goes down on every change.
 *
 * @module
 */

import { crossed, DROPPED } from "./protocol.ts";
import { Documents, type DocumentsOptions } from "./documents.ts";
import { frame, type Message, messages } from "./rpc.ts";

/** A bidirectional pipe, which is all this needs of a process or a socket. */
export interface Channel {
  /** Bytes arriving from the other end. */
  readonly incoming: ReadableStream<Uint8Array>;
  /** Bytes going to the other end. */
  readonly outgoing: WritableStream<Uint8Array>;
}

/** What a proxy needs beyond what the document store needs. */
export interface ServerOptions extends DocumentsOptions {
  /** The editor. */
  readonly editor: Channel;
  /** The language server being proxied. */
  readonly inner: Channel;
}

/** The sync kind that makes the editor send whole documents. */
const FULL = 1;

/** The one request answered by asking several times and adding the answers up. */
const RENAME = "textDocument/rename";

/** Notifications carrying a document's text rather than a location in one. */
const DID_OPEN = "textDocument/didOpen";
const DID_CHANGE = "textDocument/didChange";
const DID_CLOSE = "textDocument/didClose";

/** True for a record, which is the only thing worth reaching into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `textDocument` a message's params names, when it names one. */
function documentOf(params: unknown): Record<string, unknown> | undefined {
  if (!isRecord(params)) return undefined;
  const doc = params.textDocument;
  return isRecord(doc) ? doc : undefined;
}

/** The uri of that document, when it has one. */
function uriOf(params: unknown): string | undefined {
  const uri = documentOf(params)?.uri;
  return typeof uri === "string" ? uri : undefined;
}

/** Its version, or zero where it carries none. */
function versionOf(params: unknown): number {
  const version = documentOf(params)?.version;
  return typeof version === "number" ? version : 0;
}

/**
 * The whole text a `didOpen` or `didChange` is carrying.
 *
 * A `didChange` may carry several changes, each either a whole document or a
 * range. Only the whole-document form can be applied here, and the capability
 * rewrite below is what makes it the only form that arrives.
 */
function textOf(method: string, params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;

  if (method === DID_OPEN) {
    const doc = params.textDocument;
    if (!isRecord(doc)) return undefined;
    return typeof doc.text === "string" ? doc.text : undefined;
  }

  const changes = params.contentChanges;
  if (!Array.isArray(changes)) return undefined;
  for (let at = changes.length - 1; at >= 0; at--) {
    const one = changes[at];
    if (!isRecord(one) || one.range !== undefined) continue;
    if (typeof one.text === "string") return one.text;
  }
  return undefined;
}

/**
 * The same message, carrying the twin's text instead of the author's.
 *
 * The uri is left exactly as it was. That is the whole trick: one uri, one
 * module identity, and nothing for a rename to fail to see.
 */
function carrying(message: Message, twin: string): Message {
  const params = message.params as Record<string, unknown>;

  if (message.method === DID_OPEN) {
    const doc = params.textDocument as Record<string, unknown>;
    return {
      ...message,
      params: { ...params, textDocument: { ...doc, text: twin } },
    };
  }

  return {
    ...message,
    params: { ...params, contentChanges: [{ text: twin }] },
  };
}

/**
 * The inner server's capabilities, with document sync forced to whole documents.
 *
 * Left alone, an editor negotiating incremental sync would send changes in
 * source coordinates for a document whose content is the twin, and there is no
 * honest way to apply those.
 */
function syncingWholeDocuments(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const capabilities = result.capabilities;
  if (!isRecord(capabilities)) return result;

  const sync = capabilities.textDocumentSync;
  const replaced = isRecord(sync) ? { ...sync, change: FULL } : FULL;

  return {
    ...result,
    capabilities: { ...capabilities, textDocumentSync: replaced },
  };
}

/** A rename waiting on one answer per arm. */
interface Renaming {
  /** The editor's own id, which is what the sum is finally sent under. */
  readonly id: number | string;
  /** How many arms have yet to answer. */
  owed: number;
  /** Edits gathered so far, in authored coordinates, per file. */
  readonly edits: Map<string, Record<string, unknown>[]>;
}

/** Every text edit in a workspace edit, whichever of its two shapes it uses. */
function editsOf(result: unknown): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  if (!isRecord(result)) return out;

  const changes = result.changes;
  if (isRecord(changes)) {
    for (const [uri, edits] of Object.entries(changes)) {
      if (Array.isArray(edits)) {
        out.set(uri, edits.filter(isRecord));
      }
    }
  }

  const documents = result.documentChanges;
  if (Array.isArray(documents)) {
    for (const one of documents) {
      if (!isRecord(one)) continue;
      const doc = one.textDocument;
      const edits = one.edits;
      if (!isRecord(doc) || typeof doc.uri !== "string") continue;
      if (!Array.isArray(edits)) continue;
      out.set(doc.uri, [
        ...(out.get(doc.uri) ?? []),
        ...edits.filter(isRecord),
      ]);
    }
  }

  return out;
}

/**
 * A proxy over one editor and one language server.
 *
 * Nothing here reads a file. The editor hands over what it holds, the expansion
 * turns that into a twin, and the twin is what travels.
 */
export class Server {
  readonly #documents: Documents;
  readonly #editor: Channel;
  readonly #inner: Channel;
  #toInner: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #toEditor: WritableStreamDefaultWriter<Uint8Array> | undefined;

  /** Ids of requests whose answer carries the inner server's capabilities. */
  readonly #initialising = new Set<string>();

  /** Renames in flight, by the id each arm's request was sent under. */
  readonly #renaming = new Map<string, Renaming>();

  /** Where the next fabricated id comes from. */
  #next = 0;

  constructor(options: ServerOptions) {
    this.#documents = new Documents(options);
    this.#editor = options.editor;
    this.#inner = options.inner;
  }

  /** The document store, so a caller can ask what is open and what failed. */
  get documents(): Documents {
    return this.#documents;
  }

  /** Pump both directions until either end stops. */
  async run(): Promise<void> {
    this.#toInner = this.#inner.outgoing.getWriter();
    this.#toEditor = this.#editor.outgoing.getWriter();
    try {
      await Promise.all([this.#down(), this.#up()]);
    } finally {
      await this.#toInner.close().catch(() => {});
      await this.#toEditor.close().catch(() => {});
    }
  }

  /** Editor to inner server. */
  async #down(): Promise<void> {
    for await (const message of messages(this.#editor.incoming)) {
      await this.#fromEditor(message);
    }
  }

  /** Inner server to editor. */
  async #up(): Promise<void> {
    for await (const message of messages(this.#inner.incoming)) {
      await this.#fromInner(message);
    }
  }

  /** One message on its way down, translated or rewritten as its method wants. */
  async #fromEditor(message: Message): Promise<void> {
    if (message.method === "initialize" && message.id != null) {
      this.#initialising.add(String(message.id));
    }

    const uri = uriOf(message.params);

    if (
      uri !== undefined &&
      (message.method === DID_OPEN || message.method === DID_CHANGE)
    ) {
      const text = textOf(message.method, message.params);
      if (text === undefined) return;
      const open = await this.#documents.changed(
        uri,
        versionOf(message.params),
        text,
      );
      await this.#send(this.#toInner, carrying(message, open.twin));
      return;
    }

    if (uri !== undefined && message.method === DID_CLOSE) {
      this.#documents.closed(uri);
      await this.#send(this.#toInner, message);
      return;
    }

    if (message.method === RENAME && message.id != null && uri !== undefined) {
      if (await this.#renameEveryArm(message, uri)) return;
    }

    const down = crossed(message, this.#documents.down, uri);
    if (down === DROPPED) {
      // The request names a place with no twin, so there is nothing to ask
      // about. A request still owes an answer; a notification owes nothing.
      await this.#nothing(this.#toEditor, message.id);
      return;
    }
    await this.#send(this.#toInner, down);
  }

  /**
   * Ask the inner server to rename, once for every place the name landed.
   *
   * A macro can put one authored name in several places, and to the inner server
   * those are different symbols: one request reaches one of them. So the request
   * is issued per image and the answers are added up, which is what turns several
   * twin symbols back into the one name the author is renaming.
   *
   * Answers false when there is nothing to fan out, and the ordinary path takes
   * it from there.
   */
  async #renameEveryArm(message: Message, uri: string): Promise<boolean> {
    const params = message.params as Record<string, unknown>;
    const at = params.position;
    if (!isRecord(at)) return false;

    const here = { start: at, end: at } as unknown as Parameters<
      Documents["images"]
    >[1];
    const images = this.#documents.images(uri, here);
    if (images.length < 2) return false;

    const waiting: Renaming = {
      id: message.id as number | string,
      owed: images.length,
      edits: new Map(),
    };

    for (const image of images) {
      const id = `loitsu/rename/${this.#next++}`;
      this.#renaming.set(id, waiting);
      await this.#send(this.#toInner, {
        ...message,
        id,
        params: { ...params, position: image.start },
      });
    }
    return true;
  }

  /**
   * One arm's answer, folded into the rename it belongs to.
   *
   * The last one to arrive is what sends the sum. An arm that failed still
   * counts, because a rename that reached three arms and got two answers is
   * better than one the editor never hears back about.
   */
  async #gather(id: string, message: Message): Promise<void> {
    const waiting = this.#renaming.get(id);
    if (waiting === undefined) return;
    this.#renaming.delete(id);

    const up = crossed(message.result, this.#documents.up, undefined);
    if (up !== DROPPED) {
      for (const [where, edits] of editsOf(up)) {
        const already = waiting.edits.get(where) ?? [];
        for (const edit of edits) {
          const same = JSON.stringify(edit);
          if (already.some((one) => JSON.stringify(one) === same)) continue;
          already.push(edit);
        }
        waiting.edits.set(where, already);
      }
    }

    waiting.owed -= 1;
    if (waiting.owed > 0) return;

    await this.#send(this.#toEditor, {
      jsonrpc: "2.0",
      id: waiting.id,
      result: { changes: Object.fromEntries(waiting.edits) },
    });
  }

  /** One message on its way up, translated back onto what the author wrote. */
  async #fromInner(message: Message): Promise<void> {
    if (typeof message.id === "string" && this.#renaming.has(message.id)) {
      await this.#gather(message.id, message);
      return;
    }

    if (message.id != null && this.#initialising.delete(String(message.id))) {
      await this.#send(this.#toEditor, {
        ...message,
        result: syncingWholeDocuments(message.result),
      });
      return;
    }

    const up = crossed(message, this.#documents.up, uriOf(message.params));
    if (up === DROPPED) {
      // A whole message with nowhere to land. An answer the editor is waiting
      // for still has to arrive, so it arrives empty.
      await this.#nothing(this.#toInner, message.id);
      return;
    }
    await this.#send(this.#toEditor, up);
  }

  /**
   * Tell whoever asked that there is no answer.
   *
   * A notification is owed nothing and gets nothing. A request left unanswered
   * is a request its sender waits on until it gives up.
   *
   * The reply goes back the way the request came. Both ends may ask: an editor
   * asks for a definition, and a server asks the editor to show a document or
   * to apply an edit. They number their requests separately, so answering a
   * server's request to the editor sends the editor an id from the wrong id
   * space, against a request the editor may well have outstanding under that
   * same number, while the server that asked waits forever.
   */
  async #nothing(
    to: WritableStreamDefaultWriter<Uint8Array> | undefined,
    id: Message["id"],
  ): Promise<void> {
    if (id == null) return;
    await this.#send(to, { jsonrpc: "2.0", id, result: null });
  }

  /** One framed message, or nothing if that direction is already closed. */
  async #send(
    to: WritableStreamDefaultWriter<Uint8Array> | undefined,
    message: Message,
  ): Promise<void> {
    if (to === undefined) return;
    await to.write(frame(message));
  }
}
