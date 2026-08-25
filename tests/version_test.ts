//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** The version the tool reports, against the version it is published under.
 *
 * `src/version.ts` says this test enforces the two agreeing. It did not exist,
 * which is the failure `a-claim-of-totality-names-what-enforces-it.md` describes:
 * a sentence naming a mechanism, and no mechanism. Two places holding one number
 * drift, and the one that drifts is the one nobody reads, which is the constant
 * rather than the manifest.
 *
 * @module
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { VERSION } from "../src/version.ts";

/** What the manifest says this package is. */
async function published(): Promise<string> {
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { version?: unknown };
  assertEquals(
    typeof manifest.version,
    "string",
    "the manifest has to carry one",
  );
  return manifest.version as string;
}

Deno.test("the reported version is the published one", async () => {
  assertEquals(VERSION, await published());
});

Deno.test("it is a version rather than whatever somebody typed", () => {
  // the control on the check above: two fields agreeing on nonsense is still
  // two fields agreeing
  assertMatch(VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

Deno.test("the manifest names the export the version is read from", async () => {
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { exports?: Record<string, string> };
  const named = Object.values(manifest.exports ?? {});
  assert(named.length > 0, "a package with no exports publishes nothing");
  for (const one of named) {
    const at = new URL(`../${one.replace(/^\.\//, "")}`, import.meta.url);
    await Deno.stat(at);
  }
});
