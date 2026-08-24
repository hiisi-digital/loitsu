//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** Positions, against the protocol's own worked examples where it gives them and
 * against TypeScript's own line table where it does not. */
import ts from "typescript";
import { assertEquals, assertNotEquals } from "@std/assert";
import {
  DEFAULT_ENCODING,
  type Encoding,
  Lines,
  negotiate,
  type Position,
} from "../src/position.ts";

const ENCODINGS: readonly Encoding[] = ["utf-8", "utf-16", "utf-32"];

/** Texts chosen so every rule below has something that exercises it. */
const CORPUS: readonly [string, string][] = [
  ["empty", ""],
  ["one line, no terminator", "const a = 1;"],
  ["trailing newline", "const a = 1;\n"],
  ["two lines", "const a = 1;\nconst b = 2;\n"],
  ["carriage return and newline", "const a = 1;\r\nconst b = 2;\r\n"],
  ["lone carriage return", "const a = 1;\rconst b = 2;\r"],
  ["mixed terminators", "a;\nb;\r\nc;\rd;"],
  ["blank lines", "a;\n\n\nb;\n"],
  ["two byte", "const café = 1;\nconst x = 2;\n"],
  ["three byte", "const 日本 = 1;\nconst x = 2;\n"],
  ["four byte, a surrogate pair", 'const e = "\u{1f388}";\nconst x = 2;\n'],
  ["the spec's own example", "a\u{10400}b"],
  // Two boundaries a mutation walked straight through. The three byte range
  // starts at U+0800, so a corpus whose non-ascii is all above U+1000 never
  // distinguishes a two byte character from a three byte one; and U+FFFF is the
  // last code point that is not a surrogate pair, so a corpus without it never
  // distinguishes `> 0xffff` from `>= 0xffff`.
  ["either side of the three byte boundary", 'x = "\u07ff\u0800\u0915";\n'],
  ["the last code point of the basic plane", 'x = "\uffff\ufffd";\n'],
  ["ends inside nothing", "\n"],
];

Deno.test("the specification's own example is the one it gives", () => {
  // "in a string of the form a<U+10400>b the character offset of the character a
  // is 0, the character offset of <U+10400> is 1 and the character offset of b is
  // 3 since it is represented using two code units in UTF-16."
  const lines = new Lines("a\u{10400}b");
  assertEquals(lines.positionAt(0, "utf-16").character, 0);
  assertEquals(lines.positionAt(1, "utf-16").character, 1);
  assertEquals(lines.positionAt(3, "utf-16").character, 3);
  // and the same three offsets counted the other two ways
  assertEquals(lines.positionAt(3, "utf-32").character, 2, "two code points");
  assertEquals(lines.positionAt(3, "utf-8").character, 5, "one byte and four");
});

Deno.test("a character past the end of its line falls back to the line length", () => {
  // The protocol says so in as many words, so this is its rule rather than ours.
  const lines = new Lines("ab\ncdef\n");
  for (const encoding of ENCODINGS) {
    assertEquals(lines.offsetAt({ line: 0, character: 2 }, encoding), 2);
    assertEquals(
      lines.offsetAt({ line: 0, character: 900 }, encoding),
      2,
      `${encoding}: not into the next line`,
    );
    assertEquals(lines.offsetAt({ line: 1, character: 900 }, encoding), 7);
  }
});

Deno.test("a line past the end clamps instead of throwing", () => {
  // Ours, not the protocol's, and the only answer that is not a crash: an editor
  // sends positions from a buffer it has already changed under us.
  const lines = new Lines("ab\ncd\n");
  assertEquals(
    lines.count,
    3,
    "the trailing newline opens an empty third line",
  );
  assertEquals(lines.offsetAt({ line: 99, character: 0 }), 6);
  assertEquals(lines.offsetAt({ line: -4, character: 0 }), 0, "and below zero");
  assertEquals(lines.offsetAt({ line: 0, character: -7 }), 0);
});

