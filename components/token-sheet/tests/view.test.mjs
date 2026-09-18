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

function declaredIconNames() {
  const src = readFileSync(resolve(REPO, "tokens", "icons.js"), "utf8");
  return [...src.matchAll(/^\s*"?([a-z0-9-]+)"?:/gm)].map((m) => m[1]);
}

function declaredTokenNames() {
  const css = readFileSync(resolve(REPO, "tokens", "tokens.css"), "utf8");
  const open = css.indexOf(":root {");
  const close = css.indexOf("}", open);
  const block = css.slice(open + ":root {".length, close);
  const names = [];
  for (const line of block.split("\n")) {
    const match = line.match(/^\s*(--[\w-]+)\s*:/);
    if (match) names.push(match[1]);
  }
  return names;
}

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`token sheet renders in ${engine.name}`, async () => {
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
      await page.goto(`${BASE_URL}/workshop/design/tokens`, { waitUntil: "networkidle" });

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      const rendered = await page.evaluate(() =>
        [...document.querySelector("token-sheet").shadowRoot.querySelectorAll(".name")].map(
          (el) => el.textContent,
        ),
      );
      const declared = declaredTokenNames();
      assert.ok(declared.length > 0, "tokens.css yielded no token names");
      assert.deepEqual(
        new Set(rendered),
        new Set(declared),
        `rendered names differ from tokens.css.\n  only rendered: ${[...new Set(rendered)].filter((n) => !declared.includes(n))}\n  only declared: ${declared.filter((n) => !rendered.includes(n))}`,
      );

      // 7.6: the tokens page shows every icon, each drawn as an svg.
      const icons = await page.evaluate(() =>
        [...document.querySelector("token-sheet").shadowRoot.querySelectorAll(".icons .token")].map((el) => ({
          name: el.querySelector(".icon-name").textContent,
          drawn: el.querySelector("svg path")?.getAttribute("d").length > 0,
        })),
      );
      assert.deepEqual(
        icons.map((i) => i.name),
        declaredIconNames(),
        "the icons section lists tokens/icons.js in order",
      );
      assert.ok(icons.every((i) => i.drawn), "every icon has path data");

      const interReady = await page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check("16px Inter");
      });
      assert.ok(interReady, "Inter is not loaded (document.fonts.check failed)");

      // For a human to look at.
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `tokens-${engine.name}.png`),
        fullPage: true,
      });
    } finally {
      await browser.close();
    }
  });
}
