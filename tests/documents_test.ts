//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * What the editor holds against what the inner server was handed, and the two
 * crossings between them.
 *
 * Everything here runs against an injected reader and a real expansion. The
 * macro is the same `cfg` the watcher's tests use: it keeps its item for one
 * target and drops it for the other, which is the smallest thing that makes a
 * twin differ from its source in a way positions can be measured across.
 */

import ts from "typescript";
import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Documents } from "../src/documents.ts";
import { registry } from "../src/macro.ts";
import { macros, named } from "./macro_helpers.ts";
import type { Position, Range } from "../src/position.ts";

const HERE = toFileUrl("/proj/src/a.ts").href;

function documents(files: Record<string, string> = {}): Documents {
  return new Documents({
    registry: macros(),
    against: "test",
    cacheDir: undefined,
    read: (path) => {
      const held = files[path];
      if (held === undefined) {
        return Promise.reject(new Deno.errors.NotFound(path));
      }
      return Promise.resolve(held);
    },
  });
}

const at = (line: number, character: number): Position => ({ line, character });
const span = (a: Position, b: Position): Range => ({ start: a, end: b });

/**
 * A file the way one actually looks: ordinary code the macro never touches, then
 * one statement it keeps and one it drops.
 *
 * The ordinary code is the part that matters for the crossings. A statement a
 * macro touched is reprinted, so only its identifiers and literals carry spans;
 * everything the expansion left alone is copied and maps byte for byte. A test
 * file made entirely of macro uses measures the reprinted case and calls it the
 * general one.
 */
const BOTH = `export function untouched(who: string): string {\n` +
  `  return \`hei \${who}\`;\n}\n\n` +
  `[cfg(deno)]\nfunction kept() {\n  return 1;\n}\n` +
  `[cfg(node)]\nfunction gone() {\n  return 2;\n}\n`;

Deno.test("opening a document", async (t) => {
  await t.step(
    "builds a twin from what the editor holds, not from disk",
    async () => {
      // The control the whole arrangement rests on. Disk says one thing, the
      // editor says another, and the twin has to come from the editor: a buffer
      // and a file disagree for as long as anything is unsaved.
      const docs = documents({
        "/proj/src/a.ts": `[cfg(deno)]\nfunction ondisk() {}\n`,
      });
      const open = await docs.changed(HERE, 1, BOTH);

      assert(open.twin.includes("kept"), open.twin);
      assertEquals(open.twin.includes("ondisk"), false);
    },
  );

  await t.step(
    "drops what the macro dropped, so the twin is shorter",
    async () => {
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      assert(open.twin.includes("kept"));
      assertEquals(open.twin.includes("gone"), false);
      assert(open.twin.length < open.source.length, `${open.twin.length}`);
    },
  );

  await t.step(
    "carries the uri, its path and the editor's version",
    async () => {
      const docs = documents();
      const open = await docs.changed(HERE, 7, BOTH);

      assertEquals(open.uri, HERE);
      assertEquals(open.path, "/proj/src/a.ts");
      assertEquals(open.version, 7);
      assertEquals(open.source, BOTH);
    },
  );

  await t.step("a second change replaces the first", async () => {
    const docs = documents();
    await docs.changed(HERE, 1, BOTH);
    const later = await docs.changed(
      HERE,
      2,
      `[cfg(deno)]\nfunction renamed() {}\n`,
    );

    assertEquals(docs.get(HERE)?.version, 2);
    assert(later.twin.includes("renamed"), later.twin);
    assertEquals(later.twin.includes("kept"), false);
  });

  await t.step("a document nobody opened is not there", () => {
    assertEquals(documents().get(HERE), undefined);
    assertEquals(documents().uris, []);
  });

  await t.step("closing forgets the document and its buffer", async () => {
    const docs = documents();
    const open = await docs.changed(HERE, 1, BOTH);
    assertEquals(docs.uris, [HERE]);
    assertEquals(docs.buffered, [open.path]);

    docs.closed(HERE);

    assertEquals(docs.get(HERE), undefined);
    assertEquals(docs.uris, []);
    // The buffer goes too, not just the entry that names it. An editor session
    // opens thousands of files and keeping them would be a leak nothing else
    // here would notice.
    assertEquals(docs.buffered, []);
  });

  await t.step("closing something never opened is not an error", () => {
    const docs = documents();
    docs.closed(HERE);
    assertEquals(docs.uris, []);
  });
});

