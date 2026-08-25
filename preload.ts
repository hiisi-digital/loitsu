//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The module a runtime is pointed at, which does its work on being imported.
 *
 * Separate from `register.ts` because the two things want opposite behaviour. A
 * preload is imported and never called, so it has to act on import. Anything
 * importing `register` or `rootFrom` to use them wants no such thing, and got it
 * anyway: a walk to the filesystem root and a line of stderr, on every import,
 * including from the test suite.
 *
 * ```bash
 * node --import loitsu/preload app.js
 * bun --preload loitsu/preload app.ts
 * ```
 *
 * A hook reaches what is loaded after it, so the program comes after this on the
 * command line, or is reached through a dynamic import.
 *
 * @module
 */

import { register } from "./register.ts";

await register().catch((why: unknown) => {
  // Loud, and it keeps going. A preload that threw would take down a program
  // that may not need macros at all, and one that said nothing would leave the
  // author looking at a syntax error in a file whose macros were never expanded.
  console.error(
    `loitsu: not installed: ${
      why instanceof Error ? why.message : String(why)
    }`,
  );
});
