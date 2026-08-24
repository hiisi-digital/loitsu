//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The macro every suite that needs a twin to differ from its source reaches for.
 *
 * Shared rather than repeated because two identical helpers are one helper
 * written twice, and because a fixture built two ways is a fixture two suites can
 * silently disagree about.
 *
 * @module
 */

import ts from "typescript";
import { registry } from "../src/macro.ts";

/** The name of an identifier argument, and nothing for anything else. */
export const named = (e: ts.Expression): string =>
  ts.isIdentifier(e) ? e.text : "";

/**
 * `cfg`, keeping its item only for `deno`.
 *
 * Enough that a twin differs from its source, which is what the assertions
 * built on it turn on.
 */
export function macros(): ReturnType<typeof registry> {
  return registry([{
    kind: "attribute",
    name: "cfg",
    expand: (args: readonly ts.Expression[], item: { node: ts.Statement }) =>
      named(args[0]!) === "deno" ? [item.node] : [],
    // deno-lint-ignore no-explicit-any
  } as any]);
}

/**
 * `twice`, keeping its item and emitting it a second time.
 *
 * One authored statement becomes two in the twin, so every name in it has two
 * images. That is the shape a rename has to fan out over, and it needs a macro
 * that multiplies rather than one that only drops.
 */
export function doubling(): ReturnType<typeof registry> {
  return registry([{
    kind: "attribute",
    name: "twice",
    expand: (_args: readonly ts.Expression[], item: { node: ts.Statement }) => [
      item.node,
      item.node,
    ],
    // deno-lint-ignore no-explicit-any
  } as any]);
}
