// Every page composes (11): each page the pages fact lists loads with every tag on it
// defined and rendered and nothing failing, one short test per page. This is how a
// component's place on a page is covered when the component changes, so its partners'
// suites need not open every page. UNBLENT_PAGES, set by the check, narrows the list
// to the pages a change touched; unset (the push gate) loads them all.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SCREENSHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".screenshots");

// The list comes from this component's own server module, so a new page is covered
// with no edit here; a narrowed address that is not listed fails rather than skips.
const listed = (await (await fetch(`${BASE_URL}/api/pages`)).json()).pages;
const wanted = process.env.UNBLENT_PAGES?.split(",").map((s) => s.trim()).filter(Boolean);
for (const address of wanted ?? []) {
  assert.ok(listed.some((p) => p.path === address), `${address} is not a listed page`);
}
const PAGES = wanted ? listed.filter((p) => wanted.includes(p.path)) : listed;
assert.ok(PAGES.length, "no page to load");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

function watch(page, problems) {
  page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));
}

// Every custom tag on the page is defined and upgraded: Lit attaches the shadow root
// on connect. Not "has children": a view may render nothing (an empty notice stack,
// the nav in the product profile).
const composed = () => {
  const tags = [...document.querySelectorAll("*")].filter((e) => e.localName.includes("-"));
  return tags.length > 0 && tags.every((e) => customElements.get(e.localName) && e.shadowRoot);
};

async function load(context, path, { phone = false } = {}) {
  const problems = [];
  const page = await context.newPage();
  watch(page, problems);
  if (phone) await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(composed);
  if (phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
  await page.waitForLoadState("load");
  // The cold API fetches settle, or the cap passes; a failed one is already in problems.
  await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
  return { page, problems };
}

for (const engine of ENGINES) {
  describe(`the pages compose in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    for (const { path, kind } of PAGES) {
      test(`${path} composes`, async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(4000);
        try {
          const { problems } = await load(context, path);
          assert.deepEqual(problems, [], `${path} reported: ${problems.join("; ")}`);
        } finally {
          await context.close();
        }
      });

      // The product is reviewed in the phone preview too (CLAUDE.md): it composes
      // inside the narrowed body without sideways overflow.
      if (kind === "app") {
        test(`${path} composes on the phone preview`, async () => {
          const context = await browser.newContext();
          context.setDefaultTimeout(4000);
          try {
            const { page, problems } = await load(context, path, { phone: true });
            const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
            assert.ok(fits, `${path} must not overflow sideways on the phone`);
            mkdirSync(SCREENSHOTS, { recursive: true });
            const slug = path === "/" ? "index" : path.replace(/^\//, "").replace(/\//g, "-");
            await page.screenshot({ path: resolve(SCREENSHOTS, `smoke-${slug}-phone-${engine.name}.png`) });
            assert.deepEqual(problems, [], `${path} reported: ${problems.join("; ")}`);
          } finally {
            await context.close();
          }
        });
      }
    }
  });
}
