//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The version, as a value the code can read.
 *
 * `deno.json` is the one that matters and this has to agree with it. Importing
 * the manifest would make them agree by construction and would also put a json
 * import in the module graph, which the npm build has to strip and a consumer
 * resolving this from a registry has no copy of. So it is written twice, and
 * `tests/version_test.ts` fails when the two disagree.
 *
 * @module
 */

/** What this build of loitsu calls itself. */
export const VERSION = "0.2.0";
