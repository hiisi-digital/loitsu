//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import type { Position, Range } from "../src/position.ts";
import {
  crossed,
  type Crossing,
  DROPPED,
  isPosition,
  isRange,
} from "../src/protocol.ts";

const at = (line: number, character: number): Position => ({ line, character });
const span = (a: Position, b: Position): Range => ({ start: a, end: b });

/** What each crossing was asked, so a test can tell a range from two points. */
interface Asked {
  readonly ranges: { range: Range; uri: string | undefined }[];
  readonly points: { at: Position; uri: string | undefined }[];
}

/** Moves everything down one line, and refuses whatever `no` says it refuses. */
function shifting(no: (uri: string | undefined) => boolean = () => false): {
  crossing: Crossing;
  asked: Asked;
} {
  const asked: Asked = { ranges: [], points: [] };
  const crossing: Crossing = {
    range(range, uri) {
      asked.ranges.push({ range, uri });
      if (no(uri)) return undefined;
      return span(
        at(range.start.line + 1, range.start.character),
        at(range.end.line + 1, range.end.character),
      );
    },
    point(where, uri) {
      asked.points.push({ at: where, uri });
      if (no(uri)) return undefined;
      return at(where.line + 1, where.character);
    },
  };
  return { crossing, asked };
}

Deno.test("recognising the two shapes", async (t) => {
  await t.step("a position is two numbers under the two names", () => {
    assert(isPosition(at(0, 0)));
    assert(isPosition({ line: 3, character: 9, extra: true }));
  });

  await t.step("anything else is not a position", () => {
    for (
      const value of [
        null,
        undefined,
        3,
        "0:0",
        [0, 0],
        { line: 1 },
        { character: 1 },
        { line: "1", character: 1 },
        { line: 1, character: "1" },
      ]
    ) {
      assert(!isPosition(value), `${JSON.stringify(value)} read as a position`);
    }
  });

  await t.step("a range is two positions under start and end", () => {
    assert(isRange(span(at(0, 0), at(0, 4))));
  });

  await t.step("two numbers under start and end are not a range", () => {
    // The control that the check reaches into the ends rather than stopping at
    // the two names. Offsets are written that way all over this codebase.
    assert(!isRange({ start: 0, end: 4 }));
    assert(!isRange({ start: at(0, 0), end: 4 }));
    assert(!isRange({ start: at(0, 0) }));
    assert(!isRange([at(0, 0), at(0, 4)]));
  });
});

Deno.test("walking a message", async (t) => {
  await t.step("a value with nothing to cross comes back as it was", () => {
    const { crossing, asked } = shifting();
    const message = { jsonrpc: "2.0", id: 1, method: "shutdown", params: null };
    assertEquals(crossed(message, crossing), message);
    assertEquals(asked.ranges.length, 0);
    assertEquals(asked.points.length, 0);
  });

  await t.step("a range is asked about whole, never as two positions", () => {
    // The one that matters most. Crossing the ends separately would ask the
    // span table about two points where it can answer about a run, and the
    // difference shows up exactly where a macro rewrote the text between them.
    const { crossing, asked } = shifting();
    const out = crossed({ range: span(at(2, 0), at(2, 5)) }, crossing);
    assertEquals(out, { range: span(at(3, 0), at(3, 5)) });
    assertEquals(asked.ranges.length, 1);
    assertEquals(asked.points.length, 0);
  });

  await t.step("a position outside a range is asked about as a point", () => {
    const { crossing, asked } = shifting();
    const out = crossed({ position: at(4, 2) }, crossing);
    assertEquals(out, { position: at(5, 2) });
    assertEquals(asked.points.length, 1);
    assertEquals(asked.ranges.length, 0);
  });

  await t.step("positions in a list are each asked about", () => {
    const { crossing, asked } = shifting();
    const out = crossed({ positions: [at(0, 1), at(1, 1)] }, crossing);
    assertEquals(out, { positions: [at(1, 1), at(2, 1)] });
    assertEquals(asked.points.length, 2);
  });

  await t.step(
    "a position that does not cross takes its object with it",
    () => {
      // The point half of the drop, which the range half does not cover: a
      // request arriving at an authored position the expansion deleted has no
      // twin position to be asked at, and asking at whatever sits on the same
      // offset would answer about somebody else's code.
      const { crossing } = shifting(() => true);
      assertEquals(
        crossed(
          { textDocument: { uri: "file:///a.ts" }, position: at(3, 1) },
          crossing,
        ),
        DROPPED,
      );
    },
  );

  await t.step("a range that does not cross takes its object with it", () => {
    const { crossing } = shifting(() => true);
    assertEquals(
      crossed(
        { contents: "a type", range: span(at(0, 0), at(0, 1)) },
        crossing,
      ),
      DROPPED,
    );
  });

  await t.step(
    "an array loses the elements that dropped and keeps the rest",
    () => {
      const { crossing } = shifting((uri) => uri === "file:///gone.ts");
      const out = crossed({
        locations: [
          { uri: "file:///here.ts", range: span(at(0, 0), at(0, 1)) },
          { uri: "file:///gone.ts", range: span(at(0, 0), at(0, 1)) },
          { uri: "file:///here.ts", range: span(at(5, 0), at(5, 1)) },
        ],
      }, crossing);
      assertEquals(out, {
        locations: [
          { uri: "file:///here.ts", range: span(at(1, 0), at(1, 1)) },
          { uri: "file:///here.ts", range: span(at(6, 0), at(6, 1)) },
        ],
      });
    },
  );

  await t.step(
    "dropping climbs out of nested objects until an array stops it",
    () => {
      const { crossing } = shifting((uri) => uri === "file:///gone.ts");
      const out = crossed({
        items: [
          {
            label: "kept",
            edit: {
              inner: {
                uri: "file:///here.ts",
                range: span(at(0, 0), at(0, 1)),
              },
            },
          },
          {
            label: "lost",
            edit: {
              inner: {
                uri: "file:///gone.ts",
                range: span(at(0, 0), at(0, 1)),
              },
            },
          },
        ],
      }, crossing) as { items: { label: string }[] };
      assertEquals(out.items.map((one) => one.label), ["kept"]);
    },
  );

  await t.step("a whole message drops when nothing above it is a list", () => {
    const { crossing } = shifting(() => true);
    assertEquals(
      crossed({ a: { b: { c: span(at(0, 0), at(0, 1)) } } }, crossing),
      DROPPED,
    );
  });
});

