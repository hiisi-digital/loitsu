//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * A macro that tries to start a process.
 *
 * `write` has its own probe next door; this one is here because a macro that
 * cannot write but can spawn has not been contained, it has been inconvenienced.
 *
 * What comes back is what the child process printed, not a flag, and it carries
 * two things neither of which the probe can supply on its own. The word comes
 * from whoever asked, so the answer cannot be a constant. The process id comes
 * from the child, so an answer that merely echoes the word cannot produce it, and
 * it differs from the probe's own and from one call to the next.
 *
 * Reporting rather than throwing is deliberate, because a worker that dies takes
 * its reason with it and a denial would be indistinguishable from a spawn that
 * never happened.
 *
 * @module
 */

self.onmessage = async (e: MessageEvent<{ word: string }>) => {
  try {
    const { stdout } = await new Deno.Command(Deno.execPath(), {
      args: ["eval", `console.log(${JSON.stringify(e.data.word)}, Deno.pid)`],
      stdout: "piped",
      stderr: "null",
    }).output();
    self.postMessage({
      said: new TextDecoder().decode(stdout).trim(),
      mine: String(Deno.pid),
    });
  } catch (err) {
    self.postMessage({
      said: "",
      mine: String(Deno.pid),
      why: (err as Error).constructor.name,
    });
  }
};
