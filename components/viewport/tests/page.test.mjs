import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium, devices } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

// Read the phone width from tokens.css rather than hardcode it, so the test tracks
// the token (as tokenPair reads a colour in the color-scheme page test).
function tokenPx(name) {
  const css = readFileSync(resolve(REPO, "tokens", "tokens.css"), "utf8");
  const match = css.match(new RegExp(`${name}\\s*:\\s*(\\d+)px`));
  assert.ok(match, `${name} is not a px token in tokens.css`);
  return Number(match[1]);
}

const bodyWidth = (page) => page.evaluate(() => document.body.getBoundingClientRect().width);
const clickSwitch = (page, label) =>
  page.evaluate((label) => {
    for (const b of document.querySelector("viewport-switch").shadowRoot.querySelectorAll("button")) {
      if (b.textContent.trim() === label) b.click();
    }
  }, label);
// The pressed button is the switch's own picture of the fact: proof it followed
// viewport.changed rather than its click (4.3, fourth rule). This is the one
// thing the switch's view does that its machine test cannot show, so it is
// checked here, on the stem, rather than in a browser test of its own.
const pressed = (page) =>
  page.evaluate(() =>
    document
      .querySelector("viewport-switch")
      .shadowRoot.querySelector('button[aria-pressed="true"]')
      ?.textContent.trim(),
  );

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the phone preview follows the viewport fact in ${engine.name}`, async () => {
    const phoneWidth = tokenPx("--viewport-phone");
    const browser = await engine.launch();
    try {
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

      await page.goto(`${BASE_URL}/design/tokens`);
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "desk");
      assert.equal(await pressed(page), "Desk");
      const deskWidth = await bodyWidth(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      await clickSwitch(page, "Phone");
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      assert.equal(await pressed(page), "Phone");
      assert.equal(await bodyWidth(page), phoneWidth, "the body should be the phone's width");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `viewport-phone-${engine.name}.png`) });

      // A real wheel rather than a computed-style check, because the failure this
      // guards against is overflow propagating from body to the window, which
      // only shows in where the scroll lands (base.css, 7.5).
      const scroller = await page.evaluate(() => ({
        canScroll: document.body.scrollHeight > document.body.clientHeight,
        cx: Math.round(window.innerWidth / 2),
        cy: Math.round(window.innerHeight / 2),
      }));
      assert.ok(scroller.canScroll, "the tokens page should overflow the screen so it can scroll");
      await page.mouse.move(scroller.cx, scroller.cy);
      await page.mouse.wheel(0, 1200);
      await page.waitForFunction(() => document.body.scrollTop > 0);
      const scrolled = await page.evaluate(() => ({ winY: window.scrollY, bodyTop: document.body.scrollTop }));
      assert.equal(scrolled.winY, 0, "the window must not scroll; the phone stays put");
      assert.ok(scrolled.bodyTop > 0, "the screen content must scroll inside the phone");
      await page.evaluate(() => (document.body.scrollTop = 0));

      // A reload is the cheapest proof that the choice follows the page (3.1,
      // local-only): the store is not tested apart from it.
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      assert.equal(await bodyWidth(page), phoneWidth, "the phone frame should survive a reload");

      await clickSwitch(page, "Desk");
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "desk");
      assert.equal(await pressed(page), "Desk");
      assert.equal(await bodyWidth(page), deskWidth, "the desk body fills the window");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      // A phone never previews a phone: the choice is stored before the page
      // loads, so one load shows both that the switch is hidden on a coarse
      // pointer and that no frame is drawn even though the fact says phone.
      const phone = await browser.newContext({ ...devices["iPhone 14"] });
      await phone.addInitScript(() => localStorage.setItem("viewport", "phone"));
      const small = await phone.newPage();
      await small.goto(`${BASE_URL}/design/tokens`);
      await small.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      assert.equal(
        await small.evaluate(() => getComputedStyle(document.querySelector("viewport-switch")).display),
        "none",
        "the switch is hidden on a touch device",
      );
      const { w, iw } = await small.evaluate(() => ({
        w: document.body.getBoundingClientRect().width,
        iw: window.innerWidth,
      }));
      assert.equal(w, iw, "no frame is drawn on a phone");
      await phone.close();
    } finally {
      await browser.close();
    }
  });
}