Deno.test("no position names the gap inside a carriage return and newline", () => {
  // "Positions are line end character agnostic. So you can not specify a position
  // that denotes \r|\n". An offset landing there is rounded back to the end of
  // the line's content, which is the nearest thing that is expressible.
  const lines = new Lines("ab\r\ncd");
  assertEquals(
    lines.positionAt(2),
    { line: 0, character: 2 },
    "before the \\r",
  );
  assertEquals(
    lines.positionAt(3),
    { line: 0, character: 2 },
    "between them, rounded back",
  );
  assertEquals(lines.positionAt(4), { line: 1, character: 0 }, "after both");
});

Deno.test("a lone carriage return ends a line, and so does a lone newline", () => {
  const lines = new Lines("a\rb\nc");
  assertEquals(lines.count, 3);
  assertEquals(lines.positionAt(0), { line: 0, character: 0 });
  assertEquals(lines.positionAt(2), { line: 1, character: 0 });
  assertEquals(lines.positionAt(4), { line: 2, character: 0 });
});

Deno.test("an empty text is one empty line, not zero lines", () => {
  const lines = new Lines("");
  assertEquals(lines.count, 1);
  assertEquals(lines.positionAt(0), { line: 0, character: 0 });
  assertEquals(lines.offsetAt({ line: 0, character: 0 }), 0);
  assertEquals(lines.offsetAt({ line: 5, character: 5 }), 0);
});

Deno.test("the line table agrees with TypeScript's own, offset for offset", () => {
  // An independent instrument rather than the module agreeing with itself.
  // TypeScript builds its own line starts from the same text and reports UTF-16
  // characters, which is the encoding the protocol mandates.
  for (const [name, text] of CORPUS) {
    const file = ts.createSourceFile(
      "a.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const lines = new Lines(text);
    assertEquals(
      lines.count,
      file.getLineStarts().length,
      `${name}: line count`,
    );
    for (let at = 0; at <= text.length; at++) {
      const mine = lines.positionAt(at, "utf-16");
      const theirs = file.getLineAndCharacterOfPosition(at);
      // The one place they may differ is the gap inside a \r\n, where the
      // protocol forbids the position TypeScript is happy to name.
      const inGap = text.charCodeAt(at - 1) === 0x0d &&
        text.charCodeAt(at) === 0x0a;
      if (inGap) {
        assertEquals(
          mine.line,
          theirs.line,
          `${name} at ${at}: still the line`,
        );
        continue;
      }
      assertEquals(
        mine,
        { line: theirs.line, character: theirs.character },
        `${name} at ${at}`,
      );
    }
  }
});

Deno.test("TypeScript really does name the position the protocol forbids", () => {
  // The control for the skip above. Written the other way, that skip would be
  // hiding a disagreement everywhere rather than at the one offset it names.
  const text = "ab\r\ncd";
  const file = ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest, true);
  const theirs = file.getLineAndCharacterOfPosition(3);
  assertEquals(theirs.character, 3, "TypeScript counts the \\r as a character");
  assertNotEquals(
    new Lines(text).positionAt(3).character,
    theirs.character,
    "and we do not, which is the whole reason for the skip",
  );
});

Deno.test("an offset and a position are inverses wherever both are canonical", () => {
  for (const [name, text] of CORPUS) {
    const lines = new Lines(text);
    for (const encoding of ENCODINGS) {
      for (let at = 0; at <= text.length; at++) {
        const back = lines.offsetAt(lines.positionAt(at, encoding), encoding);
        // Rounding is the only thing allowed to move it, and only backwards.
        assertEquals(
          back <= at,
          true,
          `${name} ${encoding} at ${at}: went forwards to ${back}`,
        );
        const rounded = text.charCodeAt(at - 1) === 0x0d &&
            text.charCodeAt(at) === 0x0a ||
          isMidPair(text, at) && encoding !== "utf-16";
        if (!rounded) {
          assertEquals(back, at, `${name} ${encoding} at ${at}`);
        }
      }
    }
  }
});

