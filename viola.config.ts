/**
 * What this package has to be true of before anything may be committed.
 *
 * Deliberately harsher than the code currently is. A lint set tuned to what
 * already passes measures nothing, and the point of putting it here is that it
 * refuses work rather than describes it.
 *
 * @module
 */

import defaultLints from "@hiisi/viola-default-lints";
import typescript from "@hiisi/viola-grammar-ts";
import { report, viola, when } from "@hiisi/viola";

export default viola()
  .use(defaultLints)
  // the grammar is what turns a file into something a lint can ask questions
  // of. the alias defaults to the grammar's own id, so naming it "typescript"
  // said the same thing twice.
  .add(typescript)
  // anything a linter has any confidence in at all is a failure. a warning
  // is a finding nobody acts on, and a gate that warns is not a gate. the
  // floor was 50 and everything under it passed silently.
  .rule(report.error, when.confidence.atLeast(1))
  // tests are held to the same bar as source. a fixture that drifts is how a
  // suite stops measuring the thing it names.
  .rule(report.error, when.in("tests/**/*.ts"))
  // fixtures that are supposed to be wrong are the one exception, since being
  // wrong is their entire job.
  .rule(report.off, when.in("tests/compile_fail/**"))
  .rule(report.off, when.in("**/fixtures/**"))
  // a literal spelled out across several test cases is several tests each
  // asserting its own expected value. counting those toward a duplication
  // threshold asks for a shared constant, and a test comparing a constant to
  // itself has stopped testing anything. they still show in the locations
  // list, they just do not push a string over the threshold on their own.
  // a mutation plan quotes the source it mutates, verbatim, because the tool
  // matches on that text and refuses a pattern that finds nothing. so an arm
  // and the line it weakens are the same string on purpose, and several arms
  // over one function share most of it. extracting any of that to a constant
  // would stop the plan matching, which is the tool telling us the rule does
  // not apply here rather than us deciding it should not.
  .set("duplicate-strings.countIn", [
    "**",
    "!**/*_test.ts",
    "!**/*.test.ts",
    "!**/tests/**",
    "!**/fixtures/**",
    "!tools/mutate.ts",
  ])
  // three different things spelled the same way: the two verbs this tool
  // answers to, the `build` directory a walk stays out of, and the `check`
  // deno's own command line takes. the rule wants one constant where one
  // concept repeats, and there is no one concept here.
  //
  // `ignoreDeclaredVocabulary` would have covered the verbs and does not,
  // because it recognises a string-literal union and an enum, and the verbs are
  // an `as const` array with the union derived off it by `typeof VERBS[number]`.
  // that is the idiomatic way to declare a vocabulary you also want to iterate,
  // and it is filed against viola rather than worked around further.
  .set("duplicate-strings.ignoreStrings", ["build", "check"]);
