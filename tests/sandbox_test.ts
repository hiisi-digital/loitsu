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
import { assertEquals } from "@std/assert";

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
