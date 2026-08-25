//----------------------------------------------------------------------------------------------------
// Copyright (c) 2025                    Hiisi Digital                    ort@hiisi.digital
// SPDX-License-Identifier: MPL-2.0      https://mozilla.org/MPL/2.0      contact@hiisi.digital
//----------------------------------------------------------------------------------------------------

/**
 * What a macro is, and the two ways one is invoked.
 *
 * Both forms are ordinary TypeScript, which is the whole reason they were
 * chosen over anything that looks more like Rust. An attribute is an array
 * literal standing as a statement, `[cfg(deno)]`, and an inline call is the
 * non-null assertion applied to a callee, `include_str!("x")`. Neither needs a
 * suppression, a compiler patch, or a configuration key, and both are checked
 * by the compiler like any other expression: a misspelled macro is `TS2552`
 * with a suggestion, a misspelled operand `TS2304`, a wrong argument type
 * `TS2345`.
 *
 * `cfg` gets no privileges here. It is the first attribute macro rather than a
 * built-in, and its whole expansion is to return what it was given or to return
 * nothing. Everything else that wants to rewrite the thing beneath it uses the
 * same contract, which is what makes attribute macros possible at all rather
 * than a later addition bolted beside a special case.
 *
 * @module
 */

import type ts from "typescript";

/**
 * What an attribute expands into: the items that replace the one it sat above.
 *
 * Empty is a real and expected answer, and it is the one `cfg` gives when its
 * predicate does not hold. The item is then never emitted, rather than emitted
 * and stripped, which is the difference between this and a runtime check.
 *
 * More than one is allowed because an attribute macro that derives something
 * returns the original alongside what it derived.
 */
export type Expansion = readonly ts.Statement[];

/** The item an attribute sits above, and where it was written. */
export interface Item {
  /** The declaration or statement the attribute attaches to. */
  readonly node: ts.Statement;
  /** The attribute's own span, so a diagnostic can point at the attribute. */
  readonly attribute: { readonly start: number; readonly end: number };
}

/**
 * An attribute macro: `[name(...args)]` written above an item.
 *
 * `Args` is the macro's own argument tuple and is not erased. A macro declares
 * what it takes, the declaration is what the call site is checked against, and
 * the expansion receives the arguments already narrowed. That is the difference
 * between a macro system and a preprocessor, and it is why the arguments are a
 * tuple parameter rather than `unknown[]`.
 */
export interface AttributeMacro<
  Args extends readonly unknown[] = readonly unknown[],
> {
  readonly kind: "attribute";
  readonly name: string;
  /**
   * Produce what stands in place of `item`.
   *
   * @returns the replacement items, which may be empty to emit nothing at all
   */
  expand(args: Args, item: Item): Expansion;
}

/**
 * A function-like macro: `name!(...args)` written where an expression goes.
 *
 * The bang is the non-null assertion on the callee, so an unexpanded call
 * erases to an ordinary `name(...args)` and still runs. A macro that is never
 * expanded therefore degrades to whatever its runtime implementation does,
 * rather than breaking, and that is a property worth keeping rather than an
 * accident.
 */
export interface FunctionMacro<
  Args extends readonly unknown[] = readonly unknown[],
> {
  readonly kind: "function";
  readonly name: string;
  /** Produce the expression that replaces the call. */
  expand(args: Args): ts.Expression;
}

/** Either kind, for a registry that holds both. */
export type Macro<Args extends readonly unknown[] = readonly unknown[]> =
  | AttributeMacro<Args>
  | FunctionMacro<Args>;

/**
 * The macros in scope for one expansion run.
 *
 * Keyed by name because that is what a call site carries. A name that is not
 * here is not a macro, which is how `[sideEffect()]` written by somebody who
 * meant it as ordinary code is left alone rather than mistaken for an
 * attribute.
 */
export interface Registry {
  attribute(name: string): AttributeMacro | undefined;
  function(name: string): FunctionMacro | undefined;
}

/** Build a registry from a set of macros, refusing two with one name. */
export function registry(macros: readonly Macro[]): Registry {
  const attributes = new Map<string, AttributeMacro>();
  const functions = new Map<string, FunctionMacro>();

  for (const macro of macros) {
    const into = macro.kind === "attribute" ? attributes : functions;
    if (into.has(macro.name)) {
      throw new Error(
        `two ${macro.kind} macros are named ${macro.name}; a call site names one macro ` +
          "and there would be no way to say which",
      );
    }
    if (macro.kind === "attribute") attributes.set(macro.name, macro);
    else functions.set(macro.name, macro);
  }

  return {
    attribute: (name) => attributes.get(name),
    function: (name) => functions.get(name),
  };
}
