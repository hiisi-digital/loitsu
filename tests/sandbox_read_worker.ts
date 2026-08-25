//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * A macro that builds a node and then reads a file it has no business reading.
 *
 * Two things have to be told apart and one report cannot do it: whether an
 * isolate denied `read` can construct TypeScript nodes at all, and whether it
 * can still reach the filesystem afterwards. So both are reported.
 *
 * @module
 */

import ts from "typescript";

self.onmessage = async (e: MessageEvent<{ path: string; name: string }>) => {
  // The name comes in the message rather than being written here, so that what
  // comes back depends on the compiler having actually run. A probe returning a
  // constant reports the same thing whether or not it built anything.
  let built = "";
  try {
    // Printed rather than reported, because a name handed back is a name handed
    // back and says nothing about what produced it. Emitting source means the
    // compiler's own printer ran in this isolate, which is the thing being
    // claimed, and it is not something an object of the right shape can fake.
    const node = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [ts.factory.createVariableDeclaration(
          e.data.name,
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          ts.factory.createNumericLiteral(1),
        )],
        ts.NodeFlags.Const,
      ),
    );
    built = ts.createPrinter().printNode(
      ts.EmitHint.Unspecified,
      node,
      ts.createSourceFile("p.ts", "", ts.ScriptTarget.Latest),
    );
  } catch (err) {
    built = `build refused: ${(err as Error).constructor.name}`;
  }
  let read = "";
  try {
    read = (await Deno.readTextFile(e.data.path)).trim();
  } catch (err) {
    read = `read refused: ${(err as Error).constructor.name}`;
  }
  self.postMessage({ built, read });
};
