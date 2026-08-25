//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/** Finding the project a runtime should be set up for.
 *
 * The search is the part worth pinning. A program is run from wherever somebody
 * happens to be standing, so an exact match on the working directory finds a
 * config only by luck, and one that climbs past the filesystem root climbs
 * forever. Both are here, with the refusal that says so when there is nothing.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, resolve } from "@std/path";
import { CONFIG, project } from "../cli/project.ts";
import { register, RegisterError, rootFrom } from "../register.ts";

/** A tree with a config at its root and a few levels under it. */
async function tree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "loitsu_reg_" });
  await Deno.writeTextFile(join(root, CONFIG), "export default {};\n");
  await Deno.mkdir(join(root, "src", "deep", "deeper"), { recursive: true });
  return root;
}

Deno.test("a config in the directory itself is found", async () => {
  const root = await tree();
  try {
    // resolved, not realpathed: following a symlink here could walk out of the
    // project somebody is standing in
    assertEquals(await rootFrom(root), resolve(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a config above the directory is found, however deep", async () => {
  const root = await tree();
  try {
    const real = resolve(root);
    for (const at of ["src", "src/deep", "src/deep/deeper"]) {
      assertEquals(
        await rootFrom(join(root, at)),
        real,
        `climbing from ${at} has to reach the root`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a tree with no config anywhere gives nothing rather than climbing forever", async () => {
  const bare = await Deno.makeTempDir({ prefix: "loitsu_bare_" });
  try {
    // the control: the same call finds one when there is one, so this is about
    // the absence rather than about the search being broken
    assertEquals(await rootFrom(bare), undefined);
    await Deno.writeTextFile(join(bare, CONFIG), "export default {};\n");
    assert(await rootFrom(bare) !== undefined);
  } finally {
    await Deno.remove(bare, { recursive: true });
  }
});

Deno.test("the nearest config wins, not the highest", async () => {
  const root = await tree();
  try {
    const inner = join(root, "src", "deep");
    await Deno.writeTextFile(join(inner, CONFIG), "export default {};\n");
    assertEquals(
      await rootFrom(join(root, "src", "deep", "deeper")),
      resolve(inner),
      "a project inside a project is its own project",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("registering where there is no project says so, naming what it looked for", async () => {
  const bare = await Deno.makeTempDir({ prefix: "loitsu_none_" });
  try {
    const why = await assertRejects(() => register(bare), RegisterError);
    assertStringIncludes(why.message, CONFIG);
    assertStringIncludes(why.message, "no macros to install");
  } finally {
    await Deno.remove(bare, { recursive: true });
  }
});

Deno.test("registering against a config that exports nothing usable is refused", async () => {
  const root = await tree();
  try {
    // the config is found; what it holds is the project loader's business, and
    // the refusal has to reach the caller rather than being swallowed here
    await assertRejects(() => register(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a config that cannot be read is not reported as one that is not there", async () => {
  const root = await Deno.makeTempDir({ prefix: "loitsu_perm_" });
  try {
    const shut = join(root, "shut");
    await Deno.mkdir(shut);
    await Deno.writeTextFile(join(shut, CONFIG), "export default {};\n");
    // the control first: while it is readable, it is found
    assertEquals(await rootFrom(shut), resolve(shut));

    await Deno.chmod(shut, 0o000);
    try {
      // a permission error is not absence. Climbing past it and reporting "no
      // config above here" says the file is missing when it is right there.
      let said: unknown;
      try {
        await rootFrom(shut);
      } catch (why) {
        said = why;
      }
      assert(
        said !== undefined,
        "a stat that failed for a reason other than absence has to reach the caller",
      );
    } finally {
      await Deno.chmod(shut, 0o755);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a config that is there but will not load says so, not that it is missing", async () => {
  const root = await Deno.makeTempDir({ prefix: "loitsu_bad_" });
  try {
    // the most common first run on node is exactly this: the file exists and the
    // runtime refuses it. Reporting that as "no config here" sends somebody
    // looking for a file they are staring at.
    await Deno.writeTextFile(
      join(root, CONFIG),
      "this is not typescript {{{\n",
    );
    const why = await assertRejects(() => project(root));
    assertStringIncludes(String(why), "is there and would not load");
    assert(
      !String(why).includes(`no ${CONFIG} at`),
      "a config that exists must not be reported as absent",
    );

    // the control: with no file at all, it does say that
    const bare = await Deno.makeTempDir({ prefix: "loitsu_none2_" });
    try {
      const gone = await assertRejects(() => project(bare));
      assertStringIncludes(String(gone), `no ${CONFIG} at`);
    } finally {
      await Deno.remove(bare, { recursive: true });
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
