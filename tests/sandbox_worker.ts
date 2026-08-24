//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The other side of the sandbox test: a macro that misbehaves on purpose.
 *
 * It attempts the thing an enforced macro must not be able to do, and reports
 * which way it went. Reporting rather than throwing is deliberate, because a
 * worker that dies takes its reason with it and the test could not tell a denial
 * apart from a spawn that never happened.
 *
 * @module
 */

self.onmessage = async (e: MessageEvent<{ path: string }>) => {
  try {
    await Deno.writeTextFile(e.data.path, "a macro wrote this");
    self.postMessage({ wrote: true, why: "" });
  } catch (err) {
    self.postMessage({ wrote: false, why: (err as Error).constructor.name });
  }
};
