# `loitsu`

<div align="center" style="text-align: center;">

[![JSR](https://jsr.io/badges/@hiisi/loitsu)](https://jsr.io/@hiisi/loitsu)
[![GitHub Issues](https://img.shields.io/github/issues/hiisi-digital/loitsu.svg)](https://github.com/hiisi-digital/loitsu/issues)
![License](https://img.shields.io/github/license/hiisi-digital/loitsu?color=%23009689)

> Macros for TypeScript, in the two shapes the language actually admits.

</div>

An attribute is written above the thing it applies to:

```ts
import { cfg } from "./macros.ts";

[cfg("deno")];
export function readConfig(): string {
  return Deno.readTextFileSync("config.json");
}
```

An inline macro is written where an expression goes:

```ts
import { include_str } from "./macros.ts";

const banner = include_str!("banner.txt");
```

Both of those are ordinary TypeScript. They type-check, they survive the
formatter, the linter has no opinion about them, and there is no suppression
comment, compiler patch or configuration key anywhere. That was the whole search
really, and these two shapes are what came out of it still standing.

The trick is that neither is new syntax. An attribute is an array literal
holding one call, standing alone as a statement, which is a shape nothing in
ordinary code has: an array evaluated and thrown away is dead code nobody
writes. An inline macro is the non-null assertion applied to a callee, which
parses fine and means nothing at runtime until something expands it.

Because they're ordinary expressions, the compiler checks them like anything
else. A misspelled macro name is `TS2552` with a suggestion, a misspelled
operand is `TS2304`, and a wrong argument type is `TS2345`. You get the normal
errors in the normal place rather than a separate diagnostic channel that only
this tool knows about.

## Installation

As a library, for the expansion and the map:

```bash
deno add jsr:@hiisi/loitsu
```

As a command, for building twins, checking them and fronting an editor:

```bash
deno install --global --allow-read --allow-write --allow-run --allow-env \
  --name loitsu jsr:@hiisi/loitsu/cli
```

Or without installing:

```bash
deno run --allow-read --allow-write --allow-run --allow-env jsr:@hiisi/loitsu/cli
```

The permissions are the ones it needs and no more. It reads your sources, writes
the twins, runs the type checker or the language server you point it at, and
reads the environment those want.

## The command

Three verbs, and a project says where its macros are in a `loitsu.config.ts` at
its root, which default-exports the registry and the name the cache is keyed on.

```bash
loitsu build                # write the twin tree, expanded, mirroring the sources
loitsu check                # write it and type check it, reported where you wrote it
loitsu lsp                  # proxy an editor to a language server, over the twins
loitsu lsp -- <command>     # proxy to that one instead of `deno lsp`
```

`check` exists because `deno check` reads what is on disk and cannot see
anything a running program registered, so what it checks has to already be
expanded. `lsp` exists for the same reason on the editor's side: the inner
server is handed the twin under your source's own uri and never learns the
source is there, and every position in every message crosses back on the way
out.

## Usage

Here's the basic flow, and how the pieces fit together. A macro says what it
expands into, `expand` runs them all and hands back a twin of your file, and the
span table it comes with says which part of the twin came from where.

```ts
import { cached, expand, registry, sourceRuns, uses } from "@hiisi/loitsu";
import type { AttributeMacro, FunctionMacro } from "@hiisi/loitsu";
import ts from "npm:typescript@^5.9.2"; // the version loitsu builds against

// arguments arrive as expressions, because that's what the parser made of them.
// `cfg(deno)` gives an identifier and `cfg("deno")` a string literal, and both
// spellings parse, so the macro decides which of them it accepts. the tuple in the
// type is the macro's own, and it is not erased: declare it and the arguments are
// typed at the point of use rather than left as `unknown`.
const word = (arg: ts.Expression): string =>
  ts.isIdentifier(arg) ? arg.text : ts.isStringLiteral(arg) ? arg.text : "";

// an attribute macro returns the items that stand in place of the one it sat above.
// returning nothing is a real answer, and it's the one `cfg` gives when its
// predicate doesn't hold: the item never gets emitted, rather than emitted and then
// stripped again later.
const cfg: AttributeMacro<readonly [ts.Expression]> = {
  kind: "attribute",
  name: "cfg",
  expand: (args, item) => word(args[0]) === "deno" ? [item.node] : [],
};

// a function macro returns the expression that replaces the call.
const includeStr: FunctionMacro<readonly [ts.Expression]> = {
  kind: "function",
  name: "include_str",
  expand: (args) =>
    ts.factory.createStringLiteral(Deno.readTextFileSync(word(args[0]))),
};

const known = registry([cfg, includeStr]);
const source = Deno.readTextFileSync("src/thing.ts");

// parsing, not text matching. an `!` inside a string and a `[` opening a real array
// are both common, and only the parser reliably knows which is which.
for (const use of uses(source, known)) {
  console.log(use.form, use.name, use.start, use.end);
}

// the twin. `fileName` decides the dialect, and it matters more than it looks: a
// tsx file read as ts doesn't fail, it parses into something else entirely and the
// jsx comes apart into comparisons.
const twin = expand(source, known, { fileName: "src/thing.ts" });

// and back again. the checker complains about a place in the twin, and this
// says which authored text it was complaining about.
const at = twin.code.indexOf("readConfig");
sourceRuns(twin.spans, { start: at, length: 10 });
```

`registry` refuses two macros with the same name rather than letting one quietly
win.

Expanding on every keystroke is work you already did, so `cached` keeps the twin
under your cache directory, keyed on the file's bytes and on what it was
expanded against:

```ts
const dir = Deno.makeTempDirSync(); // wherever the cache should live
const reused = await cached(source, "my-macros@1", known, dir, "src/thing.ts");
reused.hit; // false the first time, true after
```

Nothing there is authoritative and none of it is meant to be committed. Losing
the whole cache costs you some time and nothing else, and anything it can't
verify on the way back in it throws away rather than trusts.

## Keeping twins current

`Twins` is the only thing in here that ever reads the source files. Everything
else sees twins, which is the point of the whole arrangement. A checker or a
language server is handed a file it can actually parse, never the one being
edited.

```ts
import { Twins, watch } from "@hiisi/loitsu";

const twins = new Twins({
  registry: known,
  against: "my-macros@1",
  cacheDir: dir,
});

const stop = new AbortController();
const watching = watch({ twins, paths: ["src"], signal: stop.signal });

await twins.get("src/thing.ts"); // the twin, built if there isn't one yet

stop.abort();
await watching; // it resolves once the watch has actually let go
```

The rule it holds to: a twin is never older than the last change it
acknowledged. Editors write a file several times per save, so two rebuilds for
one path overlap fairly often, and the one that finishes last did not
necessarily read the newest bytes. A rebuild that has been overtaken throws its
own result away rather than storing it.

Events are batched, so one save is one rebuild instead of five. A batch waits
`settleMs` for the writing to settle, and `maxWaitMs` caps how long it may be
held open however many events keep arriving. That cap is what keeps twins
arriving during a formatter walking a whole tree, rather than only at the end of
it.

A file that cannot be read is ordinary halfway through a save, so it is reported
rather than thrown. `get` and `peek` answer with nothing and `failure` says why.

```ts
twins.failure("src/thing.ts")?.why; // "NotFound" while the editor is mid-write
```

`interesting` is the default for deciding which paths are worth expanding. It
takes the TypeScript sources and leaves the declaration files, since a `.d.ts`
has no bodies for a macro to sit in. Do note that `matches` takes a predicate of
its own if that default does not suit.

## What gets left alone

A name that is not in the registry is left exactly as written. An array literal
standing alone as a statement comes back untouched, rather than as an error
about a macro nobody wrote.

The one thing that is reported rather than ignored is an attribute as the last
statement in a block, since it has nothing beneath it to attach to. That is
nearly always a line that drifted during an edit rather than a deliberate no-op,
and silently dropping it would be the wrong kindness.

## `cfg` has no privileges

This is not a conditional-compilation library with an extensibility story bolted
on afterwards. `cfg` is the first attribute macro and holds no special position:
its entire expansion is to return the item it was given, or to return nothing.

Anything else that wants to rewrite the item beneath it uses the same contract.
That's what makes attribute macros a real feature rather than one special case
with room beside it.

## Source maps

Expansion moves things around, so a span table says where each offset in the
twin came from. Offsets here are utf-16 code units, the same unit
`String.length` and the language server protocol count in. Going forward is a
function, one twin offset from one source offset:

```ts
import { identity, sourceOffset, spanning } from "@hiisi/loitsu";

const table = spanning([
  { outStart: 0, inStart: 0, length: 40 },
  { outStart: 40, inStart: 120, length: 15 },
]);

sourceOffset(table, 45); // 125
```

Going back is not a function, and this is the part that's easy to get wrong. A
derive macro hands back the item it was given alongside the thing it derived
from it, so one name you wrote can end up in two or three places in the twin.
Ask for all of them:

```ts
import { outputOffsets, outputRuns, sourceRuns } from "@hiisi/loitsu";

outputOffsets(table, 125); // every image of that source offset, ascending
outputRuns(table, { start: 120, length: 15 }); // the same, for a range
sourceRuns(table, { start: 40, length: 15 }); // and the other direction
```

A reverse that gives you one answer would rename one of the arms and quietly
miss the rest, which is the kind of bug you only notice much later.

`compose` chains two tables, for when expansion runs a macro at a time and each
round has its own map. An offset survives only where both tables carry it, so
something a macro generated has no source origin after composing, which is
right: you didn't write it.

`identity` gives a table for text nothing moved, which is the honest thing to
return when a pass did nothing rather than pretending it has no mapping at all.

Offsets are branded and made with `offsetIn(text, at)`, which checks the offset
is actually inside that text. Small thing, but offsets crossing between files is
the bug you spend an afternoon on.

## Positions and diagnostics

A span table counts in offsets. Editors and language servers count in lines and
characters, and disagree about what a character is: utf-16 code units by
default, sometimes utf-8, occasionally codepoints. `Lines` holds one document
and converts between the two, in whichever of the three a client asked for.

```ts
import { Lines, negotiate } from "@hiisi/loitsu";

const encoding = negotiate(["utf-8", "utf-16"]); // "utf-8", the first supported
const authored = new Lines(source);

authored.positionAt(45, encoding); // { line, character }
authored.offsetAt({ line: 2, character: 4 }, encoding);
```

`negotiate` takes what a client advertised and answers with the first entry both
sides support, falling back to utf-16, which the protocol requires everyone to
accept.

`Mapping` pairs a source and a twin over one span table and moves positions and
ranges across it. A source position can land in several places, so it answers
with a list; a twin position lands in at most one, so it answers with one or
with nothing.

```ts
import { Mapping, toSourceDiagnostic } from "@hiisi/loitsu";

const map = new Mapping({ source, twin: twin.code, spans: twin.spans });

const wrote = authored.positionAt(0, map.encoding);
map.toTwin(wrote); // every image of an authored position
map.toSource(map.twin.positionAt(at, map.encoding)); // and back, if it was written
```

`toSourceDiagnostic` moves one diagnostic onto the authored text, and answers
with nothing when the range it covers has no authored image. That case is
ordinary rather than a failure: an unused-variable complaint about an arm the
twin carries and the target does not use belongs to text nobody wrote.
`toSourceDiagnostics` does the same for a batch and keeps the ones that
survived.

A range covering several authored regions keeps the first and hangs the rest off
as related information, so one complaint stays one complaint.

`renameEdits` unions the renames from every twin onto the one source. Each twin
is a separate document to the checker, so a rename reaches one per request, and
the answers meet here. An edit whose twin text matches the authored text carries
its replacement across, which is what keeps `{ foo }` renaming to `{ foo: bar }`
rather than to `{ bar }`. An edit against a name a macro derived is written with
the new name alone, since an affix computed against text nobody typed is not
something to splice into their file.

Overlapping edits are refused rather than emitted. The protocol forbids them in
one array, and a client handed two would have no way to see where the conflict
came from.

## Limitations

The api hasn't settled and breaking changes should be expected. I'd caution
against using this for anything serious just yet.

On node and bun the expansion goes in front of the loader, and the line that
puts it there names a module that already exists:

```bash
node --import loitsu/register app.js
bun --preload loitsu/register app.ts
```

Or in `package.json`, so nobody has to remember the flag:

```json
{ "imports": { "#loitsu": "loitsu/register" } }
```

`register` finds your `loitsu.config.ts` the way the command does, upward from
where you are standing, and installs the macros it names. Nothing to write.

A hook reaches what is loaded after it, so a module imported alongside the one
that installs is already resolved by the time it runs. Your program has to come
after it on the command line, or be reached through a dynamic import.

Deno needs none of that to run, since it executes TypeScript. What it cannot do
is check text a running program registered, which is why `check` and `lsp` are
commands rather than something you switch on.

Expansion is whole file at a time, not incremental. Fine at the sizes this has
been used on, and would want attention before it isn't.

A macro has to build its expansion with `ts.factory`, or out of nodes from the
item it was handed. Parsing a template and returning those nodes is refused,
because the printer would slice your file at positions that mean something in a
different one, and what comes out is a fragment of your own source picked more
or less at random. That used to happen silently, which was worse.

The cache doesn't evict anything yet. It's content-keyed, so editing a file
leaves the old entry behind rather than replacing it, and over a long session
that adds up. Deleting the directory is safe and is the workaround for now.

## A note on the name

_Loitsu_ is Finnish for a spell or an incantation, which is roughly what a macro
is: a short thing you write that turns into a longer thing you didn't.

## Support

Whether you use this project, have learned something from it, or just like it,
please consider supporting it by buying me a coffee, so I can dedicate more time
on open-source projects like this :)

<a href="https://buymeacoffee.com/orgrinrt" target="_blank"><img src="https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png" alt="Buy Me A Coffee" style="height: auto !important;width: auto !important;" ></a>

## License

> You can check out the full license
> [here](https://github.com/hiisi-digital/loitsu/blob/main/LICENSE)

This project is licensed under the terms of the **Mozilla Public License 2.0**.

`SPDX-License-Identifier: MPL-2.0`
