import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, mkdirSync } from "node:fs";
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

// The expected count comes from the filesystem, so the test tracks the slip-box.
const COMPONENT_DIRS = readdirSync(resolve(REPO, "components"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

// A card as rendered (innerText keeps the breaks between grid cells), read from
// the shadow root so the assertion sees what the user sees.
const cardText = (page, name) =>
  page.evaluate((name) => {
    const root = document.querySelector("component-list").shadowRoot;
    for (const card of root.querySelectorAll(".card")) {
      if (card.querySelector("h3")?.textContent === name) return card.innerText.replace(/\s+/g, " ");
    }
    return null;
  }, name);

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the components page lists every component in ${engine.name}`, async () => {
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
      await page.goto(`${BASE_URL}/design/components`, { waitUntil: "networkidle" });
      await page.waitForFunction(
        (n) => document.querySelector("component-list")?.shadowRoot?.querySelectorAll(".card").length === n,
        COMPONENT_DIRS.length,
      );
      // Cards are grouped into Facts then Views (section 3.1), each group by name.
      const sections = await page.evaluate(() =>
        [...document.querySelector("component-list").shadowRoot.querySelectorAll("section")].map((s) => ({
          title: s.querySelector("h2").textContent,
          names: [...s.querySelectorAll("h3")].map((h) => h.textContent),
        })),
      );
      assert.deepEqual(
        sections.map((s) => s.title),
        ["Facts", "Views"],
      );
      for (const s of sections) assert.deepEqual(s.names, [...s.names].sort());
      assert.deepEqual(sections.flatMap((s) => s.names).sort(), COMPONENT_DIRS);

      const catalog = await cardText(page, "catalog");
      assert.doesNotMatch(catalog, /\bbuilt\b/);
      assert.match(catalog, /\bfact\b/);
      assert.match(catalog, /remote-only/);
      assert.match(catalog, /answers list/);
      assert.match(catalog, /component-list · answers list/);

      const list = await cardText(page, "component-list");
      assert.match(list, /\bview\b/);
      assert.match(list, /asks catalog: list/);

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `components-${engine.name}.png`),
        fullPage: true,
      });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
