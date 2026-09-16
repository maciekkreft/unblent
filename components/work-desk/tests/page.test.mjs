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

// The children as the page declares them, in order.
const CHILDREN = ["token-sheet", "contract-list", "component-list"];

// What the desk renders: the slot's assigned elements, read from its shadow root.
const assigned = (page) =>
  page.evaluate(() =>
    document
      .querySelector("work-desk")
      .shadowRoot.querySelector("slot")
      .assignedElements()
      .map((el) => el.localName),
  );

const open = (page, name) =>
  page.evaluate((name) => {
    const nav = document.querySelector("work-desk").shadowRoot.querySelector("nav");
    [...nav.querySelectorAll("button")].find((b) => b.textContent.trim() === name).click();
  }, name);

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the desk shows one child at a time in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
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
      await page.goto(`${BASE_URL}/design/work-desk`, { waitUntil: "networkidle" });
      await page.waitForFunction(
        () => document.querySelector("work-desk")?.shadowRoot?.querySelector("slot"),
      );
      const names = await page.evaluate(() =>
        [...document.querySelector("work-desk").shadowRoot.querySelectorAll("nav button")].map((b) =>
          b.textContent.trim(),
        ),
      );
      assert.deepEqual(names, CHILDREN);
      assert.deepEqual(await assigned(page), ["token-sheet"]);
      // The open child renders: the token sheet has content in its shadow root.
      await page.waitForFunction(
        () => document.querySelector("token-sheet").shadowRoot?.textContent.trim().length > 0,
      );
      const visible = (name) => page.evaluate((n) => document.querySelector(n).offsetHeight > 0, name);
      assert.ok(await visible("token-sheet"));
      assert.ok(!(await visible("contract-list")));

      await open(page, "contract-list");
      await page.waitForFunction(() => document.querySelector("contract-list").offsetHeight > 0);
      assert.deepEqual(await assigned(page), ["contract-list"]);
      assert.ok(!(await visible("token-sheet")));

      await open(page, "component-list");
      await page.waitForFunction(() => document.querySelector("component-list").offsetHeight > 0);
      assert.deepEqual(await assigned(page), ["component-list"]);

      await open(page, "token-sheet");
      await page.waitForFunction(() => document.querySelector("token-sheet").offsetHeight > 0);
      assert.deepEqual(await assigned(page), ["token-sheet"]);

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `work-desk-${engine.name}.png`),
        fullPage: true,
      });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