Deno.test("which document a range belongs to", async (t) => {
  await t.step("the ambient uri reaches a range that names none", () => {
    const { crossing, asked } = shifting();
    crossed(
      { diagnostics: [{ range: span(at(0, 0), at(0, 1)) }] },
      crossing,
      "file:///a.ts",
    );
    assertEquals(asked.ranges.map((one) => one.uri), ["file:///a.ts"]);
  });

  await t.step("nothing naming a document leaves the uri undefined", () => {
    const { crossing, asked } = shifting();
    crossed({ range: span(at(0, 0), at(0, 1)) }, crossing);
    assertEquals(asked.ranges[0]!.uri, undefined);
  });

  await t.step(
    "a uri inside replaces the one outside for its own subtree",
    () => {
      const { crossing, asked } = shifting();
      crossed(
        {
          range: span(at(0, 0), at(0, 1)),
          related: [{
            location: { uri: "file:///b.ts", range: span(at(1, 0), at(1, 1)) },
          }],
        },
        crossing,
        "file:///a.ts",
      );
      assertEquals(asked.ranges.map((one) => one.uri), [
        "file:///a.ts",
        "file:///b.ts",
      ]);
    },
  );

  await t.step("changes keys name the document their edits touch", () => {
    const { crossing, asked } = shifting();
    crossed(
      {
        changes: {
          "file:///a.ts": [{ range: span(at(0, 0), at(0, 3)), newText: "x" }],
          "file:///b.ts": [{ range: span(at(9, 0), at(9, 3)), newText: "x" }],
        },
      },
      crossing,
      "file:///ambient.ts",
    );
    assertEquals(asked.ranges.map((one) => one.uri), [
      "file:///a.ts",
      "file:///b.ts",
    ]);
  });

  await t.step("a file whose every edit dropped leaves no entry at all", () => {
    // An empty array here is an instruction to open a file and change nothing,
    // which some editors take literally and mark dirty.
    const { crossing } = shifting((uri) => uri === "file:///gone.ts");
    const out = crossed({
      changes: {
        "file:///here.ts": [{ range: span(at(0, 0), at(0, 3)), newText: "x" }],
        "file:///gone.ts": [{ range: span(at(0, 0), at(0, 3)), newText: "x" }],
      },
    }, crossing) as { changes: Record<string, unknown> };
    assertEquals(Object.keys(out.changes), ["file:///here.ts"]);
  });

  await t.step("an empty edit list leaves no entry either", () => {
    const { crossing } = shifting();
    const out = crossed({ changes: { "file:///a.ts": [] } }, crossing) as {
      changes: Record<string, unknown>;
    };
    assertEquals(Object.keys(out.changes), []);
  });

  await t.step(
    "a changes field whose values are not edit lists is walked normally",
    () => {
      // The name alone does not make a workspace edit; every value has to be a
      // list of edits, which is also what makes the by-document pass total.
      const { crossing, asked } = shifting();
      crossed(
        { changes: { "file:///a.ts": { range: span(at(0, 0), at(0, 1)) } } },
        crossing,
        "file:///ambient.ts",
      );
      assertEquals(asked.ranges.map((one) => one.uri), ["file:///ambient.ts"]);
    },
  );

  await t.step(
    "a changes field that is not a map of edits is walked normally",
    () => {
      // The control for special-casing the name. Nothing should turn on a key
      // being called `changes` when its value is not shaped like the one place
      // the protocol writes documents as keys.
      const { crossing, asked } = shifting();
      crossed(
        { changes: [{ range: span(at(0, 0), at(0, 1)) }] },
        crossing,
        "file:///a.ts",
      );
      assertEquals(asked.ranges.map((one) => one.uri), ["file:///a.ts"]);
    },
  );
});

