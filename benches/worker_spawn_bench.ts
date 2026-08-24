//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * What it costs to run a macro somewhere it cannot reach the machine.
 *
 * The question this exists to answer: does loitsu enforce a macro's sandbox, or
 * does it trust macros the way Rust trusts a proc macro? Rust trusts, and a proc
 * macro can read a file, open a socket, or delete a directory. Doing better needs
 * an isolate per run, and an isolate has a price nobody here has measured.
 *
 * So the price is what is measured, and it is measured against real alternatives
 * rather than against a strawman:
 *
 * - **trusted**, an ordinary call, which is what Rust does and what `expand` does
 *   today. The floor, and the arm every other one has to justify itself against.
 * - **worker per expansion**, spawned and terminated around each file. Full
 *   isolation and nothing carries between files.
 * - **pooled worker**, spawned once and reused. Isolation from the host, but one
 *   macro's leftovers are visible to the next file through the isolate it shares.
 * - **pooled worker, four of them**, because a watcher regenerating twins has many
 *   files and no reason to do them one at a time.
 *
 * The answer wanted is not a winner. It is where each one applies: a per-file
 * spawn may be affordable for a single edit and ruinous for a cold pass over a
 * repository, and the two are different regions rather than a contest.
 *
 * Run: `deno bench --allow-read benches/worker_spawn_bench.ts`
 *
 * @module
 */

const WORKER = import.meta.resolve("./macro_worker.ts");
/** The same worker carrying what a real macro needs, which is the compiler. The
 * gap between the two spawn arms is the module load and nothing else. */
const WORKER_REAL = import.meta.resolve("./macro_worker_real.ts");

/** How many macro invocations one file is taken to have. Not a guess to be
 * defended: the arms are reported per file at several of these, because the
 * per-file spawn is amortised over exactly this number and a single value would
 * hide the whole shape. */
const PER_FILE = [1, 8, 64] as const;

interface Pending {
  resolve: (out: string) => void;
}

/** One worker plus the bookkeeping to have several requests in flight on it. */
function open(
  url: string = WORKER,
): {
  worker: Worker;
  ask: (name: string) => Promise<string>;
  terminate: () => void;
} {
  // The permissions are the enforcement, and they are stated rather than
  // inherited. Env has to be granted: `typescript` reads `TSC_WATCHFILE` while it
  // is being imported and the isolate fails outright without it. Read is granted
  // here so the arms measure the same isolate a real expansion would run in, not
  // because it is forced; `tests/sandbox_test.ts` shows an isolate denied read
  // still loading the compiler and printing through it. Write, net, run and ffi
  // are denied, which is the part that makes this different from trusting a macro.
  const worker = new Worker(url, {
    type: "module",
    deno: {
      permissions: {
        read: true,
        env: true,
        write: false,
        net: false,
        run: false,
        ffi: false,
        sys: false,
      },
    },
  });
  const waiting = new Map<number, Pending>();
  let next = 0;
  worker.onmessage = (e: MessageEvent<{ id: number; out: string }>) => {
    waiting.get(e.data.id)?.resolve(e.data.out);
    waiting.delete(e.data.id);
  };
  return {
    worker,
    ask: (name: string) =>
      new Promise<string>((resolve) => {
        const id = next++;
        waiting.set(id, { resolve });
        worker.postMessage({ id, name });
      }),
    /** Named for what it is. `terminate` returns as soon as it has asked, and the
     * isolate is torn down after that, so an arm that terminates in a loop has
     * teardowns overlapping its own next spawn. That inflates the per-expansion
     * arm in particular, and there is no synchronous way to wait it out. */
    terminate: () => worker.terminate(),
  };
}

/** The trusted arm's macro. The same work every other arm sends across a
 * boundary, so the difference between arms is the boundary and nothing else. */
const inProcess = (name: string): string => `${name}__expanded`;

for (const n of PER_FILE) {
  const names = Array.from({ length: n }, (_, i) => `m${i}`);
  const group = `${n} macro${n === 1 ? "" : "s"} in one file`;

  Deno.bench({
    name: "trusted, an ordinary call",
    group,
    baseline: true,
    fn: () => {
      for (const name of names) inProcess(name);
    },
  });

  Deno.bench({
    name: "worker per expansion",
    group,
    fn: async () => {
      // One isolate per macro. The strictest thing available and the most
      // expensive; included because it is the shape somebody reaches for first.
      for (const name of names) {
        const w = open();
        await w.ask(name);
        w.terminate();
      }
    },
  });

  Deno.bench({
    name: "worker per file",
    group,
    fn: async () => {
      // One isolate for the file, every macro in it sharing that isolate. Two
      // macros in one file can see each other's leftovers; two files cannot.
      const w = open();
      await Promise.all(names.map((name) => w.ask(name)));
      w.terminate();
    },
  });

  Deno.bench({
    name: "worker per file, carrying the compiler",
    group,
    fn: async () => {
      // What a spawn actually costs once the isolate holds what a macro needs to
      // build a node. The arm above it is the floor; this one is the price.
      const w = open(WORKER_REAL);
      await Promise.all(names.map((name) => w.ask(name)));
      w.terminate();
    },
  });

  Deno.bench({
    name: "pooled worker, spawned once",
    group,
    fn: async () => {
      // The spawn is not counted here, which is the point: it is what a watcher
      // holding a warm pool actually pays per file after the first one.
      await Promise.all(names.map((name) => pooled.ask(name)));
    },
  });

  Deno.bench({
    name: "pool of four, spawned once",
    group,
    fn: async () => {
      await Promise.all(
        names.map((name, i) => pool[i % pool.length]!.ask(name)),
      );
    },
  });
}

// Spawned at module load so the spawn is outside every measurement that uses
// them. A pooled arm that paid for its own spawn would be measuring the arm above
// it, and the two would be indistinguishable.
const pooled = open();
const pool = [open(), open(), open(), open()];

globalThis.addEventListener("unload", () => {
  pooled.terminate();
  for (const w of pool) w.terminate();
});