/** A registry whose macro throws, which is how a twin genuinely fails to build:
 * a macro is ordinary code and ordinary code throws. */
function throwing() {
  return registry([{
    kind: "attribute",
    name: "cfg",
    expand: () => {
      throw new Error("the macro gave up");
    },
    // deno-lint-ignore no-explicit-any
  } as any]);
}

Deno.test("a source the expansion could not build a twin for", async (t) => {
  await t.step("stands in for itself, under an identity map", async () => {
    // Not a good state, and the alternative is worse: refusing to forward would
    // leave the editor with no server at all for as long as a macro is broken,
    // which is exactly while somebody is mid-edit on that macro.
    const docs = new Documents({
      registry: throwing(),
      against: "test",
      cacheDir: undefined,
      read: () => Promise.reject(new Deno.errors.NotFound("nothing on disk")),
    });
    const open = await docs.changed(HERE, 1, BOTH);

    assertEquals(open.twin, BOTH);
    assertEquals(open.mapping.toTwin(at(1, 3)), [at(1, 3)]);
    assertEquals(open.mapping.toSource(at(1, 3)), at(1, 3));
    assertEquals(
      docs.down.range(span(at(1, 0), at(1, 8)), HERE),
      span(at(1, 0), at(1, 8)),
    );
  });

  await t.step(
    "says why, rather than pretending nothing went wrong",
    async () => {
      // The editor is showing a file whose macros did not run. Standing in for the
      // twin keeps the server answering; this is what lets the caller say so.
      const docs = new Documents({
        registry: throwing(),
        against: "test",
        cacheDir: undefined,
        read: () => Promise.reject(new Deno.errors.NotFound("nothing on disk")),
      });
      await docs.changed(HERE, 1, BOTH);

      const why = docs.failure(HERE);
      assert(why !== undefined, "a macro that threw should be reported");

      // And closing lets go of it, so a file opened again is asked afresh rather
      // than answered from a failure nobody has retried.
      docs.closed(HERE);
      assertEquals(docs.failure(HERE), undefined);
    },
  );

  await t.step("reports no failure when every macro ran", async () => {
    const docs = documents();
    await docs.changed(HERE, 1, BOTH);
    assertEquals(docs.failure(HERE), undefined);
  });

  await t.step("a working macro is the control for that", async () => {
    // Without this the case above passes against a Documents that never builds
    // a twin at all, which is the same observable result.
    const docs = documents();
    const open = await docs.changed(HERE, 1, BOTH);
    assertEquals(open.twin === BOTH, false);
  });

  await t.step("an empty document does not throw", async () => {
    const docs = documents();
    const open = await docs.changed(HERE, 1, "");
    assertEquals(open.twin, "");
  });
});

Deno.test("crossing down, from what the author wrote", async (t) => {
  await t.step(
    "a range in kept text lands on the same text in the twin",
    async () => {
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      const line = open.source.split("\n").indexOf("function kept() {");
      const from = open.source.split("\n")[line]!.indexOf("kept");
      const where = docs.down.range(
        span(at(line, from), at(line, from + 4)),
        HERE,
      );

      assert(where !== undefined, "kept should have an image in the twin");
      assertEquals(open.mapping.textOf(open.mapping.twin, where), "kept");
    },
  );

  await t.step(
    "a range in text the expansion deleted lands nowhere",
    async () => {
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      const line = open.source.split("\n").indexOf("function gone() {");
      const from = open.source.split("\n")[line]!.indexOf("gone");
      assertEquals(
        docs.down.range(span(at(line, from), at(line, from + 4)), HERE),
        undefined,
      );
    },
  );

  await t.step(
    "a bare position moves, and lands where the same range would",
    async () => {
      // A position on its own is not a range of length nothing: the protocol
      // walk hands it to `point`, and nothing else in this file exercises that
      // arm at a coordinate the expansion actually shifts.
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      const line = open.source.split("\n").indexOf("function kept() {");
      const from = open.source.split("\n")[line]!.indexOf("kept");
      const where = docs.down.point(at(line, from), HERE);

      assert(where !== undefined, "kept should have an image in the twin");
      assert(
        where.line !== line,
        "the attribute line above it is gone from the twin, so the line moves",
      );
      assertEquals(
        where,
        docs.down.range(span(at(line, from), at(line, from + 4)), HERE)?.start,
      );
    },
  );

  await t.step("a document this does not hold crosses unchanged", async () => {
    // A location in another file is not this layer's to move, and answering
    // `undefined` would drop it out of a rename that legitimately touches it.
    const docs = documents();
    await docs.changed(HERE, 1, BOTH);
    const elsewhere = toFileUrl("/proj/src/other.ts").href;
    const range = span(at(3, 1), at(3, 5));

    assertEquals(docs.down.range(range, elsewhere), range);
    assertEquals(docs.down.point(at(3, 1), elsewhere), at(3, 1));
    assertEquals(docs.down.range(range, undefined), range);
  });
});