Deno.test("what the walk cannot see", async (t) => {
  // These are pinned because they are gaps rather than because they are right.
  // A test going red here means somebody taught the walk one of them, which is
  // the moment to take it out of the module's own list of what it misses.
  await t.step("a fold marker's line numbers pass through untouched", () => {
    const { crossing, asked } = shifting();
    const fold = { startLine: 4, endLine: 9, kind: "region" };
    assertEquals(crossed(fold, crossing), fold);
    assertEquals(asked.points.length, 0);
  });

  await t.step("semantic tokens pass through untouched", () => {
    const { crossing, asked } = shifting();
    const tokens = { resultId: "1", data: [0, 5, 3, 0, 0, 1, 2, 4, 1, 0] };
    assertEquals(crossed(tokens, crossing), tokens);
    assertEquals(asked.points.length, 0);
  });

  await t.step("a position written into prose stays as it was", () => {
    const { crossing } = shifting();
    const out = crossed({
      message: "see line 12",
      range: span(at(11, 0), at(11, 4)),
    }, crossing);
    assertEquals(out, {
      message: "see line 12",
      range: span(at(12, 0), at(12, 4)),
    });
  });
});

Deno.test("the walk leaves its input alone", async (t) => {
  await t.step("the value handed in is not the value handed back", () => {
    const { crossing } = shifting();
    const before = { range: span(at(0, 0), at(0, 1)) };
    const snapshot = structuredClone(before);
    const after = crossed(before, crossing);
    assertEquals(before, snapshot);
    assertNotStrictEquals(after, before);
  });
});

Deno.test("whole messages", async (t) => {
  await t.step(
    "a diagnostics notification loses the ones with no image",
    () => {
      // The crossing refuses line 1 and nothing else, which is what a range
      // sitting entirely in text a macro invented looks like.
      const asked: Range[] = [];
      const crossing: Crossing = {
        range(range) {
          asked.push(range);
          return range.start.line === 1 ? undefined : range;
        },
        point: (where) => where,
      };
      const out = crossed({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///a.ts",
          diagnostics: [
            { range: span(at(0, 0), at(0, 5)), message: "kept", severity: 1 },
            {
              range: span(at(1, 0), at(1, 5)),
              message: "invented",
              severity: 2,
            },
          ],
        },
      }, crossing);
      assertEquals(out, {
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///a.ts",
          diagnostics: [
            { range: span(at(0, 0), at(0, 5)), message: "kept", severity: 1 },
          ],
        },
      });
      assertEquals(asked.length, 2, "both should have been asked about");
    },
  );

  await t.step(
    "a note pointing at another file survives its diagnostic",
    () => {
      // A crossing holding no twin for a document hands the range back unchanged
      // rather than refusing it, so a note about another file is not a reason to
      // lose the diagnostic it hangs off.
      const { crossing } = shifting((uri) => uri === undefined);
      const out = crossed({
        params: {
          uri: "file:///a.ts",
          diagnostics: [{
            range: span(at(0, 0), at(0, 5)),
            message: "here",
            relatedInformation: [{
              location: {
                uri: "file:///b.ts",
                range: span(at(4, 0), at(4, 1)),
              },
              message: "and there",
            }],
          }],
        },
      }, crossing) as {
        params: { diagnostics: { relatedInformation: unknown[] }[] };
      };
      assertEquals(out.params.diagnostics.length, 1);
      assertEquals(out.params.diagnostics[0]!.relatedInformation, [{
        location: { uri: "file:///b.ts", range: span(at(5, 0), at(5, 1)) },
        message: "and there",
      }]);
    },
  );

  await t.step("a rename answer crosses every file it touches", () => {
    const { crossing } = shifting();
    const out = crossed({
      id: 4,
      result: {
        changes: {
          "file:///a.ts": [
            { range: span(at(0, 9), at(0, 14)), newText: "tervehdi" },
            { range: span(at(7, 2), at(7, 7)), newText: "tervehdi" },
          ],
          "file:///b.ts": [{
            range: span(at(3, 0), at(3, 5)),
            newText: "tervehdi",
          }],
        },
      },
    }, crossing);
    assertEquals(out, {
      id: 4,
      result: {
        changes: {
          "file:///a.ts": [
            { range: span(at(1, 9), at(1, 14)), newText: "tervehdi" },
            { range: span(at(8, 2), at(8, 7)), newText: "tervehdi" },
          ],
          "file:///b.ts": [{
            range: span(at(4, 0), at(4, 5)),
            newText: "tervehdi",
          }],
        },
      },
    });
  });
});
