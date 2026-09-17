#!/usr/bin/env node
// The published entry point, and the only file in this package an unsupported Node can still read.
//
// Everything real is in ./releashed.mjs, which this file loads and hands off to. It exists for one
// reason: a Node-version guard inside releashed.mjs can never run on Node 18. ES module imports
// link before any module body executes, so `import { matchesGlob } from "node:path"` (lib/run-limits.mjs)
// throws first and the reader gets
//
//     SyntaxError: The requested module 'node:path' does not provide an export named 'matchesGlob'
//
// which reads as "this tool is broken" rather than "I am three majors behind". Only a file with no
// static imports of its own can answer, so this one has none, and every import below is dynamic.
//
// Rules for anything added here:
//   * No static imports, ever, and no syntax newer than Node 14. That includes top-level await,
//     which is why the two branches below are promise chains rather than `await`.
//   * No dependency, and nothing loaded at all on the supported path beyond ./releashed.mjs, which
//     the CLI was going to load anyway. A launcher that costs startup time is a worse trade than
//     the traceback it replaces.
//   * No behaviour of its own. It decides which of two things to print and nothing else.
//
// Handing off means calling main() here: releashed.mjs self-invokes only when it is argv[1]
// (isEntryPoint), which it no longer is, so it loads inertly and this file runs it exactly once.
// `node bin/releashed.mjs <args>` still works directly and still self-invokes, which is what the
// repo's own `npm run releashed` and several tests do.

// Keep in sync with MIN_NODE_MAJOR in ../lib/first-run.mjs. Inlined rather than imported so the
// supported path loads nothing extra; tests/launcher.test.mjs fails if the two ever disagree.
const MIN_NODE_MAJOR = 22;

if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) {
  // Safe to load now: lib/first-run.mjs has no imports of its own and no syntax newer than this
  // file's, so it reads on any Node that got this far. The words live there with the other three
  // first-run refusals, so there is still one place that says what a first run needs.
  process.exitCode = 1;
  import("../lib/first-run.mjs").then(function (firstRun) {
    process.stderr.write(firstRun.nodeRefusal() + "\n");
  });
} else {
  import("./releashed.mjs")
    .then(function (cli) {
      return cli.main();
    })
    .catch(function (error) {
      // Byte for byte what releashed.mjs prints when it is the entry point itself, so a message is
      // the same message however the CLI was started. Commands that set process.exitCode of their
      // own (doctor, diff) are untouched: this only fires when something threw.
      process.stderr.write((error && error.message ? error.message : error) + "\n");
      process.exitCode = 1;
    });
}
