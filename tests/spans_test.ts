/**
 * What the mapping must and must not do.
 *
 * `spans.ts` had no tests. It is the module every other consumer's correctness
 * rests on: a language server maps a request position in and a diagnostic
 * position out through it, and its own module doc names the failure it exists to
 * prevent as reporting "every later diagnostic against the wrong line,
 * silently". Silent and wrong is the combination that needs laws rather than
 * inspection, so the refusals carry as much weight here as the lookups.
 *
 * @module
 */

import { assertEquals, assertThrows } from "@std/assert";
import { identity, sourceOffset, type Span, spanning } from "../src/spans.ts";
import { span } from "./spans_helpers.ts";

// ---------------------------------------------------------------- construction

Deno.test("an empty table is legal and answers nothing", () => {
  const t = spanning([]);
  assertEquals(t.spans.length, 0);
  assertEquals(sourceOffset(t, 0), undefined);
});

Deno.test("a zero-length span is refused, because it maps nothing", () => {
  assertThrows(() => spanning([span(0, 0, 0)]), RangeError, "maps nothing");
});

Deno.test("a negative-length span is refused", () => {
  assertThrows(() => spanning([span(0, -1, 0)]), RangeError, "maps nothing");
});

Deno.test("overlapping spans are refused, because a position would have two answers", () => {
  assertThrows(
    () => spanning([span(0, 10, 0), span(5, 10, 100)]),
    RangeError,
    "overlaps",
  );
});

Deno.test("spans out of order are refused, which is the same check", () => {
  assertThrows(
    () => spanning([span(10, 5, 0), span(0, 5, 100)]),
    RangeError,
    "overlaps",
  );
});

Deno.test("a negative source offset is refused", () => {
  assertThrows(() => spanning([span(0, 5, -1)]), RangeError, "before the text");
});

Deno.test("exactly adjacent spans are legal; touching is not overlapping", () => {
  const t = spanning([span(0, 5, 100), span(5, 5, 200)]);
  assertEquals(t.spans.length, 2);
  assertEquals(sourceOffset(t, 4), 104);
  assertEquals(sourceOffset(t, 5), 200);
});

Deno.test("the table copies its input, so a later mutation cannot change it", () => {
  const input = [span(0, 5, 100)];
  const t = spanning(input);
  input.push(span(5, 5, 200));
  assertEquals(t.spans.length, 1);
});

// -------------------------------------------------------------------- identity

Deno.test("identity over an empty text has no spans", () => {
  assertEquals(identity(0).spans.length, 0);
});

Deno.test("identity maps every offset to itself", () => {
  const t = identity(10);
  for (let i = 0; i < 10; i++) assertEquals(sourceOffset(t, i), i);
});

Deno.test("identity does not answer past the end of the text it covers", () => {
  assertEquals(sourceOffset(identity(10), 10), undefined);
});

Deno.test("identity of a negative length is refused rather than silently empty", () => {
  assertThrows(() => identity(-1), RangeError);
});

// ---------------------------------------------------------------------- lookup

Deno.test("a lookup resolves at the first, middle and last byte of a span", () => {
  const t = spanning([span(10, 5, 100)]);
  assertEquals(sourceOffset(t, 10), 100);
  assertEquals(sourceOffset(t, 12), 102);
  assertEquals(sourceOffset(t, 14), 104);
});

Deno.test("a span's end is exclusive", () => {
  const t = spanning([span(10, 5, 100)]);
  assertEquals(sourceOffset(t, 15), undefined);
});

Deno.test("a position before, after, or in a gap has no answer", () => {
  const t = spanning([span(10, 5, 100), span(20, 5, 200)]);
  assertEquals(sourceOffset(t, 0), undefined, "before the first span");
  assertEquals(sourceOffset(t, 17), undefined, "in the gap");
  assertEquals(sourceOffset(t, 99), undefined, "past the last span");
});

Deno.test("undefined for a gap is a real answer, not a failure", () => {
  // Text a macro generated came from nowhere in the source. Reporting it against
  // the nearest line would be a guess wearing a citation.
  const t = spanning([span(0, 5, 0), span(20, 5, 5)]);
  for (let i = 5; i < 20; i++) {
    assertEquals(
      sourceOffset(t, i),
      undefined,
      `offset ${i} came from nowhere`,
    );
  }
});

Deno.test("the binary search is correct at every offset of a long table", () => {
  // The lookup is a binary search, so the boundaries between spans are where an
  // off-by-one would hide. Check every offset rather than a sample.
  const spans: Span[] = [];
  for (let i = 0; i < 64; i++) spans.push(span(i * 4, 2, 1000 + i * 2));
  const t = spanning(spans);
  for (let i = 0; i < 64; i++) {
    assertEquals(sourceOffset(t, i * 4), 1000 + i * 2, `start of span ${i}`);
    assertEquals(sourceOffset(t, i * 4 + 1), 1001 + i * 2, `end of span ${i}`);
    assertEquals(sourceOffset(t, i * 4 + 2), undefined, `gap after span ${i}`);
    assertEquals(sourceOffset(t, i * 4 + 3), undefined, `gap after span ${i}`);
  }
});

// ------------------------------------------------- what expansion actually does

Deno.test("two output runs may come from ONE source range", () => {
  // This is not a curiosity. `Expansion` is `readonly ts.Statement[]` so an
  // attribute macro may return the item alongside something derived from it,
  // and the derived part references the authored name. Both images then map
  // back to the same authored offset, and the table must permit that: the
  // non-overlap rule is about OUTPUT, which is what has one answer per position.
  const t = spanning([span(0, 5, 42), span(10, 5, 42)]);
  assertEquals(sourceOffset(t, 0), 42);
  assertEquals(sourceOffset(t, 10), 42);
});

Deno.test("forward is a function even when the reverse would not be", () => {
  // Every output offset has at most one source offset. The converse does not
  // hold, and nothing in this module claims it does; a consumer that needs the
  // reverse needs every image, not the first.
  const t = spanning([span(0, 3, 7), span(3, 3, 7), span(6, 3, 7)]);
  const answers = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((o) => sourceOffset(t, o));
  assertEquals(answers, [7, 8, 9, 7, 8, 9, 7, 8, 9]);
});

Deno.test("the harness can fail, so the laws above mean something", () => {
  // Without this, a `sourceOffset` that always returned undefined would satisfy
  // every negative law here and the positives would be carrying the whole suite.
  const t = spanning([span(0, 5, 100)]);
  assertEquals(sourceOffset(t, 0), 100);
  assertThrows(() => spanning([span(0, 10, 0), span(1, 10, 0)]), RangeError);
});
