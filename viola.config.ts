/**
 * What this package has to be true of before anything may be committed.
 *
 * Deliberately harsher than the code currently is. A lint set tuned to what
 * already passes measures nothing, and the point of putting it here is that it
 * refuses work rather than describes it.
 *
 * @module
 */

import defaultLints from "jsr:@hiisi/viola-default-lints@^0.3.2";
import typescript from "jsr:@hiisi/viola-grammar-ts@^0.3.2";
import { report, viola, when } from "jsr:@hiisi/viola@^0.3.1";

export default viola()
  .use(defaultLints)
  // the grammar is what turns a file into something a lint can ask questions of
  .add(typescript).as("typescript")
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
  .rule(report.off, when.in("**/fixtures/**"));
