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

// Read the phone breakpoint's driving widths from tokens.css rather than hardcode
// them, so the test tracks the tokens the view uses.
function tokenPx(name) {
  const css = readFileSync(resolve(REPO, "tokens", "tokens.css"), "utf8");
  const match = css.match(new RegExp(`${name}\\s*:\\s*(\\d+)px`));
  assert.ok(match, `${name} is not a px token in tokens.css`);
  return Number(match[1]);
}

// The dock stem seeds one view docked on the right (pages/design/dock), so the
// side is `right` here; the phone drawer is symmetric across left and right.
const state = (page) =>
  page.locator("dock-desk").evaluate((el) => {
    const root = el.shadowRoot;
    const dock = root.querySelector(".dock.right");
    const stage = root.querySelector(".stage");
    const strip = stage.querySelector(".strip");
    const rail = dock.querySelector(".rail");
    const scrim = root.querySelector(".scrim");
    const box = (n) => (n ? n.getBoundingClientRect() : null);
    const within = (a, b) =>
      a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    return {
      host: box(el).width,
      dockPos: getComputedStyle(dock).position,
      dockWidth: Math.round(box(dock).width),
      dockHeight: Math.round(box(dock).height),
      folded: dock.classList.contains("folded"),
      stageWidth: Math.round(box(stage).width),
      stageRight: Math.round(box(stage).right),
      hostRight: Math.round(box(el).right),
      railInStrip: within(box(rail), box(strip)),
      railTablistShown: getComputedStyle(rail.querySelector('[role="tablist"]')).display !== "none",
      scrimOn: scrim.classList.contains("on"),
      scrimVisible: getComputedStyle(scrim).visibility === "visible",
    };
  });

const clickInDesk = (page, selector) =>
  page.locator("dock-desk").evaluate((el, sel) => el.shadowRoot.querySelector(sel).click(), selector);

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`a side dock is a scrim drawer on the phone in ${engine.name}`, async () => {
    const rail = tokenPx("--space-xl");
    const peek = tokenPx("--space-2xl");
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      context.setDefaultTimeout(4000);
      // The phone frame narrows the body (7.5), which is the honest signal the
      // desk's `@container (width < 45rem)` reads; a wide window with a coarse
      // pointer still draws the frame (base.css needs `pointer: fine`).
      await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
      const page = await context.newPage();
      const problems = [];
      page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
      page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
      page.on("requestfailed", (req) =>
        problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
      );
      page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));

      await page.goto(`${BASE_URL}/workshop/design/dock`);
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await page.locator("dock-desk").waitFor();

      // On the phone a fresh desk seeds a side dock folded (6.4), so the stage and
      // its header are never hidden behind a drawer at first sight: it is a button
      // in the header corner, out of the flow, with no scrim, leaving the whole
      // stage width for the body below.
      const seeded = await state(page);
      assert.equal(seeded.dockPos, "absolute", "a folded side dock stays out of the flow, on its gutter");
      assert.ok(Math.abs(seeded.dockWidth - rail) <= 1, "the folded side dock is one token wide");
      assert.ok(Math.abs(seeded.dockHeight - rail) <= 1, "the folded side dock is a square, not a full-height rail");
      assert.ok(seeded.railInStrip, "the folded button sits within the stage header");
      assert.ok(!seeded.railTablistShown, "the folded button hides its tabs; its title names what it holds");
      assert.ok(
        Math.abs(seeded.stageWidth - seeded.host) <= 1,
        "the stage spans the full width; the button costs only header padding",
      );
      assert.ok(!seeded.scrimOn, "no scrim while the drawer is folded");

      // A tap on the rail floats the drawer over the stage (absolute, leaving only a
      // peek), with the scrim dimming it. Wait for the slide to settle, not just for
      // the width to pass the rail, so the peek is measured open and not mid-slide.
      await clickInDesk(page, ".dock.right .rail");
      await page.waitForFunction((peek) => {
        const d = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        const host = document.querySelector("dock-desk").getBoundingClientRect().width;
        return !d.classList.contains("folded") && Math.abs(host - d.getBoundingClientRect().width - peek) <= 1;
      }, peek);
      const open = await state(page);
      assert.equal(open.dockPos, "absolute", "an open side dock overlays the stage as a drawer");
      // Within a pixel: the drawer's edge border rounds the border-box width.
      assert.ok(Math.abs(open.host - open.dockWidth - peek) <= 1, "the drawer leaves a token-wide peek of the stage");
      assert.ok(open.scrimOn && open.scrimVisible, "the scrim dims the peeking stage while the drawer is open");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-desk-phone-drawer-${engine.name}.png`) });

      // A tap on the scrim folds the drawer back to its header button: the forgiving
      // close, one step (Norman). The dock stays out of the flow, so the full-width
      // stage holds one width through every frame of the slide.
      await clickInDesk(page, ".scrim");
      const slide = await page.locator("dock-desk").evaluate(async (el, rail) => {
        const dock = el.shadowRoot.querySelector(".dock.right");
        const stage = el.shadowRoot.querySelector(".stage");
        const widths = new Set();
        const start = performance.now();
        while (dock.getBoundingClientRect().width > rail + 1 && performance.now() - start < 2000) {
          widths.add(Math.round(stage.getBoundingClientRect().width));
          await new Promise((next) => requestAnimationFrame(next));
        }
        return [...widths];
      }, rail);
      assert.deepEqual(slide, [open.stageWidth], "the stage is never squeezed while the drawer folds");
      // The dock slides to the rail width; wait for it to settle, not just for the
      // class, so the measurement is the folded size and not a mid-slide frame.
      // Height steps to the button only at the slide's end, after the width reaches the
      // edge; wait for both so the folded square is measured settled, not mid-slide.
      await page.waitForFunction((rail) => {
        const r = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        const b = r.getBoundingClientRect();
        return r.classList.contains("folded") && b.width <= rail + 1 && b.height <= rail + 1;
      }, rail);
      const folded = await state(page);
      assert.equal(folded.dockPos, "absolute", "a folded side dock stays out of the flow, on its gutter");
      assert.equal(folded.stageWidth, open.stageWidth, "folding the drawer does not resize the stage");
      // Within a pixel: the button's edge border rounds the border-box width.
      assert.ok(Math.abs(folded.dockWidth - rail) <= 1, "a folded side dock is a button one token wide");
      assert.ok(Math.abs(folded.dockHeight - rail) <= 1, "a folded side dock returns to a header-corner square");
      assert.ok(Math.abs(folded.stageWidth - folded.host) <= 1, "the stage spans the full width beside the button");
      assert.ok(!folded.scrimOn, "the scrim clears once no drawer is open");

      // A tap on the button reopens the drawer.
      await clickInDesk(page, ".dock.right .rail");
      await page.waitForFunction((rail) => {
        const d = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        return !d.classList.contains("folded") && d.getBoundingClientRect().width > rail * 3;
      }, rail);
      const reopened = await state(page);
      assert.equal(reopened.dockPos, "absolute", "tapping the button floats the drawer back over the stage");
      assert.ok(reopened.scrimOn, "the scrim returns with the drawer");
      assert.equal(reopened.stageWidth, open.stageWidth, "opening the drawer does not resize the stage");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
