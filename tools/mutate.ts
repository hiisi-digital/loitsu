//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Break the code on purpose and check the tests notice.
 *
 * A passing suite says the code does what the tests say. It does not say the tests
 * reach the code, and a condition no test constrains passes every run whatever it
 * is set to. So each mutation below is a plausible wrong version of one line, and a
 * mutation that survives names a claim nothing holds down.
 *
 * Two rules the harness enforces rather than trusts. A mutation whose search text
 * is not in the file is a hard failure, because a stale pattern silently tests
 * nothing and reports it as caught. And the original is put back in a `finally`,
 * because it once was not: a crash mid-run left a mutant on disk, and the next
 * hour was spent debugging a bug that had been introduced deliberately.
 *
 * A mutation is a real edit to a real file for as long as the suite runs against
 * it, so anything else reading that file meanwhile reads the mutant. A second
 * mutation run is refused outright by the lock below. An ordinary `deno task test`
 * is not, and running one during a sweep produces failures that belong to a
 * mutation rather than to the tree.
 *
 * Run: `deno run -A tools/mutate.ts src/expand.ts tests/expand_test.ts`
 * with the mutations for that file listed in `PLANS` below.
 */

interface Mutation {
  readonly what: string;
  readonly from: string;
  readonly to: string;
}

/** The replacement that makes a guard unreachable, which is how a refusal is tested:
 * the mutant compiles, accepts what the guard refused, and something downstream has to
 * notice. */
const NEVER = "if (false) {";
/** The tail of a multi-line call, shared by the mutations that swap one argument in
 * it, so the two spellings cannot drift apart from each other or from the source. */
const CALL_END = "\n    );";
/** What follows the foreign-node refusal in `expand`. Shared by the mutation that
 * removes the refusal and the one that restores it, so the two cannot drift apart
 * and quietly stop matching the source. */
const AFTER_REFUSAL = "\n    }\n\n    markLeaves(produced, marker, src);";
/** The same, at the indentation a method body sits at. */
const NEVER_AT = `    ${NEVER}`;
/** A guard removed by making its condition unreachable, in the two shapes a guard
 * takes: one that returns from the method and one that skips a loop iteration. */
const NEVER_RETURN = "    if (false) return;";
const NEVER_CONTINUE = "    if (false) continue;";
/** The same two shapes at the indentation a nested block sits at. */
const NEVER_CONTINUE_IN = "        if (false) continue;";
const NEVER_IN = "    if (false) {";
/** The same, at the indentation a function body sits at. */
const NEVER_TOP = "  if (false) {";
/** The head of the header line `frame` writes. Shared by the mutation that leaves it
 * alone and the one that changes how the block ends, so the two cannot drift. */
const WROTE = "    `Content-Length: ${body.length}";
/** A statement removed by replacing it with one that does nothing, which is how a
 * step whose absence has to be noticed downstream is tested. */
const DOES_NOTHING = "  void 0;";

/** Where an attribute's replacement stops. Named because two mutations move it, and
 * one of them is the other's line with the attribute's own start put back. */
const ITEM_END = "to = use.target.getEnd();";

/** The store's cleanup. In both halves of one mutation, which swaps the `catch` it
 * hangs off for a `finally` and so has to repeat the body it keeps. */
const DROP_TEMP = "    await Deno.remove(temp).catch(() => {});";

/**
 * Several mutations of one line.
 *
 * A line worth breaking is usually worth breaking more than one way, and writing it
 * out per variant means the plan holds the same string twice and both copies have to
 * be kept in step with the source. Named once, mutated many times.
 */
function ways(
  from: string,
  ...variants: readonly (readonly [string, string])[]
): Mutation[] {
  return variants.map(([what, to]) => ({ what, from, to }));
}

