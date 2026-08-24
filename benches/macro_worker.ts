//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * The other side of a macro run in a worker, for the arms that use one.
 *
 * Deliberately trivial. What is being priced is the boundary, so the work inside
 * has to be the same in every arm and small enough that it is not what is being
 * measured. A macro that actually did something would move every arm by the same
 * amount and tell us nothing about the boundary.
 *
 * @module
 */

self.onmessage = (e: MessageEvent<{ id: number; name: string }>) => {
  const { id, name } = e.data;
  self.postMessage({ id, out: `${name}__expanded` });
};
