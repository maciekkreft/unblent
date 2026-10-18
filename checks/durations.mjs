// The headroom warning (11) needs each test's own duration, and a failed run names its
// failing tests at the end so they are not lost in the log: one JSON line per finished
// test, suites left out because a suite's time is the sum of tests already reported.
// A browser run adds each test's page loads, tallied by checks/browsers.mjs, and one
// last line summing the launches, so the check can say where the phase's time went.
// A last `files` line gives each file's time, its top-level tests and suites with their
// hooks, so a slow browser test file is named (11).
const TALLY = Symbol.for("unblent.loads");

export default async function* durations(source) {
  const files = {};
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.nesting === 0 && event.data.file) {
      files[event.data.file] = (files[event.data.file] ?? 0) + (event.data.details?.duration_ms ?? 0);
    }
    if (event.data.details?.type === "suite") continue;
    const loads = globalThis[TALLY]?.take(event.data.name) ?? {};
    yield `${JSON.stringify({ name: event.data.name, file: event.data.file, ms: event.data.details?.duration_ms, failed: event.type === "test:fail", ...loads })}\n`;
  }
  yield `${JSON.stringify({ files })}\n`;
  const tally = globalThis[TALLY];
  if (tally) yield `${JSON.stringify({ summary: tally.summary() })}\n`;
}
