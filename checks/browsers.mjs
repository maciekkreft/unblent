// A test owns its browser and its storage (11.2): what a test launches or opens it
// closes before it ends, and no two tests share a context. Loaded by check.py for the
// browser phase only, so every test in the one process is under it.
import { beforeEach, afterEach, after } from "node:test";

const { webkit, chromium } = await import(process.env.PLAYWRIGHT_MODULE);

const open = new Set();
// The contexts the running test opened; null while no test runs (a before hook, the
// file's top level), where a context would be shared by every test after it.
let contexts = null;
function opened(context) {
  if (!contexts) {
    context.close().catch(() => {});
    throw new Error(
      "a browser context was opened outside a test, so the tests after it would share its storage: " +
        "open it inside the test, and set up the server data it reads through the API (11.2)",
    );
  }
  contexts.add(context);
  context.on("close", () => contexts?.delete(context));
  return context;
}
for (const type of [webkit, chromium]) {
  // The same singleton the tests import, so a launch cannot go unrecorded.
  const launch = type.launch.bind(type);
  type.launch = async (...args) => {
    const browser = await launch(...args);
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

// A suite's own browser (launched in before) is already open when its tests start.
let before;
beforeEach(() => {
  before = new Set(open);
  contexts = new Set();
});

afterEach(async (t) => {
  const leaked = [...open].filter((browser) => !before.has(browser));
  // A context goes with its browser; one left open on a browser that stays is the leak.
  const left = [...contexts].filter((context) => context.browser()?.isConnected() && !leaked.includes(context.browser()));
  contexts = null;
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
