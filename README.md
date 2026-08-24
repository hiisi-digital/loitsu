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

```bash
deno add jsr:@hiisi/loitsu
```

## Usage

`loitsu` finds invocations and tells you what a macro would expand to. It does
not run a build for you, which is deliberate: where expansion happens is a
decision the consuming project should make, and every project that would use
this already has an opinion about it.

```ts
import { registry, uses } from "@hiisi/loitsu";
import type { AttributeMacro, FunctionMacro } from "@hiisi/loitsu";
import ts from "npm:typescript";

// an attribute macro returns the items that stand in place of the one it sat
// above. returning nothing is a real answer, and it's the one `cfg` gives when
// its predicate doesn't hold: the item is never emitted, rather than emitted
// and stripped later.
const cfg: AttributeMacro = {
  kind: "attribute",
  name: "cfg",
  expand: (args, item) => args[0] === "deno" ? [item.node] : [],
};

// a function macro returns the expression that replaces the call.
const includeStr: FunctionMacro = {
  kind: "function",
  name: "include_str",
  expand: (args) => ts.factory.createStringLiteral(String(args[0])),
};

const known = registry([cfg, includeStr]);
const source = Deno.readTextFileSync("src/thing.ts");

// parsing, not text matching. an `!` inside a string and a `[` opening a real
// array are both common, and only the parser reliably knows which is which.
for (const use of uses(source, known)) {
  console.log(use.form, use.name, use.start, use.end);
}
```

`registry` refuses two macros with the same name rather than letting one quietly
win.

## What gets left alone

A name that isn't in the registry is left exactly as written. So if you do
happen to have an array literal standing alone as a statement, you get your code
back untouched rather than an error about a macro you never wrote.

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

Expansion moves things, so `spans` maps an offset in the output back to where it
came from:

```ts
import { identity, sourceOffset, spanning } from "@hiisi/loitsu";

const table = spanning([
  { outStart: 0, inStart: 0, length: 40 },
  { outStart: 40, inStart: 120, length: 15 },
]);

sourceOffset(table, 45); // 125
```

`identity` gives you a table for text that wasn't moved, which is the honest
thing to return when a pass did nothing rather than pretending it has no
mapping.

Offsets are branded and made with `offsetIn(text, at)`, which checks the offset
is actually inside that text. It's a small thing, but offsets crossing between
files is the bug you spend an afternoon on.

## Limitations

There's no build integration. You get the invocations and the expansions, and
wiring that into a transform is yours to do. That may change, but the shape of
it should be a consuming project's call rather than a default that's awkward to
undo.

Expansion is not incremental. Whole file at a time, which is fine at the sizes
this has been used on and would want attention before it isn't.

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
