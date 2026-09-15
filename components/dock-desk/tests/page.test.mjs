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
    const scrim = root.querySelector(".scrim");
    const box = (n) => (n ? n.getBoundingClientRect() : null);
    return {
      host: box(el).width,
      dockPos: getComputedStyle(dock).position,
      dockWidth: Math.round(box(dock).width),
      folded: dock.classList.contains("folded"),
      stageRight: Math.round(box(stage).right),
      hostRight: Math.round(box(el).right),
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

      await page.goto(`${BASE_URL}/design/dock`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await page.locator("dock-desk").waitFor();

      // The stem seeds the side dock open: on the phone that is a drawer floating
      // over the stage (absolute, leaving only a peek), with the scrim dimming it.
      const open = await state(page);
      assert.equal(open.dockPos, "absolute", "an open side dock overlays the stage as a drawer");
      // Within a pixel: the drawer's edge border rounds the border-box width.
      assert.ok(Math.abs(open.host - open.dockWidth - peek) <= 1, "the drawer leaves a token-wide peek of the stage");
      assert.ok(open.scrimOn && open.scrimVisible, "the scrim dims the peeking stage while the drawer is open");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `dock-desk-phone-drawer-${engine.name}.png`) });

      // A tap on the scrim folds the drawer back to its edge rail: the forgiving
      // close, one step (Norman). The dock returns to the flow beside the stage.
      await clickInDesk(page, ".scrim");
      // The dock slides to the rail width; wait for it to settle, not just for the
      // class, so the measurement is the folded size and not a mid-slide frame.
      await page.waitForFunction((rail) => {
        const d = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        return d.classList.contains("folded") && d.getBoundingClientRect().width <= rail + 2;
      }, rail);
      const folded = await state(page);
      assert.equal(folded.dockPos, "relative", "a folded side dock sits in the flow, not over the stage");
      // Within a pixel: the rail's edge border rounds the border-box width.
      assert.ok(Math.abs(folded.dockWidth - rail) <= 1, "a folded side dock is a rail one token wide");
      assert.ok(Math.abs(folded.hostRight - folded.stageRight - rail) <= 1, "the stage sits beside the rail, not under it");
      assert.ok(!folded.scrimOn, "the scrim clears once no drawer is open");

      // A tap on the rail reopens the drawer.
      await clickInDesk(page, ".dock.right .rail");
      await page.waitForFunction((rail) => {
        const d = document.querySelector("dock-desk").shadowRoot.querySelector(".dock.right");
        return !d.classList.contains("folded") && d.getBoundingClientRect().width > rail * 3;
      }, rail);
      const reopened = await state(page);
      assert.equal(reopened.dockPos, "absolute", "tapping the rail floats the drawer back over the stage");
      assert.ok(reopened.scrimOn, "the scrim returns with the drawer");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
