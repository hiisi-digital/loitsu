//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** Chaining two rounds of expansion, which is what an expander doing one macro at a
 * time produces. Every law here is checked against the tables' own lookups rather
 * than against a hand-computed answer, so the test cannot agree with a wrong
 * composition by having made the same mistake twice. */
import { assertEquals, assertThrows } from "@std/assert";
import {
  compose,
  identity,
  type Run,
  sourceOffset,
  sourceRuns,
  type Span,
  spanning,
} from "../src/spans.ts";
import { run, span } from "./spans_helpers.ts";

Deno.test("composing with identity on either side changes nothing", () => {
  const t = spanning([span(0, 5, 10), span(20, 3, 40)]);
  const wide = identity(100);
  for (const at of [0, 2, 4, 20, 22]) {
    assertEquals(sourceOffset(compose(wide, t), at), sourceOffset(t, at));
    assertEquals(sourceOffset(compose(t, wide), at), sourceOffset(t, at));
  }
});

Deno.test("a byte surviving both rounds keeps its authored origin", () => {
  // round one moved authored 10 to 0; round two moved that 0 to 7
  const first = spanning([span(0, 5, 10)]);
  const second = spanning([span(7, 5, 0)]);
  assertEquals(sourceOffset(compose(first, second), 7), 10);
  assertEquals(sourceOffset(compose(first, second), 11), 14);
});

Deno.test("a byte the first round generated has no authored origin after the second", () => {
  // the second round faithfully carries a region the first round never mapped, and
  // the honest answer is that nobody wrote it
  const first = spanning([span(0, 5, 10)]);
  const second = spanning([span(0, 20, 0)]);
  const both = compose(first, second);
  assertEquals(
    sourceOffset(both, 2),
    12,
    "the part that was authored still is",
  );
  assertEquals(
    sourceOffset(both, 9),
    undefined,
    "the part that was generated is not",
  );
});

Deno.test("a partial overlap is clipped rather than dropped or widened", () => {
  const first = spanning([span(10, 10, 100)]);
  // covers 5..25 of the intermediate; only 10..20 of that is mapped
  const second = spanning([span(0, 20, 5)]);
  const both = compose(first, second);
  assertEquals(sourceOffset(both, 4), undefined, "before the overlap");
  assertEquals(sourceOffset(both, 5), 100, "the overlap's first byte");
  assertEquals(sourceOffset(both, 14), 109, "its last");
  assertEquals(sourceOffset(both, 15), undefined, "after it");
});

Deno.test("one final run spanning two intermediate runs becomes two spans", () => {
  const first = spanning([span(0, 4, 100), span(4, 4, 200)]);
  const second = spanning([span(0, 8, 0)]);
  const both = compose(first, second);
  assertEquals(both.spans.length, 2);
  assertEquals(sourceOffset(both, 3), 103);
  assertEquals(sourceOffset(both, 4), 200);
});

Deno.test("duplication survives composition: one authored byte, still several images", () => {
  // the first round wrote authored 50 twice; the second carried both, so both must
  // still map back, or a rename reaches one arm and silently misses the other
  const first = spanning([span(0, 3, 50), span(10, 3, 50)]);
  const second = spanning([span(0, 3, 0), span(5, 3, 10)]);
  const both = compose(first, second);
  assertEquals(sourceOffset(both, 0), 50);
  assertEquals(sourceOffset(both, 5), 50);
});

Deno.test("the composed table is ordered and non-overlapping, which spanning enforces", () => {
  // compose returns through `spanning`, so a composition that emitted spans out of
  // order or overlapping would throw here rather than answer wrongly later
  const first = spanning([span(0, 4, 300), span(8, 4, 100), span(20, 4, 200)]);
  const second = spanning([span(0, 4, 8), span(6, 4, 20), span(30, 4, 0)]);
  const both = compose(first, second);
  let reach = -1;
  for (const s of both.spans) {
    assertEquals(s.outStart >= reach, true, `${s.outStart} follows ${reach}`);
    reach = s.outStart + s.length;
  }
});

Deno.test("composition agrees with looking the two tables up one after the other", () => {
  // the law, over every offset rather than over chosen ones
  const first = spanning([span(0, 6, 40), span(10, 4, 90)]);
  const second = spanning([span(2, 5, 1), span(9, 6, 8)]);
  const both = compose(first, second);
  for (let at = 0; at < 20; at++) {
    const mid = sourceOffset(second, at);
    const want = mid === undefined ? undefined : sourceOffset(first, mid);
    assertEquals(sourceOffset(both, at), want, `at ${at}`);
  }
});

Deno.test("the run form agrees too, which the offset law does not imply", () => {
  const first = spanning([span(0, 6, 40), span(10, 4, 90)]);
  const second = spanning([span(2, 5, 1), span(9, 6, 8)]);
  const both = compose(first, second);
  const viaTwo = (r: Run): Run[] =>
    sourceRuns(second, r).flatMap((mid) => sourceRuns(first, mid))
      .sort((a, b) => a.start - b.start);
  for (const r of [run(0, 20), run(2, 5), run(9, 6), run(3, 9), run(14, 1)]) {
    assertEquals(sourceRuns(both, r), viaTwo(r), `over ${JSON.stringify(r)}`);
  }
});

Deno.test("ranges that only touch do not overlap, and produce no span", () => {
  // The early run ends at exactly 4 and the late run's image starts at exactly 4, so
  // they share no byte. Treating that as an overlap emits a span covering nothing,
  // which `spanning` refuses, so the failure would arrive as a throw from a
  // composition rather than as a wrong answer. Neither is acceptable.
  const first = spanning([span(0, 4, 100)]);
  const second = spanning([span(0, 6, 4)]);
  assertEquals(compose(first, second).spans, [], "nothing in common");

  // and the control: one byte further back and they do share a byte
  assertEquals(compose(first, spanning([span(0, 6, 3)])).spans, [
    { outStart: 0, length: 1, inStart: 103 },
  ]);
});

Deno.test("either table empty composes to nothing", () => {
  const t = spanning([span(0, 5, 10)]);
  const none = spanning([] as Span[]);
  assertEquals(compose(none, t).spans, []);
  assertEquals(compose(t, none).spans, []);
});

Deno.test("composition does not commute, so the argument order is load-bearing", () => {
  // without this, an implementation that swapped its arguments would pass every
  // law above that uses a symmetric fixture
  const a = spanning([span(0, 4, 100)]);
  const b = spanning([span(0, 4, 0)]);
  assertEquals(
    sourceOffset(compose(a, b), 0),
    100,
    "b's output lands inside a's",
  );
  assertEquals(
    sourceOffset(compose(b, a), 0),
    undefined,
    "swapped, a's output at 100 misses b's four bytes entirely",
  );
});

Deno.test("the harness can fail, so the agreements above mean something", () => {
  assertThrows(() => spanning([span(5, 3, 0), span(6, 3, 0)]), RangeError);
});
