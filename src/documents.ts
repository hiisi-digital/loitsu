//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * What the editor holds, what the inner server was handed, and the two
 * crossings between them.
 *
 * The editor opens a source file and types into it. The inner server is handed
 * the twin under that same uri and never sees the source at all, so every
 * position going down is an authored one that has to be found in the twin, and
 * every position coming up is a twin one that has to be found in the source or
 * dropped.
 *
 * Nothing here talks to a process. The wire is `rpc.ts`, the structural walk is
 * `protocol.ts`, and joining the three is `server.ts`.
 *
 * @module
 */

import { fromFileUrl } from "@std/path";
import {
  DEFAULT_ENCODING,
  type Encoding,
  type Position,
  type Range,
} from "./position.ts";
import type { Crossing } from "./protocol.ts";
import { Mapping } from "./translate.ts";
import { identity } from "./spans.ts";
import { Twins, type TwinsOptions, type Unreadable } from "./watch.ts";

/** One document the editor has open, and the twin standing in for it. */
export interface Open {
  /** The uri the editor opened, which the inner server also sees. */
  readonly uri: string;
  /** That uri as a path, which is what a twin is keyed on. */
  readonly path: string;
  /** The editor's version of this document, from its last notification. */
  readonly version: number;
  /** What the author has typed. */
  readonly source: string;
  /** The text the inner server was handed. */
  readonly twin: string;
  /** The two coordinate systems and the crossings between them. */
  readonly mapping: Mapping;
}

/** What a `Documents` needs, which is what a `Twins` needs plus the encoding. */
export interface DocumentsOptions extends TwinsOptions {
  /** What the client and this agreed to count positions in. */
  readonly encoding?: Encoding;
}

/**
 * Every document the editor has open, and their twins.
 *
 * A twin is rebuilt from the editor's buffer rather than from disk, because the
 * two disagree for as long as anything is unsaved, which is most of the time
 * anybody is working.
 */
export class Documents {
  readonly #twins: Twins;
  readonly #encoding: Encoding;
  readonly #open = new Map<string, Open>();
  /** The text of each open document, keyed by path rather than uri, because
   * that is what a reader is asked for. */
  readonly #held = new Map<string, string>();

  /**
   * The `Twins` is built here rather than handed in, because it has to be built
   * with a reader that answers from these buffers and this object owns them.
   * Constructing it outside would mean handing a reader to a thing that does
   * not exist yet.
   *
   * A path nobody has open falls through to `options.read`, or to disk when
   * that is absent. Refusing it would break the twin of a file the editor
   * imports and has never opened.
   */
  constructor(options: DocumentsOptions) {
    const disk = options.read ?? ((path: string) => Deno.readTextFile(path));
    this.#twins = new Twins({
      ...options,
      read: (path) => {
        const held = this.#held.get(path);
        return held === undefined ? disk(path) : Promise.resolve(held);
      },
    });
    this.#encoding = options.encoding ?? DEFAULT_ENCODING;
  }

  /** The encoding positions crossing these documents are counted in. */
  get encoding(): Encoding {
    return this.#encoding;
  }

  /** What is currently open under a uri, or nothing. */
  get(uri: string): Open | undefined {
    return this.#open.get(uri);
  }

  /** Every uri currently open, in the order they were opened. */
  get uris(): string[] {
    return [...this.#open.keys()];
  }

  /**
   * Take in what the editor now holds, and rebuild the twin from it.
   *
   * The same call serves `didOpen` and `didChange`, because a source edit is
   * not a twin edit: renaming one identifier moves several regions of the twin
   * at once and no incremental change against source coordinates expresses
   * that. So the whole twin is rebuilt and the whole twin is what goes down.
   */
  async changed(uri: string, version: number, source: string): Promise<Open> {
    const path = fromFileUrl(uri);
    this.#held.set(path, source);
    await this.#twins.changed(path);
    const twin = await this.#twins.get(path);
    // A twin that could not be built leaves the source standing in for itself,
    // with an identity map. The inner server then answers about what the author
    // wrote, which is wrong for a file with macros in it and is the only thing
    // available; refusing to forward would leave the editor with no server at
    // all for as long as the expansion is broken.
    const open: Open = {
      uri,
      path,
      version,
      source,
      twin: twin?.code ?? source,
      mapping: new Mapping({
        source,
        twin: twin?.code ?? source,
        spans: twin?.spans ?? identity(source.length),
      }, this.#encoding),
    };
    this.#open.set(uri, open);
    return open;
  }

  /** Forget a document the editor closed, and its twin. */
  closed(uri: string): void {
    const open = this.#open.get(uri);
    if (open === undefined) return;
    this.#open.delete(uri);
    this.#held.delete(open.path);
    this.#twins.forget(open.path);
  }

  /**
   * Every twin range one authored range covers.
   *
   * Plural because an expansion is plural: a macro that derives something
   * returns the original alongside what it derived, so one authored region has
   * several images. A caller that acts on one of them and not the rest is the
   * partial rename this exists to prevent, so a request that edits gets asked
   * once per image and the answers are unioned.
   */
  images(uri: string, range: Range): Range[] {
    return this.#open.get(uri)?.mapping.toTwinRanges(range) ?? [range];
  }

  /**
   * The paths a buffer is still held for.
   *
   * Serving an editor means opening and closing files all day, so what is kept
   * has to come back down again. A closed document leaves no buffer behind, and
   * this is where that is visible.
   */
  get buffered(): string[] {
    return [...this.#held.keys()].sort();
  }

  /**
   * Why a document has no twin of its own, when that is the situation.
   *
   * A macro is ordinary code and ordinary code throws. When one does, the source
   * stands in for its own twin under an identity map, which is the right answer
   * for positions and the wrong one to stay quiet about: the editor is showing a
   * file whose macros did not run. This is what says so.
   */
  failure(uri: string): Unreadable | undefined {
    return this.#twins.failure(fromFileUrl(uri));
  }

  /**
   * One direction of travel, given the two ways a location can be spelled.
   *
   * A location in a file this does not hold is not this layer's to move, so it
   * passes through. Answering nothing there would drop it out of a rename that
   * legitimately reaches into another file.
   */
  #crossing(
    onRange: (mapping: Mapping, range: Range) => Range | undefined,
    onPoint: (mapping: Mapping, at: Position) => Position | undefined,
  ): Crossing {
    return {
      range: (range, uri) => {
        const open = uri === undefined ? undefined : this.#open.get(uri);
        if (open === undefined) return range;
        return onRange(open.mapping, range);
      },
      point: (at, uri) => {
        const open = uri === undefined ? undefined : this.#open.get(uri);
        if (open === undefined) return at;
        return onPoint(open.mapping, at);
      },
    };
  }

  /**
   * Authored coordinates to twin coordinates, for a message going down.
   *
   * Where a range has several images this answers with the first, which is
   * right for a request that only reads and wrong for one that edits. Use
   * `images` for those, and see `server.ts` for which requests are which.
   */
  readonly down: Crossing = this.#crossing(
    (mapping, range) => mapping.toTwinRanges(range)[0],
    (mapping, at) => mapping.toTwin(at)[0],
  );

  /**
   * Twin coordinates back to authored ones, for a message coming up.
   *
   * Nothing is the answer for every position in text a macro invented, and a
   * dropped answer is the right one there: reporting it against whatever sits
   * at the same offset in the source would be an invention.
   */
  readonly up: Crossing = this.#crossing(
    (mapping, range) => mapping.toSourceRanges(range)[0],
    (mapping, at) => mapping.toSource(at),
  );
}
