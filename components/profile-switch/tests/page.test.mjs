import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, watch, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const WAIT = { timeout: 4000, polling: 100 };

// The product page's own behaviour (§12): the hidden door and what each profile shows,
// tested on the page where the door is placed. WebKit first, then Chromium.
const navCount = (page) => page.evaluate(() => document.querySelector("page-nav").shadowRoot.querySelectorAll("a").length);
const navHeight = (page) => page.evaluate(() => document.querySelector("page-nav").getBoundingClientRect().height);
// The control tags the page slotted into the stage strip (6.4): their tag names in
// page order, each in its own named slot (a `button` child draws a pill instead, with
// no slot, so this lists the controls the header carries).
const stageControls = (page) =>
  page.evaluate(() => {
    const wrap = document.querySelector("dock-desk").shadowRoot.querySelector(".stage .strip .controls");
    return wrap ? [...wrap.querySelectorAll("slot")].flatMap((s) => s.assignedElements()).map((e) => e.localName) : null;
  });
const switchHidden = (page, tag) => page.evaluate((t) => getComputedStyle(document.querySelector(t)).display === "none", tag);
const arrangeControls = (page) => page.evaluate(() => document.querySelector("dock-desk").shadowRoot.querySelectorAll(".action:not(.fold)").length);
const sheetPicture = (page) =>
  page.evaluate(() => {
    const r = document.querySelector("settings-sheet").shadowRoot;
    const labels = [...r.querySelectorAll(".switches label")].map((l) => l.textContent);
    return {
      pages: Boolean(r.querySelector("h2")),
      viewport: labels.some((t) => /Viewport switch/.test(t)),
      layout: labels.some((t) => /Layout switch/.test(t)),
    };
  });
const doorPressed = (page) => page.evaluate(() => document.querySelector("profile-switch").shadowRoot.querySelector("button").getAttribute("aria-pressed"));
const doorOpacity = (page) => page.evaluate(() => getComputedStyle(document.querySelector("profile-switch").shadowRoot.querySelector("button")).opacity);

for (const engine of ENGINES) {
  // One browser for both (the launch is the costly part); each test its own context.
  describe(`the product's door in ${engine.name}`, { timeout: 60000 }, () => {
  let browser;
  before(async () => {
    browser = await engine.launch();
  }, { timeout: 30000 });
  after(async () => {
    await browser?.close();
  }, { timeout: 15000 });

  // Browser: a gesture.
  test(`the product hides the workshop behind the toolbox in ${engine.name}`, async () => {
    const problems = [];
    const context = await browser.newContext();
    try {
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1024, height: 768 });
      watch(page, problems);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.querySelector("profile-switch")?.shadowRoot?.querySelector("button") &&
          document.querySelector("settings-sheet")?.shadowRoot?.querySelector(".switches"),
        undefined,
        WAIT,
      );

      // Product: no links, both bar switches hidden, no arrange controls, and the sheet
      // is the production picture — the layout row alone, no Pages section, no viewport row.
      assert.equal(await navCount(page), 0, "no page links in the product");
      // The bar takes no space in the product (§8/§12): its controls live in the
      // stage header (6.4), in page order, so the desk starts at the top of the page.
      assert.equal(await navHeight(page), 0, "the empty nav bar takes no height in the product");
      assert.deepEqual(
        await stageControls(page),
        ["profile-switch", "layout-switch", "session-switch"],
        "the page controls sit in the stage header",
      );
      assert.ok(await switchHidden(page, "viewport-switch"), "the viewport switch is hidden");
      assert.ok(await switchHidden(page, "layout-switch"), "the layout switch is hidden");
      assert.equal(await arrangeControls(page), 0, "no arrange controls on the desk");
      assert.deepEqual(await sheetPicture(page), { pages: false, viewport: false, layout: true }, "the product sheet shows only the layout row");
      assert.equal(await doorPressed(page), "false", "the door reads as not engaged");

      // The door is transparent until hover reveals it (§12).
      assert.equal(await doorOpacity(page), "0", "the toolbox is invisible until hover");
      // The pointer moved over the door, without Playwright's wait for an element it
      // would call visible, which an invisible door is not yet.
      const door = await page.locator("profile-switch button").boundingBox();
      await page.mouse.move(door.x + door.width / 2, door.y + door.height / 2);
      await page.waitForFunction(() => getComputedStyle(document.querySelector("profile-switch").shadowRoot.querySelector("button")).opacity === "1", undefined, WAIT);

      // Through the door into the workshop: the grouped nav and the bar switches return,
      // the sheet fills, and the door reads as engaged.
      await page.locator("profile-switch button").click();
      await page.waitForFunction(() => document.querySelector("page-nav").shadowRoot.querySelectorAll("a").length > 0, undefined, WAIT);
      assert.ok((await navHeight(page)) > 0, "the bar returns with height once it has links (the workshop)");
      assert.ok(!(await switchHidden(page, "viewport-switch")), "the viewport switch returns in the workshop");
      assert.ok(!(await switchHidden(page, "layout-switch")), "the layout switch returns in the workshop");
      assert.ok((await sheetPicture(page)).pages, "the sheet shows the Pages section in the workshop");
      assert.equal(await doorPressed(page), "true", "the door reads as engaged");
      const labels = await page.evaluate(() =>
        [...document.querySelector("page-nav").shadowRoot.querySelectorAll(".label")].map((l) => l.textContent.trim()),
      );
      assert.deepEqual(labels, ["Design", "Stems", "Apps", "Try"], "the nav groups the workshop pages");

      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
    }
  });

  // The chosen profile as settings stores it (§12, local-only; that the door's press
  // stores it is decided in settings' Node tests): the product loads in the workshop.
  // Browser: a reload against real storage.
  test(`the workshop chosen at the door is kept on load, and the door leads back in ${engine.name}`, async () => {
    const problems = [];
    const context = await browser.newContext();
    try {
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
      await context.addInitScript(() => localStorage.setItem("settings:profile", "workshop"));
      const page = await context.newPage();
      await page.setViewportSize({ width: 1024, height: 768 });
      watch(page, problems);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("page-nav")?.shadowRoot?.querySelectorAll("a").length > 0, undefined, WAIT);
      assert.equal(await doorPressed(page), "true", "the workshop profile is kept on load");

      // Back through the same door returns to the product: the links go again.
      await page.locator("profile-switch button").click();
      await page.waitForFunction(() => document.querySelector("page-nav").shadowRoot.querySelectorAll("a").length === 0, undefined, WAIT);
      assert.equal(await navCount(page), 0, "the product hides the links again");

      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
    }
  });
  });
}
