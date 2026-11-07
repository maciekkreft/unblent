import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The panel's boxes as only a browser shows them: typing against real storage, the keyboard's
// way in and out with Vim keys on and off, and Undo pressed in the top bar. What each save says
// and which steps come of it are decided in Node (machine.test.mjs, bus.test.mjs).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const ID = "01K7TEST00000000000000WHB1";
const ACTUAL = [6, 5, 4, 7, 3, 6, 5, 2];
const WANTED = [9, 7, 6, 8, 7, 6, 7, 6];
const ONE = "What does a 1 look like for you?";
const TEN = "What does a 10 look like for you?";

const dayOf = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
};
// Today's journal day: it ends at 2:00 the next night (13, Journal).
const today = () => dayOf(Date.now() - 2 * 3600e3);

const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("wheel-sheet").shadowRoot), fn.toString());

// The area the keyboard is on, or the class of what else has it inside the view.
const at = (page) => inSheet(page, (root) => root.activeElement?.dataset?.i ?? root.activeElement?.className ?? null);
// The question whose box has the keyboard.
const inBox = (page) => inSheet(page, (root) => (root.activeElement?.classList.contains("cm-content") ? root.activeElement.getAttribute("aria-label") : null));
// The lines of the first box. An empty box's line holds its faint example.
const firstBox = (sheet) => sheet.locator(".box").first().locator(".cm-line").allTextContents();
const storedOne = async (context) => {
  const { wheels } = await (await context.request.get(`${BASE_URL}/api/wheels`)).json();
  return wheels.find((w) => w.id === ID).answers[0].one;
};

async function open(browser, { vim = false, answers } = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("wheelbox"));
  const put = await context.request.put(`${BASE_URL}/api/wheels/${ID}`, { data: { day: today(), actual: ACTUAL, wanted: WANTED, answers, baseVersion: null } });
  assert.equal(put.status(), 200);
  if (vim) await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  const sheet = page.locator("wheel-sheet");
  await sheet.locator(".card").click();
  await sheet.locator(".sheet").waitFor();
  await page.keyboard.press("Enter");
  await sheet.locator(".qs").waitFor();
  return { context, page, problems, sheet };
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`wheel-sheet's boxes in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a reload against real storage.
    test("what is typed in a box survives a reload, several lines included, and moving to another area loads that area's text", async () => {
      const { context, page, problems, sheet } = await open(browser, { answers: [{}, { one: "Dread" }, ...Array(6).fill({})] });
      try {
        await page.keyboard.press("Enter");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.type("jkl first");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("second");
        const squares = () => sheet.locator('.area[data-i="0"] .sq.on').count();
        assert.equal(await squares(), ACTUAL[0], "h, j, k and l are text in a box");
        assert.equal(await sheet.locator('.area[data-i="0"] .arrow').evaluate((a) => a.classList.contains("marked")), true, "the mark comes with the first words");

        await page.keyboard.press("Escape");
        assert.equal(await at(page), "0");
        await page.keyboard.press("ArrowDown");
        assert.equal(await sheet.locator(".q-title span").first().innerText(), "Work");
        assert.deepEqual(await firstBox(sheet), ["Dread"], "the panel shows the new area's text");
        await page.keyboard.press("ArrowUp");
        assert.deepEqual(await firstBox(sheet), ["jkl first", "second"]);

        await page.reload({ waitUntil: "domcontentloaded" });
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        await page.keyboard.press("Enter");
        await sheet.locator(".qs").waitFor();
        assert.deepEqual(await firstBox(sheet), ["jkl first", "second"]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, Enter goes in insert mode, Escape takes one step at a time, and j and k go through the boxes and back to the area", async () => {
      const { context, page, problems, sheet } = await open(browser, { vim: true });
      try {
        await page.keyboard.press("Enter");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.type("jk");
        assert.deepEqual(await firstBox(sheet), ["jk"], "the first key typed is text");

        await page.keyboard.press("Escape");
        assert.equal(await inBox(page), ONE, "first out of insert mode");
        await page.keyboard.press("j");
        await until(async () => (await inBox(page)) === TEN);
        await page.keyboard.press("k");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.press("k");
        await until(async () => (await at(page)) === "0");

        await page.keyboard.press("Enter");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await until(async () => (await at(page)) === "0");
        assert.equal(await sheet.locator(".qs").count(), 1, "out of the box, the panel stays");
        await page.keyboard.press("j");
        await until(async () => (await at(page)) === "1");
        assert.equal(await sheet.locator(".q-title span").first().innerText(), "Work", "j moves on to the next area, with the panel");
        await page.keyboard.press("Escape");
        await until(async () => (await sheet.locator(".qs").count()) === 0);
        await page.keyboard.press("Escape");
        await sheet.locator(".card").waitFor();
        assert.equal(await at(page), "card");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("without Vim keys Escape leaves the box onto its area, and Tab goes through the boxes to the buttons", async () => {
      const { context, page, problems, sheet } = await open(browser);
      try {
        await page.keyboard.press("Tab");
        assert.equal(await inBox(page), ONE, "Tab goes from the area straight to the boxes");
        for (let n = 0; n < 4; n += 1) await page.keyboard.press("Tab");
        assert.equal(await inBox(page), "What would move it one point closer to Wanted?");
        await page.keyboard.press("Tab");
        assert.equal(await at(page), "delete");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Escape");
        await until(async () => (await at(page)) === "0");
        assert.equal(await sheet.locator(".qs").count(), 1);
        await page.keyboard.press("Enter");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await until(async () => (await sheet.locator(".qs").count()) === 0);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("the top bar's Undo takes back one stretch of typing and puts the box back", async () => {
      const { context, page, problems, sheet } = await open(browser, { answers: [{ one: "Tired" }, ...Array(7).fill({})] });
      try {
        await sheet.locator(".box").first().locator(".cm-content").click();
        await page.keyboard.press("End");
        await page.keyboard.type(", worn out");
        await page.locator("undo-bar .undo").click();
        await until(async () => (await firstBox(sheet))[0] === "Tired");
        assert.equal(await sheet.locator(".qs").count(), 1, "the panel stays open");
        await until(async () => (await storedOne(context)) === "Tired");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
