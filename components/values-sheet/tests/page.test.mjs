import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: Write your values opens the sheet with the keyboard in the
// first name, Enter moves on, Escape folds it into a card that a reload keeps; with Vim
// keys on the first Escape only leaves insert mode; removing a value strikes it through
// with Undo until its window ends; and an earlier day's values are read only and say when
// they changed since. The decisions are tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("values-sheet").shadowRoot), fn.toString());
const focusedField = (page) => inSheet(page, (root) => root.activeElement?.closest(".box")?.dataset.field ?? null);
const card = (page) => inSheet(page, (root) => root.querySelector(".card")?.innerText.trim() ?? null);

const dayOf = (ms) => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};
const ID = (n) => `01J0000000000000000000VAR${n}`;

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`values-sheet in ${engine.name}`, { timeout: 20000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a reload against real storage.
    test("Write your values opens a row in the name, Enter moves on, Escape folds to a card a reload keeps", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      // Signed out the journal page asks to sign in and draws no slot.
      await signedIn(context, forgeCookie("values"));
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("values-sheet .new", { hasText: "Write your values" }).click();
        await until(async () => (await focusedField(page)) === "name");
        await page.keyboard.type("Being a present parent");
        await page.keyboard.press("Enter");
        await until(async () => (await focusedField(page)) === "meaning");
        await page.keyboard.type("Time with the kids");
        await page.keyboard.press("Enter");
        assert.equal(await inSheet(page, (root) => root.activeElement?.textContent.trim()), "New value", "after the last box comes New value");
        await page.keyboard.press("Enter");
        await until(async () => (await focusedField(page)) === "name");
        await page.keyboard.type("Honest with people");
        await page.keyboard.press("Escape");
        await until(async () => (await card(page)) === "Being a present parent · Honest with people");
        assert.equal(await inSheet(page, (root) => root.activeElement?.className), "card", "the keyboard stays on the folded card");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await card(page).catch(() => null)) === "Being a present parent · Honest with people");
        await page.locator("values-sheet .card").click();
        assert.equal(await page.locator("values-sheet .when").innerText(), "Changed today");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, the first Escape in a box leaves insert mode and the second folds the sheet", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values"));
      try {
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("values-sheet .new").click();
        await until(async () => (await focusedField(page)) === "name");
        await page.keyboard.type("Kind");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("values-sheet .sheet").count(), 1, "the first Escape left insert mode only");
        await page.keyboard.press("Escape");
        await until(async () => (await card(page)) === "Kind");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("removing a value strikes it through with Undo, which keeps it; once the window ends it is gone", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      const cookie = forgeCookie("values-remove");
      await signedIn(context, cookie);
      await shortUndo(context, 400);
      try {
        const values = [
          { id: ID(1), name: "Honest", meaning: "" },
          { id: ID(2), name: "Kind", meaning: "Gentle with myself too" },
        ];
        const put = await context.request.put(`${BASE_URL}/api/values/${dayOf(Date.now())}`, { data: { values, baseVersion: null } });
        assert.equal(put.status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("values-sheet");
        await sheet.locator(".card").click();
        await sheet.locator(`.row[data-id="${ID(2)}"] .remove`).click();
        await sheet.locator(`.row.removing[data-id="${ID(2)}"] .undo`).click();
        await sheet.locator(`.row[data-id="${ID(2)}"] .box`).first().waitFor();
        await sheet.locator(`.row[data-id="${ID(1)}"] .remove`).click();
        await sheet.locator(".row.removing").waitFor();
        await until(async () => (await sheet.locator(".row.removing").count()) === 0);
        await sheet.locator(".done").click();
        await until(async () => (await card(page)) === "Kind");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // An earlier day and two versions of the values arrive through the APIs under the
    // test's own login.
    // Browser: rendering and layout.
    test("an earlier day shows its own values, read only with Close, and Changed since shows today's", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values-read"));
      try {
        const then = Date.now() - 3 * 864e5;
        const day = dayOf(then);
        const put = (path, data) => context.request.put(`${BASE_URL}/api/${path}`, { data });
        assert.equal((await put("journal/days", { record: { id: "01J00000000000000000000DAY", day, text: "Earlier", editedAt: then }, baseVersion: null })).status(), 200);
        assert.equal((await put(`values/${day}`, { values: [{ id: ID(1), name: "Calm", meaning: "" }], baseVersion: null })).status(), 200);
        assert.equal((await put(`values/${dayOf(Date.now())}`, { values: [{ id: ID(2), name: "Brave", meaning: "" }], baseVersion: null })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("journal-days .row", { hasText: "Earlier" }).click();
        const sheet = page.locator("values-sheet");
        await until(async () => (await card(page)) === "Calm");
        await sheet.locator(".card").click();
        await sheet.locator(".close").waitFor();
        assert.equal(await sheet.locator(".box").count(), 0, "nothing to type in");
        assert.equal(await sheet.locator(".new").count(), 0, "no New value on an earlier day");
        assert.equal(await sheet.locator(".name").innerText(), "Calm");
        await sheet.locator(".since").click();
        await until(async () => (await sheet.locator(".caption").innerText().catch(() => "")) === "Today's values");
        assert.equal(await sheet.locator(".name").innerText(), "Brave");
        await sheet.locator(".back").click();
        await sheet.locator(".since").waitFor();
        await sheet.locator(".close").click();
        await until(async () => (await card(page)) === "Calm");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
