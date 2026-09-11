import { test } from "node:test";
import assert from "node:assert/strict";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// A trace console line for a catalog: list query, and the tab id it is tagged with.
// The format is machine.js's: `trace #<seq> <tab last 4> query list component-list → catalog …`.
const LIST = /trace #\d+ (\S+) query list \S+ → catalog/;

async function until(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

// WebKit first, then Chromium: a Safari-class engine is the stricter check. Two
// tabs of the same origin share a BroadcastChannel, so the second tab's trace must
// see the first tab's catalog: list, tagged with the first tab's id (section 10, 12).
for (const engine of ENGINES) {
  test(`a second tab's trace sees the first tab's traffic in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    const problems = [];
    const watch = (page, label) => {
      page.on("console", (msg) => {
        if (msg.type() === "error") problems.push(`${label} console error: ${msg.text()}`);
      });
      page.on("pageerror", (err) => problems.push(`${label} page error: ${err.message}`));
      page.on("requestfailed", (req) =>
        problems.push(`${label} request failed: ${req.url()} ${req.failure()?.errorText}`),
      );
      page.on("response", (res) => {
        if (res.status() >= 400) problems.push(`${label} HTTP ${res.status()}: ${res.url()}`);
      });
    };

    try {
      const pageA = await context.newPage();
      watch(pageA, "A");
      await pageA.goto(`${BASE_URL}/design/components`, { waitUntil: "domcontentloaded" });

      const debugB = [];
      const pageB = await context.newPage();
      watch(pageB, "B");
      pageB.on("console", (msg) => {
        if (msg.type() === "debug") debugB.push(msg.text());
      });
      await pageB.goto(`${BASE_URL}/design/components`, { waitUntil: "domcontentloaded" });

      // The second tab prints its own catalog: list and, once the hello/buffer
      // handshake lands, the first tab's — two distinct tab ids for the same query.
      await until(() => {
        const tabs = new Set(debugB.map((l) => l.match(LIST)?.[1]).filter(Boolean));
        return tabs.size >= 2;
      });

      const tabs = new Set(debugB.map((l) => l.match(LIST)?.[1]).filter(Boolean));
      assert.ok(tabs.size >= 2, `expected catalog: list from two tabs, saw ${tabs.size}`);
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
