//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Whether a worker's permission set is a real boundary.
 *
 * The whole enforced-macro option rests on one platform fact: that denying a
 * worker `write` stops it writing. That is Deno's behaviour rather than loitsu's,
 * which is exactly why it is pinned here. A benchmark timing the boundary says
 * nothing about whether the boundary exists, and a design that assumes it does
 * would be a sandbox in name only.
 *
 * Pinned for the same reason `printer_test.ts` pins the compiler's printer: the
 * design is built on it, nothing in this repository controls it, and a change
 * upstream should fail here rather than in somebody's threat model.
 */
import ts from "typescript";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const WORKER = import.meta.resolve("./sandbox_worker.ts");

/** Runs the misbehaving macro with `write` granted over the given paths, and
 * reports what happened to it. An empty list is the denial.
 *
 * The grant is a list of paths rather than `true` because a worker cannot hold
 * more than the process that spawned it: asking for blanket write under a task
 * that scopes its own gets `NotCapable: Can't escalate parent thread permissions`
 * at the spawn. That bounds the whole enforcement option, since a macro's sandbox
 * can never be wider than whatever the frontend was invoked with. */
function attempt(
  path: string,
  write: readonly string[],
): Promise<{ wrote: boolean; why: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER, {
      type: "module",
      deno: {
        permissions: {
          read: true,
          write: write.length > 0 ? [...write] : false,
        },
      },
    });
    worker.onmessage = (e: MessageEvent<{ wrote: boolean; why: string }>) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.postMessage({ path });
  });
}

