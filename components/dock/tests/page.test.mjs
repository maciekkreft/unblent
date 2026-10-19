import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The dock on the phone: its own start (the phone preview and a stored layout before the
// load), so it stays out of journey.test.mjs, which tells the desk's story.
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

// The dock's layout is stored under a page-scoped key (dock/store.js), so the stem's
// arrangement never clobbers an app desk's.
const DOCK_KEY = "dock:/workshop/design/dock";

const clickTab = (page, group, label) =>
  page.evaluate(
    ({ group, label }) => {
      [...document.querySelector("dock-desk").shadowRoot.querySelectorAll(`${group} [role="tab"]`)]
        .find((b) => b.textContent.trim() === label)
        ?.click();
    },
    { group, label },
  );
// Clicking the container element itself makes its own click the target, clear of any
// tab or action button inside it.
const clickBar = (page, scope) =>
  page.evaluate((scope) => {
    const el = document.querySelector("dock-desk").shadowRoot.querySelector(scope);
    if (!el) throw new Error(`no bar ${scope}`);
    el.click();
  }, scope);
const rect = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector("dock-desk").shadowRoot.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }, sel);
const shadowHas = (page, sel) =>
  page.evaluate((sel) => Boolean(document.querySelector("dock-desk").shadowRoot.querySelector(sel)), sel);
// Playwright's visibility: a box, and no visibility:hidden, so a folded panel's
// child counts as hidden and a hidden slot's child too.
const visible = (page, name) => page.locator(name).isVisible();
const railWidth = (page) =>
  page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector("dock-desk").shadowRoot.querySelector(".strip")).height),
  );

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

function watch(page) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  return problems;
}

const ready = (page) =>
  page.waitForFunction(() => document.querySelector("dock-desk")?.shadowRoot?.querySelector(".stage .body"));

// A page on the dock stem in the phone preview, starting from a stored layout (3.1,
// local-only: the fact reads localStorage).
async function open(browser, { layout }) {
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addInitScript(
    ({ layout, key }) => {
      localStorage.setItem("viewport", "phone");
      localStorage.setItem(key, JSON.stringify(layout));
    },
    { layout, key: DOCK_KEY },
  );
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/dock`);
  await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
  await ready(page);
  return { context, page, problems };
}

const clean = (page) =>
  page.evaluate((key) => {
    localStorage.removeItem(key);
    localStorage.removeItem("viewport");
  }, DOCK_KEY);

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  describe(`dock in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => { browser = await engine.launch(); }, { timeout: 30000 });
    after(async () => { await browser?.close(); }, { timeout: 15000 });

  // Browser: rendering and layout.
  test(`a side dock is a scrim drawer and a bottom dock a sheet on the phone in ${engine.name}`, async () => {
    const { context, page, problems } = await open(browser, {
      layout: {
        stage: "token-sheet",
        docks: { left: { open: true, views: ["trace-list"] }, bottom: { open: false, views: ["contract-list"] } },
      },
    });
    try {
      await until(async () => await shadowHas(page, ".dock.bottom"));
      const strip = await railWidth(page);
      // The open left dock enters as a drawer floating over the stage; wait until
      // it has slid to its overlay width before measuring.
      await until(async () => (await rect(page, ".dock.left")).width > strip * 3);

      const scrim = () =>
        page.evaluate(() => {
          const s = document.querySelector("dock-desk").shadowRoot.querySelector(".scrim");
          return { on: s.classList.contains("on"), visible: getComputedStyle(s).visibility === "visible" };
        });
      const position = (sel) =>
        page.evaluate((sel) => getComputedStyle(document.querySelector("dock-desk").shadowRoot.querySelector(sel)).position, sel);

      const body = await page.evaluate(() => {
        const r = document.body.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom };
      });
      const stage = await rect(page, ".stage");
      const left = await rect(page, ".dock.left");
      const bottom = await rect(page, ".dock.bottom");

      // No sideways scroll inside the phone screen.
      const overflow = await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
      assert.ok(overflow <= 1, `no horizontal overflow, saw ${overflow}px`);

      // The left dock is a drawer: it floats over the stage from the left edge,
      // not under it, leaving the stage peeking on the right, with the scrim
      // dimming the peek.
      assert.equal(await position(".dock.left"), "absolute", "an open side dock overlays the stage");
      assert.ok(left.top <= stage.top + 1, "the drawer covers the stage, it is not under it");
      assert.ok(left.left <= body.left + 1, "the left drawer sits on the left edge");
      assert.ok(left.right < stage.right - 1, "the drawer leaves a slice of the stage peeking");
      const s1 = await scrim();
      assert.ok(s1.on && s1.visible, "the scrim dims the peeking stage");
      assert.ok(await visible(page, "trace-list"), "the docked trace reads in the drawer");

      // The bottom dock stays a sheet: under the stage, full width, folded here to
      // just its strip (it started closed). A folded side dock is only a header-
      // corner button, so the sheet below runs the full width past it.
      assert.ok(bottom.top >= stage.bottom - 1, "the bottom dock is under the stage");
      assert.ok(Math.abs(bottom.width - (body.right - body.left)) <= 1, "the bottom sheet is full width");
      assert.ok(Math.abs(bottom.height - strip) <= 2, "a folded bottom sheet is its strip");
      assert.ok(
        bottom.left >= body.left - 1 && bottom.right <= body.right + 1 && bottom.bottom <= body.bottom + 1,
        "inside the frame",
      );

      // Tap the scrim to close the drawer: it folds to a header-corner button, out
      // of the flow, with the stage spanning the full width and the scrim cleared
      // (the forgiving close).
      await clickBar(page, ".scrim");
      // Height steps to the button only at the end of the slide (dock-desk), after the
      // width has reached the edge; wait for both, so the square is measured settled.
      await until(async () => {
        const r = await rect(page, ".dock.left");
        return r.width <= strip + 2 && r.height <= strip + 2;
      });
      const folded = await rect(page, ".dock.left");
      assert.equal(await position(".dock.left"), "absolute", "a folded side dock stays on its edge, out of the flow");
      assert.ok(Math.abs(folded.width - strip) <= 2, "a folded side dock is one token wide");
      assert.ok(Math.abs(folded.height - strip) <= 2, "a folded side dock is a header-corner square, not a full-height rail");
      const stageFolded = await rect(page, ".stage");
      assert.ok(Math.abs(stageFolded.width - (body.right - body.left)) <= 1, "the stage spans the full width past the button");
      assert.ok(Math.abs(stageFolded.width - stage.width) <= 1, "folding the drawer does not resize the stage");
      assert.ok(!(await scrim()).on, "the scrim clears once no drawer is open");
      await until(async () => !(await visible(page, "trace-list")), 1000).catch(() =>
        assert.fail("the folded drawer hides its body"),
      );

      // With no drawer over it, the bottom sheet still works: unfold it on its tab.
      await clickTab(page, ".dock.bottom .rail", "Contracts");
      await until(async () => (await rect(page, ".dock.bottom")).height > strip * 3);
      assert.ok(await visible(page, "contract-list"), "the bottom sheet opens on its tab");

      // Tap the rail to reopen the drawer, scrim and all.
      await clickBar(page, ".dock.left .rail");
      await until(async () => (await rect(page, ".dock.left")).width > strip * 3);
      assert.ok((await scrim()).on, "the scrim returns with the drawer");
      assert.ok(await visible(page, "trace-list"), "the drawer reopens from a rail tap");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-phone-${engine.name}.png`), fullPage: true });

      await clean(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
    }
  });

  });
}
