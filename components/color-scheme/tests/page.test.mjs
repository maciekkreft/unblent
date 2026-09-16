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

// Read the expected pair from tokens.css rather than hardcode it, so the test
// tracks the palette. A colour token is one light-dark() call; the browser
// reports the resolved colour as rgb(), so compare in that form.
function tokenPair(name) {
  const css = readFileSync(resolve(REPO, "tokens", "tokens.css"), "utf8");
  const match = css.match(new RegExp(`${name}\\s*:\\s*light-dark\\(([^,]+),\\s*([^)]+)\\);`));
  assert.ok(match, `${name} is not a light-dark() token in tokens.css`);
  return { light: match[1].trim(), dark: match[2].trim() };
}

function rgb(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

// The body background is where the canvas token lands: the resolved colour,
// which is what a person sees, rather than the token's text.
function canvas(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
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
    const pair = tokenPair("--color-canvas");
    const dark = rgb(pair.dark);
    const light = rgb(pair.light);
    assert.notEqual(dark, light, "the dark and light canvas must differ for the test to mean anything");

    const browser = await engine.launch();

    // Scripts off: only the sheet paints. This is the first frame a person sees,
    // before any fact has run, and it must already be dark.
    const still = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
    const first = await still.newPage();
    await first.goto(`${BASE_URL}/design/tokens`);
    assert.equal(await canvas(first), dark, "the first frame should already be dark");
    await still.close();

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
      // Dark first: proves the attribute was written before any view read the
      // sheet (7.5), not only after a flip.
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(`${BASE_URL}/design/tokens`, { waitUntil: "networkidle" });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.colorScheme),
        "dark",
      );
      assert.equal(await canvas(page), dark, "the canvas should be painted in the dark value");
      assert.equal(
        await printedCanvas(page),
        `light-dark(${pair.light}, ${pair.dark})`,
        "token-sheet should print the token as written, both values",
      );

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `tokens-dark-${engine.name}.png`),
        fullPage: true,
      });

      // Flipping proves the fact follows the media query and the attribute
      // overrides it (7.5): the canvas repaints with the attribute.
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "light");
      assert.equal(await canvas(page), light, "the canvas should follow the flip to light");

      // Reversing rules out a path that only ever moves in one direction.
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "dark");
      assert.equal(await canvas(page), dark, "the canvas should follow the flip back to dark");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