const PLANS: Record<string, readonly Mutation[]> = {
  // The sandbox tests pin Deno's behaviour rather than loitsu's, so there is no
  // source of ours to mutate for most of what they claim. What is ours is the
  // probe each worker runs, and a probe that reports the right answer whatever
  // happened is how these tests would go quiet. Each arm here turns one probe
  // into a liar and expects the suite to notice.
  "tests/sandbox_read_worker.ts": [
    ...ways(
      "    read = (await Deno.readTextFile(e.data.path)).trim();",
      [
        "the probe never reads, so a denial and a granted read look alike",
        '    read = "not for a macro";',
      ],
    ),
    ...ways(
      "    built = ts.createPrinter().printNode(",
      [
        "the probe answers a constant, so the compiler need not have run",
        '    built = "const built__ok: number = 1;"; ((_: unknown) => {})(',
      ],
    ),
    // The claim that the isolate loaded the compiler is carried by the import
    // rather than by any line in the handler: a module that cannot load never
    // evaluates, and the parent hears that instead of an answer. So the mutation
    // that tests it is the one that takes the import away, and an echo of the
    // name from inside the handler is not one, because the import above it still
    // has to have succeeded for the handler to run at all.
    ...ways(
      'import ts from "typescript";',
      [
        "nothing in the isolate is the compiler, only something shaped like it",
        'const ts = { factory: { createIdentifier: (text: string) => ({ text }) }, version: "5.9.3" };',
      ],
    ),
  ],
  "tests/sandbox_run_worker.ts": [
    ...ways(
      "    }).output();",
      [
        "the probe never waits for the process, so a refused spawn and a finished\n      // one report the same thing",
        "    });",
      ],
    ),
    ...ways(
      '      args: ["eval", `console.log(${JSON.stringify(e.data.word)}, Deno.pid)`],',
      [
        "the child prints a constant, so the answer no longer depends on a process\n      // having been given anything to say",
        '      args: ["eval", `console.log("a-process-ran", 1)`],',
      ],
      [
        "the child no longer says which process it was, so an echo of the word\n      // would pass for having run one",
        '      args: ["eval", `console.log(${JSON.stringify(e.data.word)})`],',
      ],
    ),
    ...ways(
      "      said: new TextDecoder().decode(stdout).trim(),",
      [
        "the probe answers with what it was asked rather than with what ran",
        "      said: `${e.data.word} ${Deno.pid}`,",
      ],
    ),
  ],
  "tests/sandbox_worker.ts": [
    ...ways(
      '    await Deno.writeTextFile(e.data.path, "a macro wrote this");',
      [
        "the probe never writes, so the write denial is asserted against nothing",
        "    /* kept */;",
      ],
    ),
  ],
  "tests/readme_test.ts": [
    ...ways(
      '      if (!line.startsWith("import ")) {',
      [
        "an import line is checked as a statement, so the merged program repeats\n      // every import and cannot compile at all",
        "      if (true) {",
      ],
    ),
    ...ways(
      "        bodies.push(line);",
      [
        "the statements a block was written to show are dropped, leaving imports\n      // that check trivially",
        DOES_NOTHING,
      ],
    ),
    ...ways(
      "      assert(plain !== null, `readme import not understood: ${line}`);",
      [
        "an import shape the merge cannot read is dropped rather than reported",
        DOES_NOTHING,
      ],
    ),
    ...ways(
      "    assert(known.has(tag), `unknown fence language in the readme: ${tag}`);",
      [
        "a misspelled fence language passes, so a block nobody checks reads as one\n      // that was checked",
        DOES_NOTHING,
      ],
    ),
  ],
  "src/translate.ts": [
    ...ways(
      "  return { start, length: end - start };",
      [
        "a range's length is measured backwards",
        "  return { start, length: start - end };",
      ],
      [
        "a range's length is its end, so every range starts from the same place",
        "  return { start, length: end };",
      ],
    ),
    ...ways(
      "    return outputOffsets(this.#pair.spans, offset)",
      [
        "an authored position answers with only its first image, so a rename\n      // driven off it reaches one arm and silently leaves the others",
        "    return outputOffsets(this.#pair.spans, offset).slice(0, 1)",
      ],
    ),
    ...ways(
      "    return back === undefined",
      [
        "a twin position with no authored image is answered with one anyway",
        "    return false",
      ],
    ),
    ...ways(
      "  if (here === undefined) return undefined;",
      [
        "a diagnostic on text nobody wrote is reported rather than dropped",
        "  if (here === undefined) return diagnostic;",
      ],
    ),
    ...ways(
      "  for (const rest of ranges.slice(1)) {",
      [
        "the authored range a diagnostic sits on is also noted beside itself",
        "  for (const rest of ranges.slice(0)) {",
      ],
      [
        "a diagnostic covering two authored regions mentions only the first",
        "  for (const rest of []) {",
      ],
    ),
    ...ways(
      "    if (one.location.uri !== uri) {",
      [
        "a related location in another file is moved through this document's table",
        NEVER_IN,
      ],
      [
        "a related location in this document is passed through unmoved",
        "    if (true) {",
      ],
    ),
    ...ways(
      "    if (moved === undefined) continue;",
      [
        "a related location with no authored image is kept, pointing nowhere",
        NEVER_CONTINUE,
      ],
    ),
    ...ways(
      "  if (related.length > 0) return { ...out, relatedInformation: related };",
      [
        "a diagnostic that had no related information leaves carrying an empty list",
        "  if (true) return { ...out, relatedInformation: related };",
      ],
    ),
    ...ways(
      "  delete (out as { relatedInformation?: unknown }).relatedInformation;",
      [
        "the incoming related information survives unmapped when all of it was dropped",
        DOES_NOTHING,
      ],
    ),
    ...ways(
      "      if (ranges.length === 0) dropped++;",
      [
        "an edit naming only invented text is dropped without being counted",
        "      if (false) dropped++;",
      ],
    ),
    ...ways(
      "        if (seen.has(key)) continue;",
      [
        "the same authored range from two twins becomes two edits of one place",
        NEVER_CONTINUE_IN,
      ],
    ),
    ...ways(
      "          newText: wrote === authored ? edit.newText : newName,",
      [
        "the twin's replacement is spliced onto the authored range whatever it\n      // was computed against, so a derived name's affix lands on the source",
        "          newText: edit.newText,",
      ],
      [
        "the affix a shorthand property needs is dropped, leaving `{ bar }`\n      // where `{ foo: bar }` was meant",
        "          newText: newName,",
      ],
    ),
    ...ways(
      "    if (run.length === 0) {",
      [
        "a point is crossed as a run, so every zero-length diagnostic is dropped",
        NEVER_IN,
      ],
      [
        "a backwards range is crossed as a point at its start rather than as nothing",
        "    if (run.length <= 0) {",
      ],
    ),
    ...ways(
      "  edits.sort((a, b) => comparePositions(a.range.start, b.range.start));",
      [
        "edits come back in the order the twins were asked, not in authored order",
        DOES_NOTHING,
      ],
    ),
    ...ways(
      "    if (comparePositions(next.start, last.end) < 0) {",
      [
        "overlapping edits are handed to the client rather than refused",
        NEVER_IN,
      ],
      [
        "edits that merely touch are refused, which is the common case",
        "    if (comparePositions(next.start, last.end) <= 0) {",
      ],
      [
        "the comparison is against the previous start, so nesting is not seen",
        "    if (comparePositions(next.start, last.start) < 0) {",
      ],
    ),
    // Two mutations were written here and both were equivalent, because the
    // comparison they broke had clauses no input could reach: two edits sharing a
    // start overlap and are refused before anything can be distinguished by where
    // they end. The answer was to delete the unreachable clauses rather than to
    // hunt for a test, so the comparison is now over positions and the dedupe is
    // over a key. What is left is reachable and is mutated below.
    ...ways(
      "  return a.line - b.line || a.character - b.character;",
      [
        "two positions on different lines compare as one position",
        "  return a.character - b.character;",
      ],
    ),
    ...ways(
      "    `${range.end.line}:${range.end.character}`;",
      [
        "two edits starting in one place are the same however far each reaches",
        "    ``;",
      ],
    ),
  ],
  "src/position.ts": [
    ...ways(
      "      if (ch === 0x0a) starts.push(at + 1);",
      [
        "a newline stops opening a line, so the whole text is one line",
        "      if (false) starts.push(at + 1);",
      ],
    ),
    ...ways(
      "      else if (ch === 0x0d) {",
      [
        "a lone carriage return stops ending a line",
        "      else if (false) {",
      ],
    ),
    ...ways(
      "        if (text.charCodeAt(at + 1) === 0x0a) at++;",
      [
        "a carriage return and newline becomes two lines instead of one",
        "        if (false) at++;",
      ],
      [
        "the pair is consumed even when the newline is not there",
        "        at++;",
      ],
    ),
    ...ways(
      "      this.#text.charCodeAt(at - 1) === 0x0d",
      [
        "a line's content is measured as including its carriage return",
        "      false",
      ],
    ),
    ...ways(
      "    const line = Math.min(Math.max(Math.trunc(at.line), 0), this.count - 1);",
      [
        "a line past the end is not clamped, so the lookup is undefined",
        "    const line = Math.max(Math.trunc(at.line), 0);",
      ],
      [
        "a negative line is not clamped",
        "    const line = Math.min(Math.trunc(at.line), this.count - 1);",
      ],
      [
        "the last line is one short, so the last line is unreachable",
        "    const line = Math.min(Math.max(Math.trunc(at.line), 0), this.count - 2);",
      ],
    ),
    ...ways(
      "    const want = Math.max(Math.trunc(at.character), 0);",
      [
        "a negative character is not clamped to the start of the line",
        "    const want = Math.trunc(at.character);",
      ],
    ),
    ...ways(
      '    if (encoding === "utf-16") return Math.min(from + want, to);',
      [
        "a character past the end of its line runs into the next one",
        '    if (encoding === "utf-16") return from + want;',
      ],
      [
        "utf-16 takes the counting path, which counts a pair as one unit",
        "    if (false) return Math.min(from + want, to);",
      ],
    ),
    ...ways(
      "      if (counted + cost > want) return scan;",
      [
        "a column exactly on a boundary lands before it rather than on it",
        "      if (counted + cost >= want) return scan;",
      ],
      [
        "a wide character is entered rather than stopped before",
        "      if (counted > want) return scan;",
      ],
    ),
    ...ways(
      "  if (code < 0x80) return 1;",
      ["ascii is counted as two bytes", "  if (code < 0x80) return 2;"],
      [
        "the one byte range runs too far, so two byte characters count as one",
        "  if (code < 0x100) return 1;",
      ],
    ),
    ...ways(
      "  if (code < 0x800) return 2;",
      [
        "the two byte range runs too far, so three byte characters count as two",
        "  if (code < 0x1000) return 2;",
      ],
    ),
    ...ways(
      "  if (code < 0x10000) return 3;",
      [
        "a character outside the basic plane is counted as three bytes",
        "  if (code < 0x110000) return 3;",
      ],
    ),
    ...ways(
      "      if (this.#starts[mid]! <= want) lo = mid;",
      [
        "the search excludes a line's own first offset, landing on the one before",
        "      if (this.#starts[mid]! < want) lo = mid;",
      ],
    ),
    ...ways(
      "    const to = Math.min(want, this.endOf(lo));",
      [
        "an offset inside a carriage return and newline names the gap",
        "    const to = want;",
      ],
    ),
    ...ways(
      "      if (wide && scan + 2 > to) break; // the offset splits a pair",
      [
        "an offset splitting a surrogate pair counts the whole pair",
        "      if (false) break;",
      ],
    ),
    ...ways(
      "      const wide = code > 0xffff;",
      [
        "the last character of the basic plane is read as a surrogate pair",
        "      const wide = code >= 0xffff;",
      ],
    ),
    ...ways(
      '      counted += encoding === "utf-8" ? utf8Width(code) : 1;',
      [
        "utf-32 counts bytes and utf-8 counts code points, the two swapped",
        '      counted += encoding === "utf-8" ? 1 : utf8Width(code);',
      ],
    ),
    ...ways(
      '    if (one === "utf-8" || one === "utf-16" || one === "utf-32") return one;',
      [
        "an unrecognised encoding is accepted rather than skipped",
        "    return one as Encoding;",
      ],
      [
        "utf-8 is not recognised, so a client asking for it is answered in utf-16",
        '    if (one === "utf-16" || one === "utf-32") return one;',
      ],
    ),
    ...ways(
      "  return DEFAULT_ENCODING;",
      [
        "a client offering nothing usable is answered in an encoding it may not have",
        '  return "utf-8";',
      ],
    ),
  ],
  "src/spans.ts": [
    // `spanning`, `identity`, `sourceOffset` and `outputOffsets` had no mutations at
    // all, which is four of seven exports and includes the constructor every other
    // claim in the module rests on. A review found the gap; the suite caught every
    // mutation written to close it, so what was missing was the harness's account of
    // itself rather than the coverage.
    ...ways(
      "      if (!Number.isInteger(value)) {",
      [
        "spanning stops checking that a span's fields are whole numbers",
        `  ${NEVER_AT}`,
      ],
      [
        "spanning accepts a fractional offset",
        '      if (typeof value !== "number") {',
      ],
    ),
    ...ways(
      "    if (span.length <= 0) {",
      ["spanning accepts an empty span", "    if (span.length < 0) {"],
      ["spanning accepts any span", NEVER_AT],
    ),
    ...ways(
      "    if (span.outStart < reach) {",
      ["spanning accepts overlapping spans", NEVER_AT],
      [
        "spanning refuses spans that merely touch",
        "    if (span.outStart <= reach) {",
      ],
    ),
    {
      what: "spanning stops refusing a source offset before the text",
      from: "    if (span.inStart < 0) {",
      to: NEVER_AT,
    },
    {
      what: "spanning shares its input array instead of copying it",
      from: "  return { spans: [...spans] };",
      to: "  return { spans };",
    },
    {
      what: "identity claims a span over an empty text",
      from: "  return length === 0",
      to: "  return length === -1",
    },
    {
      what: "compose reads its arguments the other way round",
      from: "const from = late.inStart, to = late.inStart + late.length;",
      to: "const from = late.outStart, to = late.outStart + late.length;",
    },
    {
      what: "compose keeps a run the first table never mapped",
      from: "if (lo >= hi) continue;",
      to: "if (lo > hi) continue;",
    },
    {
      what: "compose anchors the output at the overlap",
      from: "outStart: late.outStart + (lo - from),",
      to: "outStart: lo,",
    },
    {
      what: "compose drops the offset into the early span",
      from: "inStart: early.inStart + (lo - early.outStart),",
      to: "inStart: early.inStart,",
    },
    {
      what: "compose takes the hull instead of the intersection",
      from: "const lo = Math.max(early.outStart, from);",
      to: "const lo = Math.min(early.outStart, from);",
    },
    {
      what: "compose clips to the wrong end",
      from: "const hi = Math.min(early.outStart + early.length, to);",
      to: "const hi = Math.max(early.outStart + early.length, to);",
    },
    ...ways(
      "return spanning(out);",
      ["compose returns the second table unchanged", "return second;"],
      ["compose returns the first table unchanged", "return first;"],
    ),
    {
      what: "sourceRuns breaks out one span too early",
      from: "if (span.outStart >= end) break;",
      to: "if (span.outStart >= end - 1) break;",
    },
    {
      what: "sourceRuns drops the authored sort",
      from: "runs.sort((a, b) => a.start - b.start);",
      to: "",
    },
    {
      what: "outputRuns keeps a run that only touches",
      from: "if (spanEnd <= source.start || span.inStart >= end) continue;",
      to: "if (spanEnd < source.start || span.inStart > end) continue;",
    },
    {
      what: "merge joins runs that do not touch",
      from: "if (last && last.start + last.length === run.start) {",
      to: "if (last) {",
    },
  ],
  "src/sentinel.ts": [
    {
      what: "mark accepts a zero-length region",
      from: "if (sourceLength <= 0) {",
      to: "if (sourceLength < 0) {",
    },
    {
      what: "mark accepts a negative start",
      from: "if (sourceStart < 0) {",
      to: NEVER,
    },
    {
      what: "strip does not trim the marker's own padding",
      from: "let from = start, to = start + length;",
      to: "return { start, length };\n  let from = start, to = start + length;",
    },
    {
      what: "strip trims only the leading padding",
      from: "while (to > from && /\\s/.test(text[to - 1]!)) to--;",
      to: "",
    },
    {
      what: "strip accepts any run's nonce",
      from: "${SIGIL}${marker.nonce}(",
      to: "${SIGIL}[a-z0-9]+?(",
    },
    {
      what: "strip leaves an open registered after closing",
      from: "opens.delete(id);",
      to: "",
    },
    {
      what: "strip treats a crossed close as opening at zero",
      from: "if (start === undefined) continue;",
      to:
        "if (start === undefined) { found.push({ id, outStart: 0, length: text.length }); continue; }",
    },
    ...ways(
      'if (m[2] === "o") opens.set(id, text.length);',
      [
        "strip records the open against the input offset",
        'if (m[2] === "o") opens.set(id, at);',
      ],
      [
        "strip swaps the open and close halves",
        'if (m[2] === "c") opens.set(id, text.length);',
      ],
    ),
    {
      what: "strip records a pair enclosing nothing",
      from: "if (cut.length > 0) {",
      to: "if (cut.length >= 0) {",
    },
    ...ways(
      "!located.has(id)",
      ["lost reports nothing at all", "false"],
      ["lost reports everything marked", "true"],
    ),
    {
      what: "the nonce is accepted unvalidated",
      from: "if (!/^[a-z0-9]+$/.test(nonce)) {",
      to: NEVER,
    },
  ],
  "src/watch.ts": [
    // Everything else in the suite injects a reader, so nothing else would notice
    // the default one going away. It is what a consumer actually gets.
    ...ways(
      "    this.#read = options.read ?? ((path) => Deno.readTextFile(path));",
      [
        "there is no default reader, so a Twins built the documented way cannot read",
        "    this.#read = options.read!;",
      ],
    ),
    // The declined `<=` to `<` mutation that used to sit here is gone with the
    // counter it was about. Its stated reason was also wrong: two rebuilds of one
    // path could carry the same number, because `forget` reset it. One stamp from
    // one counter, never reused, means the guard is a single equality and every
    // way of loosening it is reachable.
    ...ways(
      "    if (at !== this.#seen.get(path)) return;",
      [
        "the last rebuild to finish wins, whatever it saw",
        NEVER_RETURN,
      ],
      [
        "a rebuild older than the newest change still stores",
        "    if (at > (this.#seen.get(path) ?? Infinity)) return;",
      ],
      [
        "a rebuild for a forgotten path resurrects it",
        "    if (this.#seen.has(path) && at !== this.#seen.get(path)) return;",
      ],
    ),
    {
      what: "a change does not take a new stamp, so nothing overtakes",
      from: "    this.#seen.set(path, ++this.#next);",
      to: "    this.#seen.set(path, this.#seen.get(path) ?? ++this.#next);",
    },
    {
      what: "a second request does not wait for the build already running",
      from: "    if (running !== undefined) await running;",
      to: NEVER_RETURN.replace("return;", "await running;"),
    },
    {
      what: "get rebuilds a path it already holds a twin for",
      from:
        "    else if (!this.#seen.has(path)) await this.#acknowledge(path);",
      to: "    else await this.#acknowledge(path);",
    },
    {
      what: "a forgotten path keeps waiting on the rebuild it abandoned",
      from: "    this.#building.delete(path);",
      to: "    /* kept */;",
    },
    {
      what: "a macro that throws takes the process with it",
      from:
        "      this.#store(path, at, undefined, `${(err as Error).message}`);",
      to: "      throw err;",
    },
    {
      what: "an unreadable file keeps whatever twin it had",
      from:
        "      this.#store(path, at, undefined, (err as Error).constructor.name);",
      to: "      return;",
    },
    {
      what: "a rebuilt twin does not clear the failure before it",
      from: "      this.#failed.delete(path);",
      to: "      /* kept */;",
    },
    {
      what: "forget leaves the generation behind",
      from: "    this.#seen.delete(path);",
      to: "    /* kept */;",
    },
    {
      what: "the path never reaches the cache, so tsx is expanded as ts",
      from: "        path,",
      to: "        undefined,",
    },
    ...ways(
      "  return source && !declaration;",
      ["declaration files are expanded too", "  return source;"],
      ["everything is interesting", "  return true;"],
    ),
    ...ways(
      '  const source = [".ts", ".tsx", ".mts", ".cts"].some((e) =>',
      [
        "the module extensions are ignored",
        '  const source = [".ts", ".tsx"].some((e) =>',
      ],
    ),
    ...ways(
      '  const declaration = [".d.ts", ".d.mts", ".d.cts"].some((e) =>',
      [
        "only the plain declaration form is refused",
        '  const declaration = [".d.ts"].some((e) =>',
      ],
    ),
    {
      what: "a deleted file keeps its twin instead of being forgotten",
      from: "      else options.twins.forget(path);",
      to: "      else { /* kept */ }",
    },
    {
      what: "a removed file is rebuilt rather than forgotten",
      from: "      if (await exists(path)) await options.twins.changed(path);",
      to: "      if (true) await options.twins.changed(path);",
    },
    {
      what: "the filter is dropped, so every file is expanded",
      from: "        if (matches(path)) pending.add(path);",
      to: "        pending.add(path);",
    },
    {
      what: "a signal that already aborted leaves the watch running forever",
      from: "  if (options.signal?.aborted === true) stop();",
      to: "  /* kept */;",
    },
    {
      what: "the debounce has no ceiling, so a sustained write starves it",
      from: "        Math.min(settleMs, maxWaitMs - (Date.now() - oldest)),",
      to: "        settleMs,",
    },
    {
      what:
        "the batch clock is never restarted, so every later batch is instant",
      from: "    oldest = undefined;",
      to: "    /* kept */;",
    },
    {
      what: "a batch collected at the moment of the abort is dropped",
      from: "      await flush();",
      to: "      /* dropped */;",
    },
  ],
  "src/cache.ts": [
    ...ways(
      '  const key = await keyOf(text, `${against}:${dialectOf(fileName ?? "")}`);',
      [
        "the dialect leaves the key, so a tsx file is served a ts twin",
        "  const key = await keyOf(text, against);",
      ],
      [
        "the file name joins the key, so two identical files never share an entry",
        "  const key = await keyOf(text, `${against}:${fileName}`);",
      ],
    ),

    {
      what: "an empty XDG value is taken as a real directory",
      from: "xdg && xdg.length > 0",
      to: "xdg !== undefined",
    },
    {
      what: "the version is left out of the path",
      from: "`${base}/loitsu/v${VERSION}`",
      to: "`${base}/loitsu`",
    },
    {
      what: "the fallback is the home itself rather than its cache",
      from: "`${home}/.cache`",
      to: "home",
    },
    ...ways(
      "`${against}${SEPARATOR}${text}`",
      ["the key ignores what it was expanded against", "text"],
      ["the key ignores the text", "against"],
    ),
    {
      what: "the two halves of the key run together",
      from: "${SEPARATOR}",
      to: "",
    },
    {
      what: "a stored entry's version is not checked",
      from: "if (stored.version !== VERSION) return undefined;",
      to: "",
    },
    {
      what: "a stored span table is taken as given",
      from: "spans: spanning(stored.spans),",
      to: "spans: { spans: stored.spans },",
    },
    {
      what: "a malformed entry's shape is not checked",
      from:
        'if (typeof stored.code !== "string" || !Array.isArray(stored.spans)) {',
      to: NEVER,
    },
    {
      what: "a failed store is allowed to throw",
      from: `  } catch {
${DROP_TEMP}
  }`,
      to: `  } finally {
${DROP_TEMP}
  }`,
    },
    {
      what: "a hit is reported as a miss",
      from: "return { ...found, hit: true };",
      to: "return { ...found, hit: false };",
    },
    {
      what: "the cache never stores anything",
      from: "await write(dir, key, fresh);",
      to: "",
    },
    {
      what: "the cache is never read",
      from: "const found = await read(dir, key);",
      to: "const found = undefined;",
    },
    {
      what: "no cache home is an error rather than an answer",
      from:
        "  if (dir === undefined) return { ...expand(text, reg, options), hit: false };",
      to: '  if (dir === undefined) throw new Error("no cache home");',
    },
  ],
  "src/expand.ts": [
    ...ways(
      "    if (leaf.getSourceFile() !== src) continue;",
      ["a leaf from another file is marked anyway", NEVER_CONTINUE],
      [
        "the provenance check is inverted",
        "    if (leaf.getSourceFile() === src) continue;",
      ],
    ),
    ...ways(
      "    if (file !== undefined && file !== src) return node;",
      ["a foreign node is no longer detected", "    if (false) return node;"],
      [
        "a constructed node counts as foreign",
        "    if (file !== src) return node;",
      ],
      [
        "only the top node is checked, never a foreign child",
        "    if (file !== undefined && file !== src) return undefined;",
      ],
    ),
    {
      what: "a foreign expansion is spliced in rather than refused",
      from: `      return { code, spans, diagnostics };${AFTER_REFUSAL}`,
      to: `      /* fall through */${AFTER_REFUSAL}`,
    },
    {
      what:
        "the file name never reaches the parse, so every tsx file is read as ts",
      from: '  const fileName = options.fileName ?? "loitsu.ts";',
      to: '  const fileName = "loitsu.ts";',
    },

    {
      what: "leaves also collects nodes that have children",
      from: "  if (children === 0) into.add(node);",
      to: "  into.add(node);",
    },
    {
      what: "render skips the byte comparison",
      from:
        "if (text.slice(f.outStart, f.outStart + f.length) !== from) continue;",
      to: "",
    },
    {
      what: "splice drops the text before the replacement",
      from:
        "if (from > 0) spans.push({ outStart: 0, length: from, inStart: 0 });",
      to: "",
    },
    {
      what: "splice drops the text after the replacement",
      from:
        "spans.push({ outStart: after, length: text.length - to, inStart: to });",
      to: "",
    },
    {
      what: "splice anchors the replacement at zero",
      from: "outStart: from + s.outStart,",
      to: "outStart: s.outStart,",
    },
    {
      what: "splice measures the tail from the old end",
      from: "const after = from + replacement.text.length;",
      to: "const after = to;",
    },
    {
      what: "next picks the outermost invocation",
      from: "use.start > pick.start",
      to: "use.start < pick.start",
    },
    {
      what: "next takes an unknown name as a macro",
      from: '    if (!known || use.form === "dangling") continue;',
      to: NEVER_CONTINUE,
    },
    ...ways(
      "spans = compose(spans, spliced.spans);",
      [
        "expand composes the rounds backwards",
        "spans = compose(spliced.spans, spans);",
      ],
      ["expand keeps only the last round's map", "spans = spliced.spans;"],
    ),
    {
      what: "expand replaces the attribute but not its item",
      from: ITEM_END,
      to: "to = use.end;",
    },
    {
      what: "expand leaves the attribute behind",
      from: `from = use.start;\n      ${ITEM_END}`,
      to: `from = use.target.getStart(src);\n      ${ITEM_END}`,
    },
    {
      what: "the round limit never trips",
      from: "round < rounds;",
      to: "round < rounds * 1000;",
    },
  ],

  "src/rpc.ts": [
    ...ways(
      "      if (hay[at + i] !== needle[i]) continue outer;",
      [
        "every byte compares equal, so a separator is found at the first offset",
        "      if (false) continue outer;",
      ],
    ),
    ...ways(
      "  outer: for (let at = from; at + needle.length <= hay.length; at++) {",
      [
        "a separator ending exactly at the buffer's end is not found",
        "  outer: for (let at = from; at + needle.length < hay.length; at++) {",
      ],
    ),
    ...ways(
      "const LENGTH = /^content-length$/i;",
      [
        "the length field is matched case-sensitively",
        "const LENGTH = /^content-length$/;",
      ],
    ),
    ...ways(
      "    if (!LENGTH.test(line.slice(0, at).trim())) continue;",
      [
        "any header field is read as the length, so Content-Type decides it",
        NEVER_CONTINUE,
      ],
    ),
    ...ways(
      "    if (!/^[0-9]+$/.test(said)) {",
      [
        "a length that is not a plain count is passed to Number and believed",
        NEVER_IN,
      ],
    ),
    ...ways(
      '  throw new FramingError("a header block carried no content-length");',
      [
        "a header with no length reads a body of nothing instead of refusing",
        "  return 0;",
      ],
    ),
    ...ways(
      "      if (this.#held.length - from < length) return out;",
      [
        "a body that has not all arrived is decoded anyway",
        "      if (false) return out;",
      ],
      [
        "a body that has exactly arrived is held back forever",
        "      if (this.#held.length - from <= length) return out;",
      ],
    ),
    ...ways(
      "      this.#held = this.#held.slice(from + length);",
      [
        "the body is left in the buffer, so the next drain reads it as a header",
        "      this.#held = this.#held.slice(from);",
      ],
    ),
    ...ways(
      "      const body = this.#decoder.decode(\n        this.#held.subarray(from, from + length),\n      );",
      [
        "the decode runs past the body into whatever followed it",
        "      const body = this.#decoder.decode(this.#held.subarray(from));",
      ],
    ),
    ...ways(
      "    grown.set(chunk, this.#held.length);",
      [
        "a new chunk overwrites what was held instead of following it",
        "    grown.set(chunk, 0);",
      ],
    ),
    ...ways(
      `${WROTE}\\r\\n\\r\\n\`,`,
      [
        "the written count is utf-16 units rather than bytes",
        "    `Content-Length: ${JSON.stringify(message).length}\\r\\n\\r\\n`,",
      ],
      [
        "the written header block ends in bare newlines",
        `${WROTE}\\n\\n\`,`,
      ],
    ),
    ...ways(
      "  if (frames.pending > 0) {",
      [
        "a stream ending mid-message is treated as having ended cleanly",
        NEVER_TOP,
      ],
    ),
  ],

  "src/protocol.ts": [
    ...ways(
      '    typeof value.character === "number";',
      [
        "a line alone is read as a position, so an offset pair becomes one",
        "    true;",
      ],
    ),
    ...ways(
      "  return isRecord(value) && isPosition(value.start) && isPosition(value.end);",
      [
        "the two names alone make a range, whatever sits under them",
        '  return isRecord(value) && "start" in value && "end" in value;',
      ],
    ),
    ...ways(
      "  if (isRange(value)) {",
      [
        "a range crosses as its two ends separately rather than as a run",
        NEVER_TOP,
      ],
    ),
    ...ways(
      "    return crossing.range(value, uri) ?? DROPPED;",
      [
        "a range with no image is kept as it was instead of dropped",
        "    return crossing.range(value, uri) ?? value;",
      ],
    ),
    ...ways(
      "  if (isPosition(value)) return crossing.point(value, uri) ?? DROPPED;",
      [
        "a position with no image is kept as it was instead of dropped",
        "  if (isPosition(value)) return crossing.point(value, uri) ?? value;",
      ],
    ),
    ...ways(
      "      if (crossed !== DROPPED) out.push(crossed);",
      [
        "a dropped element is kept, so the marker itself lands in the message",
        "      out.push(crossed);",
      ],
    ),
    ...ways(
      "    if (crossed === DROPPED) return DROPPED;",
      [
        "dropping does not climb out of the object it happened in",
        "    if (false) return DROPPED;",
      ],
    ),
    ...ways(
      '  const here = typeof value.uri === "string" ? value.uri : uri;',
      [
        "a document naming itself is ignored for everything under it",
        "  const here = uri;",
      ],
      [
        "the ambient document is dropped rather than carried down",
        '  const here = typeof value.uri === "string" ? value.uri : undefined;',
      ],
    ),
    ...ways(
      '    const crossed = key === "changes" && isChanges(one)',
      [
        "a workspace edit's keys stop naming the documents they edit",
        "    const crossed = false && isChanges(one)",
      ],
      [
        "anything called changes is treated as a map of documents to edits",
        '    const crossed = key === "changes"',
      ],
    ),
    ...ways(
      "    const crossed = carry(edits, crossing, uri) as unknown[];",
      [
        "an edit list is crossed without knowing which document it edits",
        "    const crossed = carry(edits, crossing, undefined) as unknown[];",
      ],
    ),
    ...ways(
      "    if (crossed.length === 0) continue;",
      [
        "a file whose edits all dropped still gets an empty entry, so an editor " +
        "opens it to change nothing",
        NEVER_CONTINUE,
      ],
    ),
    ...ways(
      "  return isRecord(value) && Object.values(value).every(Array.isArray);",
      [
        "a changes field whose values are not edit lists is read as one anyway",
        "  return isRecord(value);",
      ],
    ),
    ...ways(
      "  if (Array.isArray(value)) {",
      [
        "a list is walked as an object, so nothing absorbs a drop",
        NEVER_TOP,
      ],
    ),
  ],
};

