//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** Reaching another runtime from a test.
 *
 * Two suites spawn node and bun: one against the source, one against the built
 * npm package. They ask the same two things of a machine, so they ask them here.
 *
 * @module
 */

import type { Output } from "../cli/spawn.ts";

/** Whether a command is on this machine at all.
 *
 * A runtime that is not installed is skipped rather than failed: the absence of
 * bun on somebody's laptop is not a defect in this package. */
export async function have(program: string): Promise<boolean> {
  try {
    const ran = await new Deno.Command(program, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return ran.success;
  } catch {
    return false;
  }
}

/** Run a program in a directory and give back everything it said.
 *
 * Both streams together. A runtime writes its refusals to one of them and its
 * output to the other, and reading one loses half of what went wrong. */
export async function inRuntime(
  program: string,
  args: readonly string[],
  cwd: string,
): Promise<Output> {
  const done = await new Deno.Command(program, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const read = new TextDecoder();
  return {
    code: done.code,
    out: read.decode(done.stdout) + read.decode(done.stderr),
  };
}
