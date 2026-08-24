//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Whether the mutation harness refuses to run beside itself.
 *
 * A mutation is a real edit to a real file for as long as one suite runs against
 * it. Two runs at once means one of them measures the other's mutant, and the
 * failures that come out belong to nothing. That is not hypothetical: a sweep and
 * an ordinary suite run overlapping produced two failures in the watcher that
 * neither the watcher nor its tests had anything to do with.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const DEFAULT_LOCK = join(ROOT, ".mutate.lock");

/** Runs the harness on the smallest plan there is and reports how it went.
 *
 * The lock is moved out of the repository for the runs that need to place one, so
 * the suite's own write permission stays scoped to the temporary directories. The
 * default path is checked separately, below. */
async function sweep(lock?: string): Promise<{ code: number; err: string }> {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "tools/mutate.ts",
      "tests/sandbox_worker.ts",
      "tests/sandbox_test.ts",
    ],
    cwd: ROOT,
    env: lock === undefined ? {} : { MUTATE_LOCK: lock },
    stdout: "null",
    stderr: "piped",
  }).output();
  return { code, err: new TextDecoder().decode(stderr) };
}

/** Whether a path is there right now. */
const there = (path: string): Promise<boolean> =>
  Deno.stat(path).then(() => true).catch(() => false);

Deno.test("a run refuses to start while another holds the lock", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loitsu-mutate-" });
  const lock = join(dir, "held");
  try {
    await Deno.writeTextFile(lock, "1\n", { createNew: true });
    const held = await sweep(lock);
    assertEquals(held.code, 3, `refused with its own exit code:\n${held.err}`);
    assertStringIncludes(held.err, "is held");
    assert(
      await there(lock),
      "and the refusal left the lock where it found it",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a run that finishes leaves no lock behind", async () => {
  // The control. Without it the refusal above would pass just as well against a
  // harness that never releases, which would break every later run.
  const dir = await Deno.makeTempDir({ prefix: "loitsu-mutate-" });
  const lock = join(dir, "taken");
  try {
    const done = await sweep(lock);
    assertEquals(done.code, 0, done.err);
    assertEquals(
      await there(lock),
      false,
      "the lock is gone once the run is over",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the lock lives beside the tree it protects when nothing moves it", async () => {
  // The default is what every real run uses, and the two tests above deliberately
  // move it. So the default itself is checked here, both that the harness names it
  // and that a run under it puts nothing permanent in the repository.
  const source = await Deno.readTextFile(join(ROOT, "tools", "mutate.ts"));
  assertStringIncludes(source, 'Deno.env.get("MUTATE_LOCK") ?? ".mutate.lock"');
  assertEquals(
    await there(DEFAULT_LOCK),
    false,
    "no run left one behind in the repository",
  );
});
