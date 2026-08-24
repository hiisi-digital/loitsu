/**
 * The reverse direction, which is plural, and the run forms of both directions.
 *
 * `spans_test.ts` covers the forward offset lookup. This covers what a rename
 * actually needs: from one authored range to every place the expansion wrote it,
 * and back from an output range to the authored runs it really covers.
 *
 * The failure being guarded is silent and specific. One authored offset with
 * several images, answered singularly, edits one image and leaves the rest, and
 * the result compiles, so nothing downstream reports it. Every law here is
 * written so that a singular or a hull-returning implementation fails it.
 *
 * @module
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  identity,
  outputOffsets,
  outputRuns,
  sourceOffset,
  sourceRuns,
  spanning,
} from "../src/spans.ts";
import { run, span } from "./spans_helpers.ts";

// ------------------------------------------------------------- outputOffsets

Deno.test("an authored offset with one image gives that one", () => {
  const t = spanning([span(10, 5, 100)]);
  assertEquals(outputOffsets(t, 100), [10]);
  assertEquals(outputOffsets(t, 102), [12]);
  assertEquals(outputOffsets(t, 104), [14]);
});

Deno.test("an authored offset with three images gives all three, ascending", () => {
  // What a derive macro produces: the item it was handed, plus what it derived,
  // plus a registration, each naming the authored symbol.
  const t = spanning([span(0, 5, 42), span(20, 5, 42), span(40, 5, 42)]);
  assertEquals(outputOffsets(t, 42), [0, 20, 40]);
  assertEquals(outputOffsets(t, 44), [2, 22, 42]);
});

Deno.test("images are ascending, and it is the table's ordering that makes them so", () => {
  // A caller applying edits relies on the order, so it is checked rather than
  // assumed. Two mutations proved a sort here would be unreachable: `spanning`
  // refuses a span starting before the previous one ends, so a table is already
  // in output order and walking it cannot produce anything else. What holds the
  // promise is therefore that refusal, so that is what is asserted.
  const t = spanning([span(0, 3, 90), span(10, 3, 30), span(20, 3, 90)]);
  assertEquals(outputOffsets(t, 90), [0, 20]);
  assertEquals(outputOffsets(t, 91), [1, 21]);

  assertThrows(
    () => spanning([span(20, 3, 90), span(0, 3, 90)]),
    RangeError,
    "overlaps",
    "an out-of-order table is refused, which is what makes the answer ordered",
  );

  // And the same for the run form, over a table whose spans are far apart.
  const wide = spanning([span(0, 2, 5), span(100, 2, 5), span(200, 2, 5)]);
  assertEquals(outputRuns(wide, run(5, 2)), [
    run(0, 2),
    run(100, 2),
    run(200, 2),
  ]);
});

Deno.test("an authored offset a macro deleted has no image, and empty is the answer", () => {
  const t = spanning([span(0, 5, 0), span(5, 5, 20)]);
  // 0..4 and 20..24 have images; 5..19 was deleted
  for (let i = 5; i < 20; i++) {
    assertEquals(outputOffsets(t, i), [], `authored ${i} was deleted`);
  }
});

Deno.test("an authored offset past everything has no image", () => {
  const t = spanning([span(0, 5, 100)]);
  assertEquals(outputOffsets(t, 99), []);
  assertEquals(outputOffsets(t, 105), []);
});

Deno.test("the empty table answers nothing in either direction", () => {
  const t = spanning([]);
  assertEquals(outputOffsets(t, 0), []);
  assertEquals(sourceOffset(t, 0), undefined);
});

Deno.test("forward and reverse agree: every image maps back to what produced it", () => {
  const t = spanning([span(0, 4, 7), span(4, 4, 7), span(8, 4, 100)]);
  for (let src = 0; src < 120; src++) {
    for (const image of outputOffsets(t, src)) {
      assertEquals(
        sourceOffset(t, image),
        src,
        `image ${image} of authored ${src} must map back to it`,
      );
    }
  }
});

Deno.test("and the other way: every output offset is among its source's images", () => {
  const t = spanning([span(0, 4, 7), span(4, 4, 7), span(8, 4, 100)]);
  for (let out = 0; out < 12; out++) {
    const src = sourceOffset(t, out)!;
    assertEquals(
      outputOffsets(t, src).includes(out),
      true,
      `output ${out} came from ${src}, so it must be listed among its images`,
    );
  }
});

Deno.test("identity gives exactly one image per offset", () => {
  const t = identity(10);
  for (let i = 0; i < 10; i++) assertEquals(outputOffsets(t, i), [i]);
  assertEquals(outputOffsets(t, 10), []);
});

// ----------------------------------------------------------------- sourceRuns

Deno.test("a run inside one span maps to one authored run", () => {
  const t = spanning([span(10, 20, 100)]);
  assertEquals(sourceRuns(t, run(12, 5)), [run(102, 5)]);
});

Deno.test("a run half in a span and half in a gap keeps only the mapped half", () => {
  // `greet__deno` in a twin: five authored bytes, then six the expander invented.
  // The honest answer is a run of five, not a range of eleven.
  const t = spanning([span(0, 5, 40)]);
  assertEquals(sourceRuns(t, run(0, 11)), [run(40, 5)]);
});

Deno.test("a run entirely in a gap maps to nothing", () => {
  const t = spanning([span(0, 5, 40), span(20, 5, 45)]);
  assertEquals(sourceRuns(t, run(8, 6)), []);
});

Deno.test("two authored runs with a gap between them stay two, never a hull", () => {
  // The law that a hull-returning implementation fails. Returning {40,25} here
  // would tell a caller to edit fifteen authored bytes nothing asked about.
  const t = spanning([span(0, 5, 40), span(5, 5, 60)]);
  assertEquals(sourceRuns(t, run(0, 10)), [run(40, 5), run(60, 5)]);
});

Deno.test("authored runs that touch are joined, whatever the table's own splits", () => {
  const t = spanning([span(0, 3, 40), span(3, 3, 43)]);
  assertEquals(sourceRuns(t, run(0, 6)), [run(40, 6)]);
});

Deno.test("authored runs come back in authored order even when output order differs", () => {
  // A macro that reorders what it was handed. Without sorting, the two halves of
  // one authored word arrive apart and read as two separate regions.
  const t = spanning([span(0, 3, 53), span(3, 3, 50)]);
  assertEquals(sourceRuns(t, run(0, 6)), [run(50, 6)]);
});

Deno.test("an empty or negative run maps to nothing rather than to everything", () => {
  const t = spanning([span(0, 10, 0)]);
  assertEquals(sourceRuns(t, run(3, 0)), []);
  assertEquals(sourceRuns(t, run(3, -2)), []);
});

Deno.test("a run whose last byte is a span's first byte still picks that span up", () => {
  // The off-by-one the walk's early exit can hide: the run ends at 11, span two
  // starts at 10, so its first byte is the run's last. A comparison one out
  // stops before reaching it and loses an authored run with no other symptom.
  const t = spanning([span(0, 5, 100), span(10, 5, 200)]);
  assertEquals(sourceRuns(t, run(0, 11)), [run(100, 5), run(200, 1)]);
  assertEquals(
    sourceRuns(t, run(0, 10)),
    [run(100, 5)],
    "and one byte short does not",
  );
});

Deno.test("a run touching a span's exclusive end does not pick it up", () => {
  const t = spanning([span(0, 5, 100), span(10, 5, 200)]);
  assertEquals(sourceRuns(t, run(5, 5)), []);
  assertEquals(sourceRuns(t, run(4, 1)), [run(104, 1)]);
});

// ----------------------------------------------------------------- outputRuns

Deno.test("an authored run with one image gives one output run", () => {
  const t = spanning([span(10, 20, 100)]);
  assertEquals(outputRuns(t, run(102, 5)), [run(12, 5)]);
});

Deno.test("an authored run written three times gives three output runs", () => {
  // The rename case, whole. One name, three places the expansion wrote it.
  const t = spanning([span(0, 5, 42), span(20, 5, 42), span(40, 5, 42)]);
  assertEquals(outputRuns(t, run(42, 5)), [run(0, 5), run(20, 5), run(40, 5)]);
});

Deno.test("a partial authored run is clipped in every image, not dropped", () => {
  const t = spanning([span(0, 5, 42), span(20, 5, 42)]);
  assertEquals(outputRuns(t, run(43, 2)), [run(1, 2), run(21, 2)]);
});

Deno.test("an authored run a macro deleted gives no output runs", () => {
  const t = spanning([span(0, 5, 0), span(5, 5, 20)]);
  assertEquals(outputRuns(t, run(8, 5)), []);
});

Deno.test("output runs that touch are joined", () => {
  const t = spanning([span(0, 3, 40), span(3, 3, 43)]);
  assertEquals(outputRuns(t, run(40, 6)), [run(0, 6)]);
});

Deno.test("an empty or negative authored run maps to nothing", () => {
  const t = spanning([span(0, 10, 0)]);
  assertEquals(outputRuns(t, run(3, 0)), []);
  assertEquals(outputRuns(t, run(3, -2)), []);
});

Deno.test("the run forms agree with the offset forms, over a whole table", () => {
  const t = spanning([span(0, 4, 7), span(10, 4, 7), span(20, 4, 100)]);
  for (let src = 0; src < 110; src++) {
    const fromRuns = outputRuns(t, run(src, 1)).map((r) => r.start);
    assertEquals(
      fromRuns,
      outputOffsets(t, src),
      `a one-byte run and an offset must name the same images for ${src}`,
    );
  }
});

Deno.test("round trip: every image of a run maps back to a run inside the original", () => {
  const t = spanning([span(0, 4, 7), span(10, 4, 7), span(20, 4, 100)]);
  const authored = run(7, 4);
  for (const image of outputRuns(t, authored)) {
    assertEquals(
      sourceRuns(t, image),
      [authored],
      "an image maps back to what produced it",
    );
  }
});

// ------------------------------------------------------------------- controls

Deno.test("the harness can fail, so the emptiness above means something", () => {
  // Every negative law here is satisfied by a function that always returns [].
  // These are the positives that such a function fails.
  const t = spanning([span(0, 5, 42), span(20, 5, 42)]);
  assertEquals(outputOffsets(t, 42).length, 2);
  assertEquals(outputRuns(t, run(42, 5)).length, 2);
  assertEquals(sourceRuns(t, run(0, 5)).length, 1);
});

Deno.test("a singular reverse would fail these, which is why they are here", () => {
  // Stated as a test rather than as a comment: the shape casey found and the
  // reason the surface is plural. An implementation returning only the first
  // image passes every other law in this file.
  const t = spanning([span(0, 5, 42), span(20, 5, 42), span(40, 5, 42)]);
  assertEquals(outputOffsets(t, 42), [0, 20, 40]);
  assertEquals(
    outputOffsets(t, 42).length > 1,
    true,
    "plural, or a rename goes partial",
  );
});