function isMidPair(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1);
  return before >= 0xd800 && before <= 0xdbff;
}

Deno.test("a column that is a boundary round trips, and one that is not rounds back", () => {
  // Not every integer column is a position. Under utf-8 a column inside a two
  // byte character names no place at all, and the protocol gives no rule for it
  // because it never contemplated one. Rounding back to the boundary below is
  // the only answer that keeps a range inside the text it came from.
  for (const [name, text] of CORPUS) {
    const lines = new Lines(text);
    for (const encoding of ENCODINGS) {
      for (let line = 0; line < lines.count; line++) {
        const from = lines.startOf(line), to = lines.endOf(line);
        // The columns that are boundaries, taken from the offsets that are.
        const boundaries = new Set<number>();
        for (let at = from; at <= to; at++) {
          // Under utf-16 every offset is a column, mid pair included: the
          // protocol's own example names one. The other two cannot split a pair.
          if (encoding !== "utf-16" && isMidPair(text, at)) continue;
          boundaries.add(lines.positionAt(at, encoding).character);
        }
        const width = lines.positionAt(to, encoding).character;
        for (let character = 0; character <= width; character++) {
          const at: Position = { line, character };
          const offset = lines.offsetAt(at, encoding);
          const back = lines.positionAt(offset, encoding);
          const where = `${name} ${encoding} ${line}:${character}`;
          assertEquals(back.line, line, `${where}: stayed on its line`);
          if (boundaries.has(character)) {
            assertEquals(back.character, character, `${where}: a boundary`);
          } else {
            assertEquals(
              back.character < character,
              true,
              `${where}: rounded back rather than forwards`,
            );
          }
          assertEquals(
            lines.offsetAt(back, encoding),
            offset,
            `${where}: and rounding again does not move it`,
          );
        }
      }
    }
  }
});

Deno.test("there really are columns that are not boundaries, or the test above is vacuous", () => {
  // The control. If every column were a boundary in every encoding, the branch
  // that matters above would never be taken and the test would assert nothing.
  const lines = new Lines("const caf\u00e9 = 1;");
  assertEquals(lines.positionAt(9, "utf-8").character, 9, "before the accent");
  assertEquals(
    lines.positionAt(10, "utf-8").character,
    11,
    "after it, two bytes",
  );
  assertEquals(
    lines.offsetAt({ line: 0, character: 10 }, "utf-8"),
    9,
    "so column 10 is inside it and lands before it",
  );
});

Deno.test("utf-8 columns are bytes, counted against the encoder itself", () => {
  // Not against a table of widths written twice. `TextEncoder` is the authority
  // on how many bytes a string takes, and this asks it.
  const encoder = new TextEncoder();
  for (const [name, text] of CORPUS) {
    const lines = new Lines(text);
    for (let line = 0; line < lines.count; line++) {
      const from = lines.startOf(line), to = lines.endOf(line);
      assertEquals(
        lines.positionAt(to, "utf-8").character,
        encoder.encode(text.slice(from, to)).length,
        `${name} line ${line}`,
      );
    }
  }
});

Deno.test("utf-32 columns are code points, counted against the iterator", () => {
  for (const [name, text] of CORPUS) {
    const lines = new Lines(text);
    for (let line = 0; line < lines.count; line++) {
      const from = lines.startOf(line), to = lines.endOf(line);
      assertEquals(
        lines.positionAt(to, "utf-32").character,
        [...text.slice(from, to)].length,
        `${name} line ${line}`,
      );
    }
  }
});

Deno.test("the three encodings disagree, which is why there are three", () => {
  // If they agreed on this text, every test above would pass against one
  // implementation used for all three.
  const lines = new Lines('const e = "\u{1f388}é";');
  const at = lines.text.length;
  assertEquals(lines.positionAt(at, "utf-16").character, 16);
  assertEquals(lines.positionAt(at, "utf-32").character, 15);
  assertEquals(lines.positionAt(at, "utf-8").character, 19);
});

