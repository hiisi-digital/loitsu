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
  CallUse,
  DanglingAttribute,
  Offset,
  Use,
} from "./src/syntax.ts";
export type { Dialect } from "./src/syntax.ts";
export { dialectOf, interesting, offsetIn, uses } from "./src/syntax.ts";

export type { Run, Span, SpanTable } from "./src/spans.ts";
export {
  compose,
  identity,
  outputOffsets,
  outputRuns,
  sourceOffset,
  sourceRuns,
  spanning,
} from "./src/spans.ts";

export type { Found, Marked } from "./src/sentinel.ts";
export { Marker, strip } from "./src/sentinel.ts";

export type { Diagnostic, Expanded, ExpandOptions } from "./src/expand.ts";
export { expand, ROUNDS } from "./src/expand.ts";

export type { Encoding, Position, Range } from "./src/position.ts";
export { DEFAULT_ENCODING, Lines, negotiate } from "./src/position.ts";

export type {
  Location,
  Pair,
  ProtocolDiagnostic,
  Related,
  Renamed,
  TextEdit,
} from "./src/translate.ts";
export {
  Mapping,
  renameEdits,
  toSourceDiagnostic,
  toSourceDiagnostics,
} from "./src/translate.ts";

export type { Crossing } from "./src/protocol.ts";
export { crossed, DROPPED, isPosition, isRange } from "./src/protocol.ts";

export type { Message } from "./src/rpc.ts";
export { frame, Frames, FramingError, messages } from "./src/rpc.ts";

export type { Cached } from "./src/cache.ts";
export {
  cached,
  cacheHome,
  defaultHome,
  keyOf,
  VERSION as CACHE_VERSION,
} from "./src/cache.ts";

export type {
  Reader,
  Rebuilt,
  Twin,
  TwinsOptions,
  Unreadable,
  WatchOptions,
} from "./src/watch.ts";
export { Twins, watch } from "./src/watch.ts";

export type { DocumentsOptions, Open } from "./src/documents.ts";
export { Documents } from "./src/documents.ts";

export type { Channel, ServerOptions } from "./src/server.ts";
export { Server } from "./src/server.ts";

export type {
  BunBuilder,
  BunPlugin,
  Host,
  Installed,
  InstallOptions,
  NodeHooks,
  NodeLoaded,
  Rewrite,
} from "./src/install.ts";
export { bunPlugin, install, nodeHook } from "./src/install.ts";
