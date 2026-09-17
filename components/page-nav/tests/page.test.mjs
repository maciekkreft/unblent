import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
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
const PAGES = resolve(REPO, "pages");

// The five page kinds in composition order (architecture.md 8).
const KINDS = ["tokens", "contracts", "components", "stem", "app"];

// The expected links come from the filesystem, so the test tracks the pages.
function pageList() {
  const rows = [];
  for (const dir of readdirSync(PAGES, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const file of readdirSync(resolve(PAGES, dir.name)).filter((f) => f.endsWith(".html"))) {
      const html = readFileSync(resolve(PAGES, dir.name, file), "utf-8");
      const kind = html.match(/<meta name="kind" content="([^"]*)"/)?.[1];
      rows.push({ path: `/${dir.name}/${file.replace(/\.html$/, "")}`, kind });
    }
  }
  const rank = (k) => (KINDS.includes(k) ? KINDS.indexOf(k) : KINDS.length);
  rows.sort((a, b) => rank(a.kind) - rank(b.kind) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows.map((r) => r.path);
}
const PATHS = pageList();

const hrefs = (page) =>
  page.evaluate(() =>
    [...document.querySelector("page-nav").shadowRoot.querySelectorAll("a")].map((a) =>
      new URL(a.getAttribute("href"), location.origin).pathname,
    ),
  );
const currentHref = (page) =>
  page.evaluate(() =>
    document.querySelector("page-nav").shadowRoot.querySelector('a[aria-current="page"]')
      ?.getAttribute("href"),
  );

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  // One browser per engine, a fresh context per test (11): the launch is the costly
  // part on a small host, and a context keeps each test's storage its own.
  describe(`page-nav in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => { browser = await engine.launch(); }, { timeout: 30000 });
    after(async () => { await browser?.close(); }, { timeout: 15000 });

  test(`page-nav links every page and marks the current one in ${engine.name}`, async () => {
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    const page = await context.newPage();
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
      await page.goto(`${BASE_URL}/design/tokens`);
      await page.waitForFunction(
        (n) => document.querySelector("page-nav")?.shadowRoot?.querySelectorAll("a").length === n,
        PATHS.length,
      );
      assert.deepEqual(await hrefs(page), PATHS);
      assert.equal(await currentHref(page), "/design/tokens");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `page-nav-${engine.name}.png`) });

      await Promise.all([
        page.waitForNavigation(),
        page.evaluate(() =>
          document
            .querySelector("page-nav")
            .shadowRoot.querySelector('a[href="/design/components"]')
            .click(),
        ),
      ]);
      assert.match(page.url(), /\/design\/components$/);
      await page.waitForFunction(
        (n) => document.querySelector("page-nav")?.shadowRoot?.querySelectorAll("a").length === n,
        PATHS.length,
      );
      assert.equal(await currentHref(page), "/design/components");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
    }
  });

  test(`page-nav hosts a slotted control in the bar in ${engine.name}`, async () => {
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/design/dock`);
      // The bar renders a slot, and the page's <layout-switch> is assigned into it
      // (right-aligned) and renders its own button — the control lives in the bar.
      await page.waitForFunction(
        () => document.querySelector("page-nav")?.shadowRoot?.querySelector(".controls slot"),
      );
      await page.waitForFunction(
        () => document.querySelector("page-nav > layout-switch")?.shadowRoot?.querySelector("button"),
      );
      const slotted = await page.evaluate(() => {
        const control = document.querySelector("page-nav > layout-switch");
        const slot = document.querySelector("page-nav").shadowRoot.querySelector(".controls slot");
        return control.assignedSlot === slot;
      });
      assert.ok(slotted, "layout-switch is assigned into page-nav's controls slot");
    } finally {
      await context.close();
    }
  });
  });
}