Deno.test("an offset splitting a surrogate pair rounds back where it must", () => {
  const lines = new Lines("a\u{1f388}b");
  assertEquals(lines.positionAt(2, "utf-16").character, 2, "utf-16 can say it");
  assertEquals(
    lines.positionAt(2, "utf-32").character,
    1,
    "utf-32 counts the pair as one, so it is either before it or after",
  );
  assertEquals(lines.positionAt(2, "utf-8").character, 1);
  assertEquals(
    lines.positionAt(3, "utf-8").character,
    5,
    "past it, four bytes",
  );
});

Deno.test("a column inside a wide character lands before it, never inside", () => {
  const text = "\u{1f388}x";
  const lines = new Lines(text);
  // Two utf-8 bytes into a four-byte character is not a place; the offset it
  // resolves to must still be a whole character boundary.
  const at = lines.offsetAt({ line: 0, character: 2 }, "utf-8");
  assertEquals(at, 0);
  assertEquals(lines.offsetAt({ line: 0, character: 4 }, "utf-8"), 2);
});

Deno.test("the default is utf-16, because it is the only one always supported", () => {
  assertEquals(DEFAULT_ENCODING, "utf-16");
  const lines = new Lines("a\u{1f388}b");
  assertEquals(lines.positionAt(3), lines.positionAt(3, "utf-16"));
  assertEquals(
    lines.offsetAt({ line: 0, character: 3 }),
    lines.offsetAt({ line: 0, character: 3 }, "utf-16"),
  );
});

Deno.test("negotiation takes the client's first recognised choice", () => {
  assertEquals(negotiate(["utf-8", "utf-16"]), "utf-8");
  assertEquals(negotiate(["utf-16", "utf-8"]), "utf-16", "order is preference");
  assertEquals(negotiate(["utf-32"]), "utf-32");
  assertEquals(
    negotiate(["ucs-2", "latin1", "utf-8"]),
    "utf-8",
    "unknown ones are skipped rather than refusing the whole list",
  );
});

Deno.test("negotiation falls back to utf-16 on nothing usable", () => {
  assertEquals(negotiate(undefined), "utf-16", "a client that said nothing");
  assertEquals(negotiate([]), "utf-16");
  assertEquals(negotiate(["ucs-2"]), "utf-16", "a client offering only junk");
});

Deno.test("a line's start and end are its content, without the terminator", () => {
  const lines = new Lines("ab\r\ncd\nef");
  assertEquals([lines.startOf(0), lines.endOf(0)], [0, 2]);
  assertEquals([lines.startOf(1), lines.endOf(1)], [4, 6]);
  assertEquals([lines.startOf(2), lines.endOf(2)], [7, 9], "no terminator");
});

Deno.test("a range is two positions and keeps the order it was given", () => {
  const lines = new Lines("abc\ndef\n");
  assertEquals(lines.rangeAt(1, 6), {
    start: { line: 0, character: 1 },
    end: { line: 1, character: 2 },
  });
  // Backwards stays backwards rather than being quietly sorted: a caller handing
  // them the wrong way round has a defect, and hiding it here hides it forever.
  assertEquals(lines.rangeAt(6, 1), {
    start: { line: 1, character: 2 },
    end: { line: 0, character: 1 },
  });
});

Deno.test("the harness can fail, so the agreements above mean something", () => {
  const lines = new Lines("ab\ncd\n");
  assertNotEquals(lines.positionAt(0), lines.positionAt(4));
  assertNotEquals(lines.offsetAt({ line: 0, character: 1 }), 0);
  let threw = false;
  try {
    assertEquals(lines.positionAt(0), { line: 9, character: 9 });
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "assertEquals really does compare these");
});
