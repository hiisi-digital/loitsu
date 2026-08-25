//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * A macro that imports the compiler, in an isolate that may or may not hold env.
 *
 * `typescript` reads environment variables while it is being imported, so the
 * question this answers is whether the import survives the denial, and it has to
 * be answered by an import at module scope rather than inside the handler.
 *
 * @module
 */

import ts from "typescript";

self.onmessage = () => {
  self.postMessage({ built: ts.factory.createIdentifier("built__ok").text });
};
