//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * Whether the readme's examples are true.
 *
 * A readme is the first thing anyone reads and nothing else in a suite touches
 * it, so an example goes stale the first time a signature moves and stays that
 * way until somebody tries it. Type checking each block against the real module
 * catches a renamed export, a changed argument order and an argument that no
 * longer exists, which is most of the ways one rots.
 *
 * Blocks marked `ts` are checked. A `bash` block is not code this can compile
 * and is skipped, and so is a block that imports a file of its own: those show
 * what a macro's own module looks like to whoever wrote it, not a use of this
 * package. Both counts are asserted, so a block cannot leave the checked set
 * unnoticed.
 *
 * The checked blocks are read as one program, in the order they appear, because
 * that is how the readme reads: a later block uses names an earlier one bound.
 * Each is checked with everything before it prepended, so a block that only
 * works in isolation fails here, which is the point.
 *
 * @module
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Every fenced block in the readme carrying the given language tag. */
function blocks(markdown: string, language: string): string[] {
  const found: string[] = [];
  const fence = new RegExp("^```" + language + "\\s*$");
  let collecting: string[] | undefined;
  for (const line of markdown.split("\n")) {
    if (collecting === undefined) {
      if (fence.test(line.trim())) collecting = [];
      continue;
    }
    if (line.trim() === "```") {
      found.push(collecting.join("\n"));
      collecting = undefined;
      continue;
    }
    collecting.push(line);
  }
  return found;
}

/** Type checks one block as a module, importing the package the way the readme
 * says to. The import specifier in the block points at the published name, which
 * does not resolve from inside the repository, so it is rewritten to the local
 * entry point. That substitution is the one liberty taken here. The package's own
 * config is passed along so its bare specifiers resolve the way they do when it
 * is built. */
