//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * A macro that tries to hand itself more than it was given.
 *
 * It holds write over one directory and spawns a worker of its own asking for
 * write over everything. Doing it from here rather than from the test is what
 * makes the answer independent of how the suite was invoked: a test process run
 * with blanket permissions has nothing above it to ask for, so the same check
 * written at the top level passes or fails on the command line rather than on
 * the platform.
 *
 * @module
 */

self.onmessage = (
  e: MessageEvent<{ worker: string; path: string; ask?: string[] }>,
) => {
  try {
    const nested = new Worker(e.data.worker, {
      type: "module",
      deno: {
        // `true` is the escalation. A list is the control, and it names no more
        // than this worker already holds.
        permissions: { read: true, env: true, write: e.data.ask ?? true },
      },
    });
    nested.terminate();
    self.postMessage({ escalated: "spawned" });
  } catch (err) {
    self.postMessage({ escalated: `refused: ${(err as Error).name}` });
  }
};
