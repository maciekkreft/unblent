import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
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

// Read the expected value from tokens.css rather than hardcode it, so the test
// tracks the palette. The dark block is guarded by the data-color-scheme selector.
function tokenValue(scheme, name) {
  const css = readFileSync(resolve(REPO, "tokens", "tokens.css"), "utf8");
  const marker = scheme === "dark" ? ':root[data-color-scheme="dark"] {' : ":root {";
  const open = css.indexOf(marker);
  const close = css.indexOf("}", open);
  const block = css.slice(open, close);
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  assert.ok(match, `${name} not found in the ${scheme} block of tokens.css`);
  return match[1].trim();
}

// The printed value is what token-sheet renders next to a token name, taken from
// getComputedStyle: proof the sheet re-read after the scheme changed.
function printedCanvas(page) {
  return page.evaluate(() => {
    const root = document.querySelector("token-sheet").shadowRoot;
    for (const token of root.querySelectorAll(".token")) {
      if (token.querySelector(".name")?.textContent === "--color-canvas") {
        return token.querySelector(".value")?.textContent;
      }
    }
    return null;
  });
}

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the page follows the colour scheme in ${engine.name}`, async () => {
    const dark = tokenValue("dark", "--color-canvas");
    const light = tokenValue("light", "--color-canvas");
    assert.notEqual(dark, light, "the dark and light canvas must differ for the test to mean anything");

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
      // Dark first: proves the attribute was written before any view read the
      // sheet (7.5), not only after a flip.
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`${BASE_URL}/design/tokens`, { waitUntil: "networkidle" });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.colorScheme),
        "dark",
      );
      const computed = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-canvas").trim(),
      );
      assert.equal(computed, dark, "computed --color-canvas should be the dark value");
      assert.equal(await printedCanvas(page), dark, "token-sheet should print the dark value");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `tokens-dark-${engine.name}.png`),
        fullPage: true,
      });

      // Flipping proves color-scheme.changed crosses the bus and the sheet
      // re-reads (4.3, fourth rule).
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "light");
      await page.waitForFunction(
        (expected) => {
          const root = document.querySelector("token-sheet").shadowRoot;
          for (const token of root.querySelectorAll(".token")) {
            if (token.querySelector(".name")?.textContent === "--color-canvas") {
              return token.querySelector(".value")?.textContent === expected;
            }
          }
          return false;
        },
        light,
      );

      // Reversing rules out a path that only ever moves in one direction.
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(
        (expected) => {
          const root = document.querySelector("token-sheet").shadowRoot;
          for (const token of root.querySelectorAll(".token")) {
            if (token.querySelector(".name")?.textContent === "--color-canvas") {
              return token.querySelector(".value")?.textContent === expected;
            }
          }
          return false;
        },
        dark,
      );

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
