// Unit tests for the page-load tally (architecture.md 11): pure over timestamps, no
// browser, and the durations reporter fed a fake event stream. Run standalone
// (`node --test checks/tests/loads.test.mjs`) or through the full check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTally, TALLY } from "../loads.mjs";
import durations from "../durations.mjs";

const A = { id: "page a" };
const B = { id: "page b" };

test("a load is the time from its navigation request to its load event", () => {
  const tally = createTally();
  tally.begin();
  tally.navigated(A, "http://x/", 100);
  tally.loaded(A, "http://x/", 850);
  tally.end("t");
  assert.deepEqual(tally.take("t"), { loads: [{ url: "http://x/", ms: 750 }], load_ms: 750 });
});

test("two loads in one test add up, on one page or two", () => {
  const tally = createTally();
  tally.begin();
  tally.navigated(A, "http://x/", 0);
  tally.navigated(B, "http://x/other", 10);
  tally.loaded(B, "http://x/other", 210);
  tally.loaded(A, "http://x/", 400);
  tally.end("t");
  const record = tally.take("t");
  assert.equal(record.loads.length, 2);
  assert.equal(record.load_ms, 600);
});

test("records are handed out per name in the order the tests ended", () => {
  const tally = createTally();
  for (const ms of [100, 200]) {
    tally.begin();
    tally.navigated(A, "http://x/", 0);
    tally.loaded(A, "http://x/", ms);
    tally.end("same name in both engines");
  }
  assert.equal(tally.take("same name in both engines").load_ms, 100);
  assert.equal(tally.take("same name in both engines").load_ms, 200);
  assert.equal(tally.take("same name in both engines"), undefined);
  assert.equal(tally.take("never ran"), undefined);
});

test("a load with no navigation start, or outside a test, is dropped", () => {
  const tally = createTally();
  tally.loaded(A, "http://x/", 5);
  tally.begin();
  tally.loaded(A, "http://x/", 50);
  tally.end("t");
  assert.deepEqual(tally.take("t"), { loads: [], load_ms: 0 });
});

test("launches are counted and summed", () => {
  const tally = createTally();
  tally.launched("webkit", 400);
  tally.launched("chromium", 350.5);
  assert.deepEqual(tally.summary(), { launches: 2, launch_ms: 750.5 });
});

test("the reporter puts each test's loads on its row, then each file's time, then the launches", async () => {
  const tally = createTally();
  tally.launched("webkit", 300);
  tally.begin();
  tally.navigated(A, "http://x/", 0);
  tally.loaded(A, "http://x/", 640);
  tally.end("renders");
  globalThis[TALLY] = tally;
  try {
    async function* events() {
      yield { type: "test:start", data: { name: "renders" } };
      yield { type: "test:pass", data: { name: "renders", file: "/f.mjs", nesting: 1, details: { duration_ms: 900 } } };
      yield { type: "test:pass", data: { name: "suite", file: "/f.mjs", nesting: 0, details: { type: "suite", duration_ms: 950 } } };
      yield { type: "test:fail", data: { name: "breaks", file: "/f.mjs", nesting: 0, details: { duration_ms: 20 } } };
    }
    const lines = [];
    for await (const line of durations(events())) lines.push(JSON.parse(line));
    assert.deepEqual(lines, [
      { name: "renders", file: "/f.mjs", ms: 900, failed: false, loads: [{ url: "http://x/", ms: 640 }], load_ms: 640 },
      { name: "breaks", file: "/f.mjs", ms: 20, failed: true },
      // A file's time is its top-level tests and suites, hooks included, never a nested test again.
      { files: { "/f.mjs": 970 } },
      { summary: { launches: 1, launch_ms: 300 } },
    ]);
  } finally {
    delete globalThis[TALLY];
  }
});

test("without a tally the reporter writes rows and file times but no summary", async () => {
  async function* events() {
    yield { type: "test:pass", data: { name: "n", file: "/f.mjs", nesting: 0, details: { duration_ms: 1 } } };
  }
  const lines = [];
  for await (const line of durations(events())) lines.push(JSON.parse(line));
  assert.deepEqual(lines, [{ name: "n", file: "/f.mjs", ms: 1, failed: false }, { files: { "/f.mjs": 1 } }]);
});
