import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// The rows the trace-list table renders, one string per row, read from the
// shadow root so the assertion sees what the user sees.
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row")].map(
      (tr) => tr.textContent,
    ),
  );

// A row for page-nav's pages: list query: kind query, name list, pages reached.
const isPagesList = (text) => text.includes("query") && text.includes("list") && text.includes("pages");

// WebKit first, then Chromium: a Safari-class engine is the stricter check. The
// stem page composes trace-list, which shows the page's own bus traffic (section
// 10); the one other view on it is page-nav, so its pages: list query must appear.
for (const engine of ENGINES) {
  test(`the trace page shows its own bus traffic in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const page = await browser.newPage();
    const problems = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("requestfailed", (req) =>
      problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
    );
    page.on("response", (res) => {
      if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
    });

    try {
      await page.goto(`${BASE_URL}/design/trace`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        [...document.querySelector("trace-list").shadowRoot.querySelectorAll("tbody tr.row")].some(
          (tr) => {
            const t = tr.textContent;
            return t.includes("query") && t.includes("list") && t.includes("pages");
          },
        ),
      );
      assert.ok((await rows(page)).some(isPagesList), "a pages: list row is shown");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `trace-list-${engine.name}.png`),
        fullPage: true,
      });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
