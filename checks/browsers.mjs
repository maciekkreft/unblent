// A test owns its browser and its storage (11.2): what a test launches or opens it
// closes before it ends, and no two tests share a context. Loaded by check.py for the
// browser phase only, so every test in the one process is under it.
import { beforeEach, afterEach, after } from "node:test";
import { createTally, TALLY } from "./loads.mjs";

const { webkit, chromium } = await import(process.env.PLAYWRIGHT_MODULE);

// Launches and page loads are timed here, where every browser and page passes, and read
// by checks/durations.mjs through the global (11: where the browser phase's time goes).
const tally = createTally();
globalThis[TALLY] = tally;
function instrument(page) {
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      tally.navigated(page, request.url(), performance.now());
  });
  page.on("load", () => tally.loaded(page, page.url(), performance.now()));
}

const open = new Set();
// One frame per running test, innermost last, holding the browsers open when it began and
// the contexts it opened. Empty while no test runs (a before hook, the file's top level),
// where a context would be shared by every test after it. A journey (9) is a test whose
// steps are tests: its context is its own frame's, opened and closed inside it.
const frames = [];
function opened(context) {
  const contexts = frames.at(-1)?.contexts;
  if (!contexts) {
    context.close().catch(() => {});
    throw new Error(
      "a browser context was opened outside a test, so the tests after it would share its storage: " +
        "open it inside the test, and set up the server data it reads through the API (11.2)",
    );
  }
  contexts.add(context);
  context.on("close", () => contexts.delete(context));
  // A page made with newPage is already in the context; later ones and popups arrive.
  context.pages().forEach(instrument);
  context.on("page", instrument);
  return context;
}
for (const type of [webkit, chromium]) {
  // The same singleton the tests import, so a launch cannot go unrecorded.
  const launch = type.launch.bind(type);
  type.launch = async (...args) => {
    const started = performance.now();
    const browser = await launch(...args);
    tally.launched(type.name(), performance.now() - started);
    open.add(browser);
    browser.on("disconnected", () => open.delete(browser));
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...a) => opened(await newContext(...a));
    // newPage makes a context of its own, closed with the page.
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...a) => {
      const page = await newPage(...a);
      opened(page.context());
      return page;
    };
    return browser;
  };
}

// A suite's own browser (launched in before) is already open when its tests start, and a
// journey's is open when its steps start.
beforeEach(() => {
  frames.push({ before: new Set(open), contexts: new Set() });
  tally.begin();
});

afterEach(async (t) => {
  // Before the reporter sees the test's pass or fail, so the row can carry its loads.
  tally.end(t.name);
  const { before, contexts } = frames.pop();
  const leaked = [...open].filter((browser) => !before.has(browser));
  // A context goes with its browser; one left open on a browser that stays is the leak.
  const left = [...contexts].filter((context) => context.browser()?.isConnected() && !leaked.includes(context.browser()));
  // Closed here, at the moment the test ends, so a timed-out test's browser never
  // overlaps the next test's; unclosed browsers are how the run exhausts a small host.
  await Promise.all([...leaked.map((browser) => browser.close()), ...left.map((context) => context.close())]);
  if (leaked.length) {
    throw new Error(
      `${t.fullName ?? t.name} left ${leaked.length} browser(s) open: ` +
        "close it in finally and cap waits below the test budget (11)",
    );
  }
  if (left.length) {
    throw new Error(
      `${t.fullName ?? t.name} left ${left.length} browser context(s) open: ` +
        "close it in finally or afterEach, so the next test starts from empty storage (11.2)",
    );
  }
});

after(async () => {
  const count = open.size;
  await Promise.all([...open].map((browser) => browser.close()));
  if (count) throw new Error(`a suite left ${count} browser(s) open: close it in after()`);
});
