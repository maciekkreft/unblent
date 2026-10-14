import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: the pill opens a sheet with the keyboard in Situation,
// Escape folds it into a card that a reload keeps, with Vim keys on the first Escape
// only leaves insert mode, and on a narrow page the V stands above the boxes rather than
// between them. The decisions are tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const inCards = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("choice-point-cards").shadowRoot), fn.toString());

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`choice-point-cards in ${engine.name}`, { timeout: 20000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("the pill opens a sheet in Situation, Escape folds it to a card, and a reload keeps it", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.click("choice-point-cards .pill");
        await until(async () => (await inCards(page, (root) => root.activeElement?.closest(".box")?.dataset.field)) === "situation");
        await page.keyboard.type("Family dinner");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.type("Listened");
        await page.keyboard.press("Escape");
        const card = () => inCards(page, (root) => root.querySelector(".card")?.innerText.replace(/\s+/g, " ").trim() ?? null);
        await until(async () => (await card()) === "Family dinner AWAY — TOWARDS Listened");
        assert.equal(await inCards(page, (root) => root.activeElement?.className), "card", "the keyboard stays on the folded card");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await card().catch(() => null)) === "Family dinner AWAY — TOWARDS Listened");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("with Vim keys on, the first Escape in a box leaves insert mode and the second folds the sheet", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
      context.setDefaultTimeout(4000);
      try {
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await until(async () => (await inCards(page, (root) => root.querySelector(".pill")?.disabled)) === false);
        await page.click("choice-point-cards .pill");
        await until(async () => (await inCards(page, (root) => root.activeElement?.closest(".box")?.dataset.field)) === "situation");
        await page.keyboard.press("Escape");
        await page.keyboard.type("iWalk");
        await page.keyboard.press("Escape");
        const situation = () => inCards(page, (root) => root.querySelector('.box[data-field="situation"] .cm-content')?.innerText ?? null);
        assert.equal(await situation(), "Walk", "i entered insert mode; the sheet is still open");
        await page.keyboard.press("Escape");
        await until(async () => (await inCards(page, (root) => root.querySelector(".card")?.innerText ?? "")).includes("Walk"));
        assert.equal(await situation(), null, "the sheet folded");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("on a wide page the V stands between the moves, on a phone-wide page above them", async () => {
      const layout = async (width) => {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        context.setDefaultTimeout(4000);
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await page.goto(PAGE, { waitUntil: "domcontentloaded" });
          await page.click("choice-point-cards .pill");
          const box = (sel) => page.locator(`choice-point-cards ${sel}`).boundingBox();
          const [v, away, towards] = [await box(".v"), await box(".field.away"), await box(".field.towards")];
          assert.deepEqual(problems, []);
          return { v, away, towards };
        } finally {
          await context.close();
        }
      };
      const wide = await layout(900);
      assert.ok(wide.away.x + wide.away.width <= wide.v.x && wide.v.x + wide.v.width <= wide.towards.x, "away, V, towards in one row");
      const narrow = await layout(390);
      assert.ok(narrow.v.y + narrow.v.height <= narrow.away.y && narrow.away.y < narrow.towards.y, "the V above away, away above towards");
    });
  });
}
