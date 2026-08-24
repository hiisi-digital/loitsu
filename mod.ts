//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Macros for TypeScript, in the two shapes TypeScript actually admits.
 *
 * An attribute is written `[name(...args)]` above the thing it applies to, and
 * an inline macro is written `name!(...args)` where an expression goes. Both
 * are ordinary TypeScript: they type-check, they survive the formatter, the
 * linter has no opinion about them, and no suppression or compiler patch is
 * involved anywhere. That was the whole search, and the shapes are what
 * survived it.
 *
 * Nothing here is a conditional-compilation library. `cfg` is one attribute
 * macro among whatever else gets written, and it holds no privileged position:
 * its expansion returns the item it was given, or returns nothing.
 *
 * @module
 */

export type {
  AttributeMacro,
  Expansion,
  FunctionMacro,
  Item,
  Macro,
  Registry,
} from "./src/macro.ts";
export { registry } from "./src/macro.ts";

export type {
  AttributeUse,
  ByteOffset,
  CallUse,
  DanglingAttribute,
  Use,
} from "./src/syntax.ts";
export { offsetIn, uses } from "./src/syntax.ts";

export type { Run, Span, SpanTable } from "./src/spans.ts";
export {
  identity,
  outputOffsets,
  outputRuns,
  sourceOffset,
  sourceRuns,
  spanning,
} from "./src/spans.ts";

export type { Found, Marked } from "./src/sentinel.ts";
export { Marker, strip } from "./src/sentinel.ts";