Deno.test("a worker denied write cannot write, and one granted it can", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loitsu-sandbox-" });
  try {
    // The control comes first and is the reason the denial below means anything.
    // Without it, a worker that failed to spawn at all, or a path that was never
    // writable on this machine, would report exactly what a working sandbox does.
    const granted = await attempt(`${dir}/granted`, [dir]);
    assertEquals(granted.wrote, true, "the probe can reach the filesystem");
    assertEquals(
      await Deno.readTextFile(`${dir}/granted`),
      "a macro wrote this",
      "and the write actually landed, rather than being reported",
    );

    const denied = await attempt(`${dir}/denied`, []);
    assertEquals(denied.wrote, false, "the denial held");
    assertEquals(
      denied.why,
      "NotCapable",
      "and it held because of the permission, not because the path was bad",
    );
    assertEquals(
      await Deno.stat(`${dir}/denied`).then(() => true).catch(() => false),
      false,
      "nothing was written",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the parent's own grant does not reach the worker", async () => {
  // The test process holds write on the temp directory, and the worker is denied.
  // If a worker inherited the parent's permissions the denial would be decorative,
  // and every arm of the enforcement option would be measuring nothing.
  const dir = await Deno.makeTempDir({ prefix: "loitsu-sandbox-" });
  try {
    await Deno.writeTextFile(`${dir}/parent`, "the parent can write here");
    const denied = await attempt(`${dir}/child`, []);
    assertEquals(denied.wrote, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const READ_WORKER = import.meta.resolve("./sandbox_read_worker.ts");
const ENV_WORKER = import.meta.resolve("./sandbox_env_worker.ts");
const ESCALATE_WORKER = import.meta.resolve("./sandbox_escalate_worker.ts");

/** Spawns a worker under one permission set and reports the first thing that
 * comes back, whether that is a message or the module failing to evaluate.
 *
 * A worker whose module throws never reaches its handler, and the parent hears
 * about it through `onerror` rather than through a rejected spawn. So both have
 * to be raced or a denial at import time looks like a hang. */
function under(
  worker: string,
  permissions: Deno.PermissionOptions,
  message: unknown,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let spawned: Worker;
    try {
      spawned = new Worker(worker, { type: "module", deno: { permissions } });
    } catch (err) {
      resolve({ spawn: `refused: ${(err as Error).constructor.name}` });
      return;
    }
    spawned.onmessage = (e: MessageEvent<Record<string, string>>) => {
      resolve(e.data);
      spawned.terminate();
    };
    spawned.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      resolve({ evaluation: e.message });
      spawned.terminate();
    };
    spawned.postMessage(message);
  });
}

Deno.test("read can be denied, and an isolate without it still builds nodes", async () => {
  // The finding this pins used to say the opposite, that read could not be denied
  // because a worker has to load its own modules. It can. A module URL resolved
  // before the spawn is loaded by the parent, so the isolate never needs read to
  // start, and `typescript` needs none either once it is in.
  //
  // Which matters to the enforcement question directly: read is a permission the
  // sandbox can actually take away, so an enforced macro is not obliged to hold it.
  const dir = await Deno.makeTempDir({ prefix: "loitsu-sandbox-" });
  try {
    await Deno.writeTextFile(`${dir}/secret`, "not for a macro");

    // The probe prints a statement rather than reporting a name, so what comes
    // back is source the compiler emitted. Two different names kill an answer
    // that is a constant, and emitted source kills one that merely echoes what
    // was sent, since producing it takes the printer rather than the shape of it.
    const denied = await under(READ_WORKER, { read: false, env: true }, {
      path: `${dir}/secret`,
      name: "built__ok",
    });
    assertEquals(
      denied.built,
      "const built__ok: number = 1;",
      "the compiler loaded and built a node without read",
    );
    assertEquals(
      denied.read,
      "read refused: NotCapable",
      "and read was denied",
    );

    // The control, and it is what makes the denial above mean something: the same
    // worker granted read over that directory reads the file.
    const granted = await under(READ_WORKER, { read: [dir], env: true }, {
      path: `${dir}/secret`,
      name: "other__name",
    });
    assertEquals(granted.built, "const other__name: number = 1;");
    assertEquals(granted.read, "not for a macro");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env cannot be denied to a macro that imports the compiler", async () => {
  // `typescript` reads environment variables while it is being imported, so the
  // denial does not surface as a refused call inside the macro. The module never
  // finishes evaluating and the failure arrives at the parent's `onerror`, before
  // any message is exchanged.
  //
  // So an enforced macro that builds nodes holds env from the start, and what
  // enforcement can actually take away is write, net, run and ffi. Read too, per
  // the test above.
  const refused = await under(ENV_WORKER, { read: true, env: false }, {});
  assert(
    refused.evaluation !== undefined,
    `expected the module to fail evaluating, got ${JSON.stringify(refused)}`,
  );
  assertStringIncludes(refused.evaluation, "NotCapable");
  // The variable is named, and naming it is the point: env is not denied as a
  // category here, it is one lookup during the compiler's own module evaluation.
  // Granting that one and no more fails at the next, which is why the honest
  // statement is that env cannot be denied rather than that a list would do.
  assertStringIncludes(refused.evaluation, "TSC_WATCHFILE");

  // Granting the one variable it named does not fix it. The reads are a sequence,
  // so evaluation gets one step further and fails at the next name, which is what
  // makes a permission list a list of whatever this compiler version consults.
  const scoped = await under(
    ENV_WORKER,
    { read: true, env: ["TSC_WATCHFILE"] },
    {},
  );
  assert(
    scoped.evaluation !== undefined,
    `expected the scoped grant to fail too, got ${JSON.stringify(scoped)}`,
  );
  assertStringIncludes(scoped.evaluation, "NotCapable");
  assertStringIncludes(scoped.evaluation, "TSC_NONPOLLING_WATCHER");

  // The control: the same worker granted env evaluates and answers.
  const granted = await under(ENV_WORKER, { read: true, env: true }, {});
  assertEquals(granted.built, "built__ok");
});

Deno.test("a worker cannot hold more than the one that spawned it", async () => {
  // The bound on the whole enforcement option, and the reason every grant above is
  // a list of paths rather than `true`. A macro cannot widen its own sandbox, so
  // whatever the frontend was invoked with is the ceiling for everything under it.
  //
  // The escalation is attempted one level down rather than from here. A test
  // process holding blanket permissions has nothing above it to ask for, so the
  // same check written at this level would pass or fail on the command line that
  // started the suite rather than on the platform, and under `-A` it asserted
  // nothing at all.
  const dir = await Deno.makeTempDir({ prefix: "loitsu-sandbox-" });
  try {
    const middle = await under(
      ESCALATE_WORKER,
      { read: true, env: true, write: [dir] },
      { worker: READ_WORKER, path: dir },
    );
    assertEquals(
      middle.escalated,
      "refused: NotCapable",
      "a worker holding write over one directory cannot spawn one holding all of it",
    );

    // The control: the same nested spawn asking for no more than the middle holds
    // goes through, so the refusal above is the escalation and not the nesting.
    const within = await under(
      ESCALATE_WORKER,
      { read: true, env: true, write: [dir] },
      { worker: READ_WORKER, path: dir, ask: [dir] },
    );
    assertEquals(within.escalated, "spawned");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