Deno.test("crossing up, back onto what the author wrote", async (t) => {
  await t.step(
    "a twin range comes back onto the text it came from",
    async () => {
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      const line = open.twin.split("\n").findIndex((one) =>
        one.includes("kept")
      );
      const from = open.twin.split("\n")[line]!.indexOf("kept");
      const back = docs.up.range(
        span(at(line, from), at(line, from + 4)),
        HERE,
      );

      assert(back !== undefined);
      assertEquals(open.mapping.textOf(open.mapping.source, back), "kept");
    },
  );

  await t.step(
    "a bare position moves back, and lands where the same range would",
    async () => {
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      const line = open.twin.split("\n").findIndex((one) =>
        one.includes("kept")
      );
      const from = open.twin.split("\n")[line]!.indexOf("kept");
      const back = docs.up.point(at(line, from), HERE);

      assert(back !== undefined, "the twin's kept came from somewhere");
      assert(
        back.line !== line,
        "the source carries an attribute line the twin does not, so it moves",
      );
      assertEquals(
        back,
        docs.up.range(span(at(line, from), at(line, from + 4)), HERE)?.start,
      );
    },
  );

  await t.step("a document this does not hold crosses unchanged", async () => {
    const docs = documents();
    await docs.changed(HERE, 1, BOTH);
    const elsewhere = toFileUrl("/proj/src/other.ts").href;
    const range = span(at(0, 0), at(0, 3));

    assertEquals(docs.up.range(range, elsewhere), range);
    assertEquals(docs.up.point(at(0, 0), elsewhere), at(0, 0));
  });

  await t.step(
    "down then up is where it started, at every position with an image",
    async () => {
      // Exhaustive rather than one sampled position. Each direction could be
      // wrong in a way the other undoes, and picking one offset to check is
      // picking the one that happens to work.
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);
      const lines = open.source.split("\n");
      let crossed = 0;
      for (let line = 0; line < lines.length; line++) {
        for (let character = 0; character <= lines[line]!.length; character++) {
          const where = at(line, character);
          const [image] = open.mapping.toTwin(where);
          if (image === undefined) continue;
          crossed++;
          assertEquals(
            open.mapping.toSource(image),
            where,
            `${line}:${character} did not come back`,
          );
        }
      }
      assert(
        crossed > 20,
        `only ${crossed} positions crossed, so this proves little`,
      );
    },
  );

  await t.step(
    "and many positions have none, which is what makes that a test",
    async () => {
      // The control for the count above. Without it the exhaustive check passes
      // against a mapping that answers every position with itself.
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);
      const lines = open.source.split("\n");
      let missing = 0;
      for (let line = 0; line < lines.length; line++) {
        for (let character = 0; character <= lines[line]!.length; character++) {
          if (open.mapping.toTwin(at(line, character)).length === 0) missing++;
        }
      }
      assert(missing > 20, `only ${missing} positions had no image`);
    },
  );
});

