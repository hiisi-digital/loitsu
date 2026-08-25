//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Running the proxy against a real editor and a real language server.
 *
 * `Server` needs two pipes and knows nothing about where either comes from. That
 * is what makes it testable, and it leaves exactly one thing to do here: turn
 * this process's own standard streams into the editor's pipe, spawn the inner
 * server and turn its standard streams into the other, then let the proxy run
 * until one end goes away.
 *
 * The inner server is `deno lsp` unless told otherwise. It is handed the twin
 * tree's text under the source uri and never learns the source exists, so it
 * needs no configuration and no awareness of any of this.
 *
 * @module
 */

import { Server } from "../src/server.ts";
import type { Channel } from "../src/server.ts";
import type { Project } from "./project.ts";

/** The language server proxied when nothing names another. */
export const INNER: readonly string[] = ["deno", "lsp"];

/** Why a proxy could not start. */
export class LspError extends Error {
  override readonly name = "LspError";
}

/** What `lsp` needs beyond the project. */
export interface LspOptions {
  /** The command to run as the inner server. Defaults to {@link INNER}. */
  readonly inner?: readonly string[];
  /** The editor's end. Defaults to this process's standard streams, and is a
   * seam so a test can drive the proxy without a terminal. */
  readonly editor?: Channel;
  /** The inner server's end. Defaults to spawning {@link inner}, and is the
   * seam that lets a test stand in for a language server that does not exist
   * on the machine running the test. */
  readonly channel?: Channel;
}

/** This process's standard streams, as the editor's end of the wire. */
export function stdio(): Channel {
  return { incoming: Deno.stdin.readable, outgoing: Deno.stdout.writable };
}

/**
 * The inner server, spawned, with its standard streams as a pipe.
 *
 * Its standard error is inherited rather than piped. A language server writes
 * its own diagnostics there, and swallowing them would make a server that fails
 * to start indistinguishable from one that started and said nothing.
 */
export function spawn(command: readonly string[]): {
  channel: Channel;
  process: Deno.ChildProcess;
} {
  const [program, ...args] = command;
  if (program === undefined) {
    throw new LspError("no inner server named, so there is nothing to proxy");
  }
  let process: Deno.ChildProcess;
  try {
    process = new Deno.Command(program, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
  } catch (why) {
    throw new LspError(
      `could not start ${
        command.join(" ")
      }, which is the language server this ` +
        `proxies: ${why instanceof Error ? why.message : String(why)}`,
    );
  }
  return {
    channel: { incoming: process.stdout, outgoing: process.stdin },
    process,
  };
}

/**
 * A view of `incoming` that runs `ended` once nothing more will come out of it.
 *
 * `Server.run` waits on both directions, so an editor that goes away leaves the
 * upward direction waiting on an inner server that is still alive, and the proxy
 * never returns to the place that would have killed it. Noticing the editor's
 * end here is what closes that: the process goes, its output ends, and the
 * upward direction finishes on its own.
 */
function endingWith(
  incoming: ReadableStream<Uint8Array>,
  ended: () => void,
): ReadableStream<Uint8Array> {
  return incoming.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: () => ended(),
      // a cancelled stream is the same news arriving less politely
      cancel: () => ended(),
    }),
  );
}

/**
 * Proxy between the editor and an ordinary language server until one stops.
 *
 * The inner process is killed on the way out rather than left behind. An editor
 * that closes a server it started expects the whole tree to go, and a language
 * server holding a project open is not cheap to leave running.
 */
export async function lsp(
  found: Project,
  options: LspOptions = {},
): Promise<void> {
  const editor = options.editor ?? stdio();

  let inner: Channel;
  let process: Deno.ChildProcess | undefined;
  if (options.channel !== undefined) {
    inner = options.channel;
  } else {
    const started = spawn(options.inner ?? INNER);
    inner = started.channel;
    process = started.process;
  }

  const stop = () => {
    if (process === undefined) return;
    // Kill the group, not the child.
    //
    // A command that is a wrapper leaves a grandchild holding the stdout pipe it
    // inherited, so the stream never ends, the upward direction never finishes,
    // and the proxy waits forever on a server the editor has already left. The
    // spawned process leads its own group, so the negated pid reaches everything
    // it started.
    for (const who of [-process.pid, process.pid]) {
      try {
        Deno.kill(who, "SIGTERM");
        break;
      } catch {
        // no such group, or it is already gone. Fall through to the child, and
        // past that to nothing, which is the ordinary way a proxy ends.
      }
    }
  };

  const server = new Server({
    editor: {
      incoming: endingWith(editor.incoming, stop),
      outgoing: editor.outgoing,
    },
    inner,
    registry: found.registry,
    against: found.against,
    cacheDir: found.cacheDir,
  });

  try {
    await server.run();
  } finally {
    stop();
  }
}
