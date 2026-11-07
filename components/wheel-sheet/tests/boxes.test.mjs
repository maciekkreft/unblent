import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The panel's boxes as only a browser shows them: typing against real storage, the keyboard's
// way in and out with Vim keys on and off, 2:00 with a box in use on a mocked clock, an earlier
// day's answers, and Undo pressed in the top bar. What each save says
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
    test("with Vim keys on and the panel open, j and k walk from an area through its boxes to the next area and back, and past the last area and back", async () => {
      const { context, page, problems, sheet } = await open(browser, { vim: true });
      try {
        const LAST = "What would move it one point closer to Wanted?";
        const onRow = () => page.evaluate(() => document.querySelector("sheet-picker").shadowRoot.activeElement?.className === "new");
        const title = () => sheet.locator(".q-title span").first().innerText();
        const press = async (key, want) => {
          await page.keyboard.press(key);
          await until(async () => (await inBox(page)) === want);
        };
        const pressOnto = async (key, area) => {
          await page.keyboard.press(key);
          await until(async () => (await at(page)) === area);
        };

        await press("j", ONE);
        await press("k", null);
        assert.equal(await at(page), "0");
        await press("j", ONE);
        await press("j", TEN);
        for (let n = 0; n < 3; n += 1) await page.keyboard.press("j");
        await until(async () => (await inBox(page)) === LAST);
        await pressOnto("j", "1");
        assert.equal(await title(), "Work", "the next area, with its questions");
        await press("k", LAST);
        assert.equal(await title(), "Health", "back in the last box of the area before");

        // The arrows keep moving from area to area.
        await pressOnto("Escape", "0");
        await pressOnto("ArrowDown", "1");
        await pressOnto("ArrowUp", "0");

        // Past the last area's last box, and back into it.
        await pressOnto("G", "7");
        await press("j", ONE);
        for (let n = 0; n < 4; n += 1) await page.keyboard.press("j");
        await until(async () => (await inBox(page)) === LAST);
        await page.keyboard.press("j");
        await until(onRow);
        await press("k", LAST);
        assert.equal(await title(), "Fun");

        // A box left typing by a press outside it takes the j as a move, not as text.
        await pressOnto("Escape", "7");
        await page.keyboard.press("Enter");
        await until(async () => (await inBox(page)) === ONE);
        await sheet.locator('.area[data-i="7"] .sq').nth(4).click();
        await until(async () => (await at(page)) === "7");
        await press("j", ONE);
        await press("j", TEN);
        assert.equal(await sheet.locator(".arrow.marked").count(), 0, "every j and k moved, and none was typed");
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
    test("a press on the sheet's own text keeps the keyboard on the area, so j goes on along the sheet rather than out of it", async () => {
      const { context, page, problems, sheet } = await open(browser, { vim: true });
      try {
        await sheet.locator(".q-title").click();
        assert.equal(await at(page), "0");
        await page.keyboard.press("j");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.press("Escape");
        await until(async () => (await at(page)) === "0");
        await page.keyboard.press("ArrowDown");
        await until(async () => (await at(page)) === "1");
        await sheet.locator(".legend").click();
        assert.equal(await at(page), "1");
        assert.equal(await sheet.locator(".qs").count(), 1, "the panel stays open");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("at 2:00 what was typed is kept, the sheet stays to be read, and the keyboard moves from the box onto its area", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        const now = new Date();
        const twenty = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 59, 40);
        const day = dayOf(twenty.getTime() - 2 * 3600e3);
        await context.clock.install({ time: twenty });
        await signedIn(context, forgeCookie("wheeltwo"));
        const answers = [{ one: "Tired" }, ...Array(7).fill({})];
        assert.equal((await context.request.put(`${BASE_URL}/api/wheels/${ID}`, { data: { day, actual: ACTUAL, wanted: WANTED, answers, baseVersion: null } })).status(), 200);
        const record = { id: "01J00000000000000000000DAY", day, text: "Late", editedAt: twenty.getTime() - 3600e3 };
        assert.equal((await context.request.put(`${BASE_URL}/api/journal/days`, { data: { record, baseVersion: null } })).status(), 200);
        // The product page, whose feature is held back until released, so the answer about features
        // is replaced: the day named from its book's contents is the one the page stays on past 2:00.
        await context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: ["wheel-of-life"], shown: ["wheel-of-life"] } }));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.locator("book-shelf .tile", { hasText: "Journal" }).click();
        await page.locator("book-toc .entry").first().click();
        const sheet = page.locator("wheel-sheet");
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        await page.keyboard.press("Enter");
        await sheet.locator(".qs").waitFor();
        await page.keyboard.press("Enter");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.type("Very ");

        await page.clock.fastForward(40000);
        await sheet.locator(".sheet.read").waitFor();
        await until(async () => (await at(page)) === "0");
        assert.equal(await sheet.locator(".box").count(), 0);
        assert.deepEqual(await sheet.locator(".q-read .cm-line").allTextContents(), ["Very Tired"]);
        await until(async () => (await storedOne(context)) === "Very Tired");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("an earlier day's answer shows its list as a list, not its stored marks, and takes no Tab stop", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie("wheelread"));
        const then = Date.now() - 2 * 3600e3 - 3 * 86400e3;
        const day = dayOf(then);
        const answers = [{ lower: "- one\n- [x] two" }, ...Array(7).fill({})];
        assert.equal((await context.request.put(`${BASE_URL}/api/wheels/${ID}`, { data: { day, actual: ACTUAL, wanted: WANTED, answers, baseVersion: null } })).status(), 200);
        const record = { id: "01J00000000000000000000DAY", day, text: "Earlier", editedAt: then };
        assert.equal((await context.request.put(`${BASE_URL}/api/journal/days`, { data: { record, baseVersion: null } })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("journal-days .row", { hasText: "Earlier" }).click();
        const sheet = page.locator("wheel-sheet");
        await sheet.locator(".card").click();
        await sheet.locator('.area[data-i="0"]').waitFor();
        await page.keyboard.press("Enter");
        const lines = sheet.locator(".q-read .cm-line");
        await lines.first().waitFor();
        const text = (await lines.allTextContents()).join("|");
        assert.ok(!text.includes("- ") && !text.includes("[x]"), `no stored marks: ${text}`);
        assert.equal(await sheet.locator(".q-read svg").count(), 1, "the tick is drawn");
        await page.keyboard.press("Tab");
        assert.equal(await at(page), "close");
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