Deno.test("every image a range has", async (t) => {
  await t.step("kept text has one", async () => {
    const docs = documents();
    const open = await docs.changed(HERE, 1, BOTH);

    const line = open.source.split("\n").indexOf("function kept() {");
    const from = open.source.split("\n")[line]!.indexOf("kept");
    assertEquals(
      docs.images(HERE, span(at(line, from), at(line, from + 4))).length,
      1,
    );
  });

  await t.step(
    "deleted text has none, which is what a request there gets",
    async () => {
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      const line = open.source.split("\n").indexOf("function gone() {");
      const from = open.source.split("\n")[line]!.indexOf("gone");
      assertEquals(
        docs.images(HERE, span(at(line, from), at(line, from + 4))),
        [],
      );
    },
  );

  await t.step(
    "a document this does not hold answers with the range itself",
    async () => {
      const docs = documents();
      const range = span(at(0, 0), at(0, 3));
      assertEquals(docs.images(toFileUrl("/proj/src/other.ts").href, range), [
        range,
      ]);
    },
  );

  await t.step(
    "what down answers is the first of what images answers",
    async () => {
      // The two have to agree, or a read request and an edit request disagree
      // about where the same authored range is.
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);

      const line = open.source.split("\n").indexOf("  return 1;");
      const range = span(at(line, 2), at(line, 9));
      assertEquals(docs.down.range(range, HERE), docs.images(HERE, range)[0]);
    },
  );
});

Deno.test("how much of a source has an image at all", async (t) => {
  /** Every source offset the mapping answers with something, as a fraction. */
  function covered(
    open: { source: string; mapping: { toTwin: (at: Position) => Position[] } },
  ): number {
    const lines = open.source.split("\n");
    let hit = 0, total = 0;
    for (let line = 0; line < lines.length; line++) {
      for (let character = 0; character < lines[line]!.length; character++) {
        total++;
        if (open.mapping.toTwin(at(line, character)).length > 0) hit++;
      }
    }
    return hit / total;
  }

  await t.step("code no macro touched maps almost entirely", async () => {
    // The expansion copies a statement it did not touch, so it comes back byte
    // for byte and the whole of it carries spans. This is the ordinary case and
    // it is what makes hovering anywhere in a file work.
    const docs = documents();
    const open = await docs.changed(
      HERE,
      1,
      `export function untouched(who: string): string {\n  return \`hei \${who}\`;\n}\n`,
    );
    assert(covered(open) > 0.95, `${covered(open)}`);
  });

  await t.step(
    "a statement a macro touched keeps only its names and literals",
    async () => {
      // Reprinted rather than copied, so its keywords, punctuation and the
      // printer's own spacing carry nothing. Pinned because it is a limit rather
      // than a bug: a hover on `function` inside a macro's item finds nothing,
      // and a hover on the name beside it works.
      const docs = documents();
      const open = await docs.changed(
        HERE,
        1,
        `[cfg(deno)]\nfunction kept() {\n  return 1;\n}\n`,
      );
      const fraction = covered(open);
      assert(
        fraction > 0,
        `nothing at all mapped, which is a different defect`,
      );
      assert(
        fraction < 0.4,
        `${fraction} is high enough that the reprint stopped happening`,
      );

      // And the names are what survived, which is the half that has to work.
      const line = open.source.split("\n").indexOf("function kept() {");
      const from = open.source.split("\n")[line]!.indexOf("kept");
      assertEquals(open.mapping.toTwin(at(line, from)).length, 1);
      assertEquals(open.mapping.toTwin(at(line, 0)), []);
    },
  );

  await t.step(
    "one macro use does not cost the rest of the file its map",
    async () => {
      // The claim that matters, and the reason a whole-file fraction is the wrong
      // measurement for it: that number moves with how much of the fixture is
      // macro, not with whether the untouched part still answers. So the
      // assertion runs over the untouched lines of a file that also carries
      // macros, and a whole-file reprint would fail it.
      const docs = documents();
      const open = await docs.changed(HERE, 1, BOTH);
      const lines = open.source.split("\n");
      const last = lines.indexOf("}");
      assert(last > 0, "the fixture should open with an untouched function");

      for (let line = 0; line <= last; line++) {
        for (let character = 0; character < lines[line]!.length; character++) {
          assertEquals(
            open.mapping.toTwin(at(line, character)).length > 0,
            true,
            `${line}:${character} in untouched code has no image`,
          );
        }
      }
    },
  );
});
