// The headroom warning (11) needs each test's own duration, and a failed run names its
// failing tests at the end so they are not lost in the log: one JSON line per finished
// test, suites left out because a suite's time is the sum of tests already reported.
// A browser run adds each test's page loads, tallied by checks/browsers.mjs, and one
// last line summing the launches, so the check can say where the phase's time went.
// A last `files` line gives each file's time, its top-level tests and suites with their
// hooks, so a slow browser test file is named (11).
// A test with tests inside it is a journey (9): its row carries `steps`, how many, so the
// check judges it by the journey's budget and each step by a test's.
const TALLY = Symbol.for("unblent.loads");

export default async function* durations(source) {
  const files = {};
  // Finished tests per nesting level not yet claimed by their parent: node reports a
  // test's subtests before the test itself.
  const below = [];
  // A journey's steps are declared by the kit, so node names the kit as their file; they
  // are reported under the file of the test they run in, which starts before them.
  let top = null;
  for await (const event of source) {
    if (event.type === "test:start" && event.data.nesting === 0) top = event.data.file;
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const file = event.data.nesting > 0 ? (top ?? event.data.file) : event.data.file;
    const level = event.data.nesting ?? 0;
    const steps = below[level + 1] ?? 0;
    below[level + 1] = 0;
    below[level] = (below[level] ?? 0) + 1;
    if (event.data.nesting === 0 && event.data.file) {
      files[event.data.file] = (files[event.data.file] ?? 0) + (event.data.details?.duration_ms ?? 0);
    }
    if (event.data.details?.type === "suite") continue;
    const loads = globalThis[TALLY]?.take(event.data.name) ?? {};
    yield `${JSON.stringify({ name: event.data.name, file, ms: event.data.details?.duration_ms, failed: event.type === "test:fail", ...(steps ? { steps } : {}), ...loads })}\n`;
  }
  yield `${JSON.stringify({ files })}\n`;
  const tally = globalThis[TALLY];
  if (tally) yield `${JSON.stringify({ summary: tally.summary() })}\n`;
}