const [target, ...suite] = Deno.args;
if (target === undefined || suite.length === 0) {
  console.error("usage: mutate.ts <source file> <test file>...");
  Deno.exit(2);
}
const plan = PLANS[target];
if (plan === undefined) throw new Error(`no mutations listed for ${target}`);

const run = async (): Promise<number> =>
  (await new Deno.Command(Deno.execPath(), {
    // `--unstable-worker-options` is what lets a worker be spawned with a
    // permission set at all, and the sandbox suite is nothing without it. It is
    // on the package's own test task for the same reason, so a run here that
    // omitted it would report a red baseline rather than a result.
    args: ["test", "-A", "--quiet", "--unstable-worker-options", ...suite],
    stdout: "null",
    stderr: "null",
  }).output()).code;

// The baseline, because every mutation is reported caught when the suite is already
// failing, and the run then looks like a clean sweep. This cost an afternoon once.
if (await run() !== 0) {
  console.error(
    `${suite.join(" ")} is already failing; a mutation run against a red`,
  );
  console.error("suite reports every mutation caught and measures nothing");
  Deno.exit(2);
}

/** Held for the length of a run, so two of them cannot mutate at once.
 *
 * `createNew` is the whole mechanism: it fails when the file is there, which makes
 * taking the lock and finding it taken one operation with no window between them.
 *
 * `MUTATE_LOCK` moves it, which is how the suite exercises the refusal without
 * being granted write over the repository it is testing. */
const LOCK = Deno.env.get("MUTATE_LOCK") ?? ".mutate.lock";
try {
  await Deno.writeTextFile(LOCK, `${Deno.pid}\n`, { createNew: true });
} catch (err) {
  if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  console.error(
    `${LOCK} is held, so a mutation run is already editing the tree. Wait for it,`,
  );
  console.error("or delete the lock if nothing is running.");
  Deno.exit(3);
}

const original = await Deno.readTextFile(target);
const survived: string[] = [];
try {
  for (const m of plan) {
    if (!original.includes(m.from)) {
      throw new Error(
        `the mutation "${m.what}" searches for text that is not in ${target}; ` +
          "a pattern that matches nothing tests nothing and would report itself caught",
      );
    }
    await Deno.writeTextFile(target, original.replace(m.from, m.to));
    const code = await run();
    if (code === 0) survived.push(m.what);
    console.log(`${code === 0 ? "SURVIVED" : "caught  "}  ${m.what}`);
  }
} finally {
  await Deno.writeTextFile(target, original);
  await Deno.remove(LOCK);
}

console.log(`\n${survived.length} survived of ${plan.length}`);
if (survived.length > 0) Deno.exit(1);
