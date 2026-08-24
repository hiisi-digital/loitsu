//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Every mutation plan, in one command that fails loudly.
 *
 * Running the plans one at a time and reading the output for `SURVIVED` looks like
 * checking them and is not. A run that dies before it mutates anything prints no
 * `SURVIVED` line either, so the absence of one means either that every mutation was
 * caught or that nothing ran, and the two are indistinguishable at a glance. That
 * happened: a self-referential constant broke the harness and the empty output read
 * as a clean sweep.
 *
 * So this reads the exit code rather than the text, requires every plan to report a
 * total, and refuses to say anything is clean unless each one did.
 *
 * @module
 */

/** Which tests hold each source file's claims down. A plan whose suites are not
 * listed here is never swept, so adding a plan means adding a row. */
const SWEEP: readonly (readonly [string, readonly string[]])[] = [
  ["src/spans.ts", [
    "tests/spans_test.ts",
    "tests/compose_test.ts",
    "tests/reverse_test.ts",
  ]],
  ["src/sentinel.ts", ["tests/sentinel_test.ts"]],
  ["src/expand.ts", ["tests/expand_test.ts"]],
  ["src/cache.ts", ["tests/cache_test.ts"]],
  ["src/watch.ts", ["tests/watch_test.ts"]],
];

let survived = 0;
let mutations = 0;
let broke = false;

for (const [source, suites] of SWEEP) {
  const run = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "tools/mutate.ts", source, ...suites],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await run.output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);

  const total = text.match(/(\d+) survived of (\d+)/);
  if (out.code !== 0 || total === null) {
    // Not "no survivors". No answer at all, which is the case this file exists for.
    broke = true;
    console.error(`${source}: the plan did not run to a total`);
    console.error(text.trimEnd());
    continue;
  }

  for (const line of text.split("\n")) {
    if (line.includes("SURVIVED")) console.error(`${source}: ${line.trim()}`);
  }
  survived += Number(total[1]);
  mutations += Number(total[2]);
  console.log(`${source.padEnd(18)} ${total[0]}`);
}

console.log(
  `\n${survived} survived of ${mutations} across ${SWEEP.length} plans`,
);
if (broke) {
  console.error("\nat least one plan did not run; nothing here is a result");
  Deno.exit(2);
}
if (survived > 0) {
  console.error(
    "\na surviving mutation is a claim nothing holds down: constrain it or delete it",
  );
  Deno.exit(1);
}
