//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Starting another program, on whichever runtime is running this.
 *
 * The command spawns two things: a type checker, and the language server it
 * proxies. Both used `Deno.Command` directly, which works under deno and is not
 * there anywhere else. The npm build is what said so: dnt's shim carries most of
 * `Deno` and not the process api, so five of its six diagnostics were this one
 * mistake in two files.
 *
 * That is the same class the register module shipped with, one layer down. A
 * package that runs on three runtimes cannot name one of them in the middle of
 * itself, and the place it happens is always somewhere nobody thought of as
 * runtime-specific.
 *
 * So this is the seam. It offers what the two callers actually use and nothing
 * else: run a program to completion and read what it said, or start one and hold
 * its pipes. Anything wider would be a second process api to keep correct.
 *
 * @module
 */

/** What a program printed, and how it ended.
 *
 * Not `Said`: that name belongs to `check.ts`, where it is one thing a check
 * reported about one file, and two types of one name with different shapes is a
 * thing to get wrong later. */
export interface Output {
  readonly code: number;
  readonly out: string;
}

/** A program that is still running, and the pipes to talk to it. */
export interface Running {
  /** Bytes it writes. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Bytes it reads. */
  readonly stdin: WritableStream<Uint8Array>;
  /** Its process id, so a caller can signal the group rather than the child. */
  readonly pid: number;
  /** Stop it, and say nothing if it has already stopped. */
  kill(): void;
}

/** Why a program could not be started. */
export class SpawnError extends Error {
  override readonly name = "SpawnError";
}

/** node's word for a stream this process holds an end of. */
const PIPE = "pipe";
/** The half of the refusal that is the same whichever call could not be made. */
const NEITHER =
  "on this runtime: it offers neither Deno.Command nor node:child_process";

interface HasDeno {
  Deno: {
    Command: new (program: string, options: unknown) => {
      output(): Promise<
        { code: number; stdout: Uint8Array; stderr: Uint8Array }
      >;
      spawn(): {
        stdout: ReadableStream<Uint8Array>;
        stdin: WritableStream<Uint8Array>;
        pid: number;
        kill(signal?: string): void;
      };
    };
    kill(pid: number, signal: string): void;
  };
}

/** As much of node's child process as the two callers here touch. */
interface NodeChild {
  stdout: unknown;
  stdin: unknown;
  stderr: unknown;
  pid?: number;
  kill(signal?: string): boolean;
  on(event: string, handler: (...args: never[]) => void): void;
}

interface HasProcess {
  process: { getBuiltinModule?(name: string): unknown };
}

/**
 * Whether this runtime's `Deno` carries the process api, or only some of `Deno`.
 *
 * Exported because it is the whole decision this file makes, and because dnt's
 * shim is exactly the case that makes it a decision: it defines `Deno` and does
 * not define `Deno.Command`, so asking whether `Deno` exists gets the wrong
 * answer in the one environment this file was written for.
 */
export function hasDenoProcess(
  global: unknown = globalThis,
): boolean {
  const found = (global as Partial<HasDeno>).Deno;
  return found?.Command !== undefined;
}

const deno = (): HasDeno["Deno"] | undefined => {
  // through `unknown`, because under dnt's shim the ambient `Deno` is a
  // narrower type that carries no process api, and asserting one onto the other
  // is exactly the mistake this file exists to route around. What is being asked
  // is whether the running program has `Command`, and that is a runtime question.
  const found = (globalThis as unknown as Partial<HasDeno>).Deno;
  return hasDenoProcess(globalThis) ? found : undefined;
};

/** node's child_process and stream helpers, or nothing where there are none. */
function nodeApis(): {
  child: { spawn(cmd: string, args: string[], opts: unknown): NodeChild };
  streams: {
    Readable: { toWeb(r: unknown): ReadableStream<Uint8Array> };
    Writable: { toWeb(w: unknown): WritableStream<Uint8Array> };
  };
} | undefined {
  const get = (globalThis as Partial<HasProcess>).process?.getBuiltinModule;
  if (get === undefined) return undefined;
  const child = get("node:child_process") as
    | { spawn(cmd: string, args: string[], opts: unknown): NodeChild }
    | undefined;
  const streams = get("node:stream") as {
    Readable: { toWeb(r: unknown): ReadableStream<Uint8Array> };
    Writable: { toWeb(w: unknown): WritableStream<Uint8Array> };
  } | undefined;
  return child && streams ? { child, streams } : undefined;
}

/**
 * Run a program to completion, and give back everything it printed.
 *
 * Both streams together, because the callers want what was said rather than
 * which pipe it came down: a type checker writes its diagnostics to one of them
 * and its summary to the other, and reading only one loses half the answer.
 */
export async function run(
  program: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Output> {
  const d = deno();
  if (d !== undefined) {
    const ran = await new d.Command(program, {
      args: [...args],
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const read = new TextDecoder();
    return {
      code: ran.code,
      out: read.decode(ran.stdout) + read.decode(ran.stderr),
    };
  }

  const apis = nodeApis();
  if (apis === undefined) {
    throw new SpawnError(
      `no way to run ${program} ${NEITHER}`,
    );
  }
  const child = apis.child.spawn(program, [...args], {
    // the parent's environment plus ours, because a type checker reads a good
    // deal of it and handing it only `NO_COLOR` would change what it does
    env: {
      ...((globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env ?? {}),
      ...env,
    },
    stdio: ["ignore", PIPE, PIPE],
  });
  let out = "";
  for (const pipe of [child.stdout, child.stderr]) {
    (pipe as { on(e: string, h: (c: unknown) => void): void })?.on(
      "data",
      (chunk) => {
        out += String(chunk);
      },
    );
  }
  const code = await new Promise<number>((resolve) => {
    child.on("close", ((c: number | null) => resolve(c ?? 0)) as never);
  });
  return { code, out };
}

/**
 * Start a program and hold its pipes.
 *
 * Its standard error is inherited rather than piped. A language server writes
 * its own diagnostics there, and swallowing them makes one that fails to start
 * indistinguishable from one that started and said nothing.
 */
export function start(program: string, args: readonly string[]): Running {
  const d = deno();
  if (d !== undefined) {
    const child = new d.Command(program, {
      args: [...args],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    return {
      stdout: child.stdout,
      stdin: child.stdin,
      pid: child.pid,
      kill: () => {
        // the group, not the child. A command that is a wrapper leaves a
        // grandchild holding the pipe, and the stream never ends.
        for (const who of [-child.pid, child.pid]) {
          try {
            d.kill(who, "SIGTERM");
            return;
          } catch {
            // no such group, or already gone
          }
        }
      },
    };
  }

  const apis = nodeApis();
  if (apis === undefined) {
    throw new SpawnError(
      `no way to start ${program} ${NEITHER}`,
    );
  }
  const child = apis.child.spawn(program, [...args], {
    stdio: [PIPE, PIPE, "inherit"],
  });
  const pid = child.pid ?? 0;
  return {
    stdout: apis.streams.Readable.toWeb(child.stdout),
    stdin: apis.streams.Writable.toWeb(child.stdin),
    pid,
    // The child, and only the child.
    //
    // An earlier version spawned this detached and killed the negated pid, to
    // reach a grandchild a wrapper command leaves behind. Measured, that call
    // returns ESRCH here whether the spawn was detached or not, so it did
    // nothing except look like it did something. A kill that reaches only the
    // child is what this is; pretending otherwise is worse than saying so.
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone, which is the ordinary way a proxy ends
      }
    },
  };
}
