//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * A macro worker carrying what a real macro actually needs.
 *
 * The trivial worker beside this one imports nothing, so the spawn it measures is
 * the floor rather than the cost. A macro builds TypeScript nodes, which means the
 * compiler is in the isolate with it, and a fresh isolate loads its own copy.
 *
 * The macro itself stays trivial on purpose. What differs from the other worker is
 * the import and nothing else, so the gap between the two is the module load.
 *
 * @module
 */

import ts from "typescript";

self.onmessage = (e: MessageEvent<{ id: number; name: string }>) => {
  const { id, name } = e.data;
  // Touching the compiler, so a bundler or a lazy loader cannot decide the import
  // was unused and quietly delete the thing being measured.
  const node = ts.factory.createIdentifier(`${name}__expanded`);
  self.postMessage({ id, out: node.text });
};
