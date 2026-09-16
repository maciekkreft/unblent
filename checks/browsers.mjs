// A test owns its browser (11.2): what a test launches it closes before it ends. Loaded
// by check.py for the browser phase only, so every test in the one process is under it.
import { beforeEach, afterEach, after } from "node:test";

const { webkit, chromium } = await import(process.env.PLAYWRIGHT_MODULE);

const open = new Set();
for (const type of [webkit, chromium]) {
  // The same singleton the tests import, so a launch cannot go unrecorded.
  const launch = type.launch.bind(type);
  type.launch = async (...args) => {
    const browser = await launch(...args);
    open.add(browser);
    browser.on("disconnected", () => open.delete(browser));
    return browser;
  };
}

// A suite's own browser (launched in before) is already open when its tests start.
let before;
beforeEach(() => {
  before = new Set(open);
});

afterEach(async (t) => {
  const leaked = [...open].filter((browser) => !before.has(browser));
  // Closed here, at the moment the test ends, so a timed-out test's browser never
  // overlaps the next test's; unclosed browsers are how the run exhausts a small host.
  await Promise.all(leaked.map((browser) => browser.close()));
  if (leaked.length) {
    throw new Error(
      `${t.fullName ?? t.name} left ${leaked.length} browser(s) open: ` +
        "close it in finally and cap waits below the test budget (11)",
    );
  }
});

after(async () => {
  const count = open.size;
  await Promise.all([...open].map((browser) => browser.close()));
  if (count) throw new Error(`a suite left ${count} browser(s) open: close it in after()`);
});
