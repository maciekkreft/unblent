import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: the two buttons greyed and named by `undo`, the keys reaching
// them only outside a text box, and the steps surviving a reload in IndexedDB. The
// decisions are tested in Node (this component's, `undo`'s and `values`').
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/undo`;

const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const button = (page, which) => page.locator(`undo-bar button.${which}`);
const card = (page) =>
  page.evaluate(() => document.querySelector("values-sheet").shadowRoot.querySelector(".card")?.innerText.trim() ?? null);

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`undo-bar in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a reload against real storage.
    test("Ctrl+Z undoes adding a value, a reload keeps the step, and Redo makes it again", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("undo-bar"));
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        assert.equal(await button(page, "undo").isDisabled(), true, "nothing to undo yet");
        await page.locator("values-sheet .unplaced .new").click();
        await page.keyboard.type("Courag");
        await page.locator("values-sheet .done").click();
        await until(async () => (await button(page, "undo").getAttribute("title")) === "Undo: add value Courag");
        await page.keyboard.press("Control+z");
        await until(async () => (await card(page)) !== "Courag");
        await until(async () => (await button(page, "redo").getAttribute("title")) === "Redo: add value Courag");

        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await button(page, "redo").getAttribute("title")) === "Redo: add value Courag");
        await button(page, "redo").click();
        await until(async () => (await card(page)) === "Courag");
        assert.equal(await button(page, "redo").isDisabled(), true);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, u undoes outside a text box, and the notice of a removal offers Undo", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("undo-bar-vim"));
      await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
      try {
        const day = new Date();
        const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
        const values = [
          { id: "01J0000000000000000000VAR1", name: "Calm", meaning: "" },
          { id: "01J0000000000000000000VAR2", name: "Kind", meaning: "" },
        ];
        assert.equal((await context.request.put(`${BASE_URL}/api/values/${today}`, { data: { values, baseVersion: null } })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("values-sheet");
        await sheet.locator(".card").click();
        const onRow = () => page.evaluate(() => document.querySelector("values-sheet").shadowRoot.activeElement?.closest(".row")?.dataset.id ?? null);
        await sheet.locator(".row").first().locator(".box").first().click();
        for (let i = 0; i < 2 && !(await page.evaluate(() => document.querySelector("values-sheet").shadowRoot.activeElement?.matches(".row"))); i++)
          await page.keyboard.press("Escape");
        await until(async () => (await onRow()) === values[0].id);
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await page.keyboard.press("Escape");
        const notice = page.locator("notice-stack .notice.removal", { hasText: "Remove value Calm" });
        await notice.waitFor();
        assert.equal(await notice.locator(".timer").count(), 0, "no countdown");
        await page.keyboard.press("u");
        await until(async () => (await sheet.locator(".row").count()) === 2);
        await notice.waitFor({ state: "detached" });
        assert.equal(await button(page, "redo").getAttribute("title"), "Redo: remove value Calm");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
