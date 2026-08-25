//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** Starting another program, and the three decisions that were unconstrained.
 *
 * Each of these was a surviving mutation. The seam is only exercised under deno
 * by the rest of the suite, so nothing said which `Deno` counts as one that can
 * spawn, whether the inner server's own diagnostics reach anybody, or whether a
 * kill reaches past the child it started.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { hasDenoProcess, run, start } from "../cli/spawn.ts";

Deno.test("a Deno without the process api does not count as one", () => {
  // dnt's shim is exactly this: it defines `Deno` and not `Deno.Command`, so
  // asking whether `Deno` exists gets the wrong answer in the one environment
  // this decision was written for
  assertEquals(hasDenoProcess({ Deno: { readTextFile: () => {} } }), false);
  assertEquals(hasDenoProcess({}), false);
  assertEquals(hasDenoProcess({ Deno: undefined }), false);

  // the control: the real one does count
  assert(hasDenoProcess(globalThis), "this suite runs under a whole Deno");
  assertEquals(hasDenoProcess({ Deno: { Command: class {} } }), true);
});

Deno.test("running a program gives back both of its streams", async () => {
  const said = await run("sh", ["-c", "echo out; echo err >&2"]);
  assertEquals(said.code, 0);
  assertStringIncludes(said.out, "out");
  assertStringIncludes(
    said.out,
    "err",
    "a checker writes its diagnostics to one pipe and its summary to the other",
  );
});

Deno.test("a program that fails reports the code rather than throwing", async () => {
  const said = await run("sh", ["-c", "exit 7"]);
  assertEquals(said.code, 7);
});

Deno.test("the environment reaches the program", async () => {
  const said = await run("sh", ["-c", "echo $LOITSU_PROBE"], {
    LOITSU_PROBE: "carried",
  });
  assertStringIncludes(said.out, "carried");
});

Deno.test("a started program's stderr reaches ours, rather than being swallowed", async () => {
  // Inherited means it comes out of whatever this process's stderr is, which
  // cannot be seen from inside this process. So the check runs in one of its
  // own: a deno that calls `start` and lets the program write, with its stderr
  // captured here.
  //
  // Piping or nulling it is how a language server that fails to start becomes
  // indistinguishable from one that started and said nothing.
  const here = new URL("../cli/spawn.ts", import.meta.url).href;
  const ran = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const { start } = await import("${here}");
       const r = start("sh", ["-c", "echo noise >&2; sleep 0.2"]);
       await new Promise((d) => setTimeout(d, 500));
       r.kill();`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const read = new TextDecoder();
  const said = read.decode(ran.stdout) + read.decode(ran.stderr);
  assertStringIncludes(
    said,
    "noise",
    "the program's own stderr has to reach the process that started it",
  );
});

Deno.test("a started program says which process it is", () => {
  const running = start("sh", ["-c", "cat"]);
  try {
    assertEquals(typeof running.pid, "number");
    assert(running.pid > 0, "a caller needs the pid to signal the group");
  } finally {
    running.kill();
  }
});

Deno.test("killing reaches past the child, to what it started", async () => {
  // The case: a wrapper command. The child exits and a grandchild keeps the
  // pipe open, so a reader waits forever on a program nobody can see. Killing
  // the group is what closes it.
  const running = start("sh", ["-c", "sleep 30 & wait"]);
  running.kill();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooLong = new Promise<"held">((r) => {
    timer = setTimeout(() => r("held"), 5_000);
  });
  const drained = (async () => {
    for await (const _ of running.stdout) { /* to the end of it */ }
    return "closed" as const;
  })();

  const how = await Promise.race([drained, tooLong]);
  if (timer !== undefined) clearTimeout(timer);
  assertEquals(
    how,
    "closed",
    "a grandchild still held the pipe, so the stream never ended",
  );
});