async function checks(source: string): Promise<{ ok: boolean; why: string }> {
  const dir = await Deno.makeTempDir({ prefix: "loitsu-readme-" });
  try {
    const entry = join(ROOT, "mod.ts");
    const rewritten = source.replace(
      /from "(jsr:@hiisi\/loitsu|@hiisi\/loitsu)"/g,
      `from "${entry}"`,
    );
    const file = join(dir, "block.ts");
    await Deno.writeTextFile(file, rewritten);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--quiet", "--config", join(ROOT, "deno.json"), file],
      stdout: "null",
      stderr: "piped",
    }).output();
    return { ok: code === 0, why: new TextDecoder().decode(stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** One program from several blocks, with the imports merged.
 *
 * A reader arriving at a section partway down needs its import line, so the same
 * name is imported by more than one block. Concatenated they are a duplicate
 * identifier, which says nothing about whether the examples are true. So the
 * import lines are lifted out, a name already bound is dropped, and the rest of
 * each block follows in the order it was written.
 */
function asOneProgram(examples: readonly string[]): string {
  const bound = new Set<string>();
  const imports: string[] = [];
  const bodies: string[] = [];
  for (const example of examples) {
    for (const line of example.split("\n")) {
      if (!line.startsWith("import ")) {
        bodies.push(line);
        continue;
      }
      const named = line.match(
        /^import (type )?\{([^}]*)\} from ("[^"]*");/,
      );
      if (named !== null) {
        const fresh = named[2]!.split(",").map((one) => one.trim())
          .filter((one) => one.length > 0 && !bound.has(one));
        for (const one of fresh) bound.add(one);
        if (fresh.length > 0) {
          imports.push(
            `import ${named[1] ?? ""}{ ${fresh.join(", ")} } from ${named[3]};`,
          );
        }
        continue;
      }
      const plain = line.match(/^import (\w+) from ("[^"]*");/);
      assert(plain !== null, `readme import not understood: ${line}`);
      if (!bound.has(plain![1]!)) {
        bound.add(plain![1]!);
        imports.push(`import ${plain![1]} from ${plain![2]};`);
      }
    }
  }
  return [...imports, ...bodies].join("\n");
}

/** Whether a block reaches for a file beside itself rather than for this
 * package. Those are authored input, shown as a reader would write it. */
function importsItsOwn(source: string): boolean {
  return /from ["']\.\.?\//.test(source);
}

Deno.test("every ts example in the readme type checks, read as one program", async () => {
  const markdown = await Deno.readTextFile(join(ROOT, "README.md"));
  const examples = blocks(markdown, "ts");

  // Without this the test passes on a readme whose fences were all renamed, or
  // on a regex that stopped matching, and reports that everything checks out.
  assert(
    examples.length >= 6,
    `expected the readme to carry ts examples, found ${examples.length}`,
  );

  const own = examples.filter(importsItsOwn);
  const api = examples.filter((one) => !importsItsOwn(one));

  // Both halves are pinned. A block sliding out of the checked half would
  // otherwise be indistinguishable from a block that was never there.
  assertEquals(own.length, 2, "the two blocks showing authored input");
  assertEquals(api.length, examples.length - 2);

  const before: string[] = [];
  for (const [at, example] of api.entries()) {
    before.push(example);
    const result = await checks(asOneProgram(before));
    assert(
      result.ok,
      `readme ts block ${at + 1} does not check after the ones before it:\n` +
        result.why,
    );
  }
});

Deno.test("the checker rejects an example that is wrong", async () => {
  // The control. Without it the test above passes against a checker that always
  // says yes, which is exactly what it would do if the rewrite silently produced
  // an empty file or the command's exit code stopped being read.
  const broken = await checks(
    'import { Lines } from "@hiisi/loitsu";\n' +
      "new Lines();\n",
  );
  assertEquals(broken.ok, false);

  const sound = await checks(
    'import { Lines } from "@hiisi/loitsu";\n' +
      'const _: number = new Lines("a").text.length;\n',
  );
  assertEquals(sound.ok, true, sound.why);
});

/** Every fence language a document uses. */
function tagsIn(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^```([a-zA-Z]+)\s*$/gm)].map((m) => m[1]!),
  );
}

/** Refuses a fence language nothing here knows how to treat. A misspelled tag
 * is a block nobody checks and nobody highlights, and it looks fine rendered. */
function refuseUnknownTags(tags: Iterable<string>): void {
  const known = new Set(["ts", "bash", "json", "jsonc", "toml"]);
  for (const tag of tags) {
    assert(known.has(tag), `unknown fence language in the readme: ${tag}`);
  }
}

Deno.test("the readme's fenced blocks are found, and the tags are the real ones", async () => {
  const markdown = await Deno.readTextFile(join(ROOT, "README.md"));
  const tags = tagsIn(markdown);
  refuseUnknownTags(tags);
  assert(tags.has("ts"));
  assert(tags.has("bash"));
});

Deno.test("a fence language nothing knows is refused, and the reason names it", () => {
  // The control for the check above. The readme has no bad tag in it, so without
  // this the refusal could be deleted and every test would still pass.
  assertEquals(
    tagsIn("```typescrpt\n```\n```ts\n```"),
    new Set(["typescrpt", "ts"]),
  );
  assertThrows(
    () => refuseUnknownTags(["typescrpt"]),
    Error,
    "unknown fence language in the readme: typescrpt",
  );
});

Deno.test("merging blocks keeps every statement and binds each name once", () => {
  // The control for the merge. Without it the check above would pass just as
  // happily on a merge that returned nothing, since an empty program type checks.
  const merged = asOneProgram([
    'import { Lines } from "@hiisi/loitsu";\nconst a = new Lines("x");',
    'import { Lines, negotiate } from "@hiisi/loitsu";\nconst b = negotiate([]);',
  ]);
  assertEquals(
    merged.split("\n").filter((one) => one.startsWith("import ")).length,
    2,
    "the second block's Lines is dropped, its negotiate is kept",
  );
  assertEquals(
    (merged.match(/Lines/g) ?? []).length,
    2,
    "imported once, used once",
  );
  assert(merged.includes("const a = "), "the first block's statement survives");
  assert(
    merged.includes("const b = "),
    "the second block's statement survives",
  );
});

Deno.test("an import shape the merge does not understand is a failure, not a skip", () => {
  // A namespace or side-effect import would otherwise vanish silently and take
  // whatever it bound with it, leaving the blocks checking against nothing.
  // The message is asserted, not merely that something threw: reading `[1]` off
  // a failed match throws too, so a check that only demanded a throw would pass
  // against no check at all.
  assertThrows(
    () => asOneProgram(['import * as ts from "typescript";']),
    Error,
    'readme import not understood: import * as ts from "typescript";',
  );
  assertThrows(
    () => asOneProgram(['import "./side-effect.ts";']),
    Error,
    'readme import not understood: import "./side-effect.ts";',
  );
});
