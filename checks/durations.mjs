// The headroom warning (11) needs each test's own duration, and a failed run names its
// failing tests at the end so they are not lost in the log: one JSON line per finished
// test, suites left out because a suite's time is the sum of tests already reported.
export default async function* durations(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.details?.type === "suite") continue;
    yield `${JSON.stringify({ name: event.data.name, file: event.data.file, ms: event.data.details?.duration_ms, failed: event.type === "test:fail" })}\n`;
  }
}
