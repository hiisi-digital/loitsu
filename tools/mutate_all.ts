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
  ["src/install.ts", ["tests/install_test.ts"]],
  ["src/syntax.ts", ["tests/watch_test.ts", "tests/install_test.ts"]],
  ["src/position.ts", ["tests/position_test.ts", "tests/translate_test.ts"]],
  ["src/translate.ts", ["tests/translate_test.ts"]],
  ["src/rpc.ts", ["tests/rpc_test.ts"]],
  ["src/protocol.ts", ["tests/protocol_test.ts"]],
  ["src/documents.ts", ["tests/documents_test.ts"]],
  ["src/server.ts", ["tests/server_test.ts"]],
  ["tests/readme_test.ts", ["tests/readme_test.ts"]],
  ["tests/sandbox_worker.ts", ["tests/sandbox_test.ts"]],
  ["tests/sandbox_read_worker.ts", ["tests/sandbox_test.ts"]],
  ["tests/sandbox_run_worker.ts", ["tests/sandbox_test.ts"]],
];

/** Every file `tools/mutate.ts` carries a plan for.
 *
 * The list above is written by hand and the note on it says a plan not listed is
 * never swept. That note is not a mechanism, and it did not hold: five plans sat
 * outside the sweep while it reported clean. So the two are compared here, and a
 * plan missing from the sweep stops the run rather than being quietly skipped.
 */
async function planned(): Promise<string[]> {
  const source = await Deno.readTextFile("tools/mutate.ts");
  const start = source.indexOf("const PLANS");
  return [...source.slice(start).matchAll(/^  "([^"]+)": \[$/gm)]
    .map((m) => m[1]!);
}

const missing = (await planned()).filter(
  (one) => !SWEEP.some(([source]) => source === one),
);
if (missing.length > 0) {
  console.error(
    `these have a plan and are not swept: ${missing.join(", ")}`,
  );
  Deno.exit(2);
}

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
