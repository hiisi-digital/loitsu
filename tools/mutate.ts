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
}

console.log(`\n${survived.length} survived of ${plan.length}`);
if (survived.length > 0) Deno.exit(1);
