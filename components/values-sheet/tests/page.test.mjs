import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: Your values under + Add sheet adds the panel to today's page, which a reload
// keeps, folded with the keyboard on the list when there are values, and Remove from this
// day takes it off; with none it opens the sheet with the keyboard in the first name, Enter
// moves on, Escape folds it into a list with each example under its value, which a reload
// keeps; Alt+Up moves a row with the cursor, and with Vim keys on Escape steps onto the row
// where dd and p move it; removing a value, with x once emptied and with Vim keys at once;
// a press under the heading; j and k out of the sheet and back; and an earlier day's values
// are read only and say when they changed since. Jev's marks and Could be are in
// marks.test.mjs, and the decisions are tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

// The workshop profile's preferences, with Vim keys on.
const VIM_ON = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("values-sheet").shadowRoot), fn.toString());
const focusedField = (page) => inSheet(page, (root) => root.activeElement?.closest(".box")?.dataset.field ?? null);
const isOpen = (page) => inSheet(page, (root) => !!root.querySelector(".sheet"));
// The folded list's values, joined so one string says them in order.
const card = (page) =>
  inSheet(page, (root) => (root.querySelector(".card") ? [...root.querySelectorAll(".card .value")].map((n) => n.textContent.trim()).join(" · ") : null));

// The way in: Your values under + Add sheet.
const addValues = async (page) => {
  await page.locator("sheet-picker .new").click();
  await page.locator('sheet-picker .pick[data-id="values"]').click();
};

const dayOf = (ms) => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};
// Today's journal day: it ends at 2:00 the next night (13, Journal).
const today = () => dayOf(Date.now() - 2 * 3600e3);
const ID = (n) => `01J0000000000000000000VAR${n}`;

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`values-sheet in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a reload against real storage.
    test("adding Your values opens a row in the name, Enter moves on, Escape folds to a card a reload keeps", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      // Signed out the journal page asks to sign in and draws no slot.
      await signedIn(context, forgeCookie("values"));
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("sheet-picker .new").waitFor();
        assert.equal(await page.locator("values-sheet").evaluate((el) => getComputedStyle(el).display), "none", "a day without the panel takes no room");
        await addValues(page);
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
        assert.equal(await inSheet(page, (root) => root.activeElement?.className), "card", "the keyboard stays on the folded list");
        assert.equal(await inSheet(page, (root) => root.querySelector(".card .example").textContent), "Time with the kids", "the example under its value");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await card(page).catch(() => null)) === "Being a present parent · Honest with people");
        await page.locator("values-sheet .card").click();
        await page.locator("values-sheet .done").waitFor();
        assert.equal(await page.locator("values-sheet .when").count(), 0, "no Changed today in the footer");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Yesterday's values arrive through the API under the test's own login, so today has
    // values in force but no version of its own, and so no panel until it is added.
    // Browser: a reload against real storage.
    test("adding Your values shows the panel folded to read, a press on it opens it, a reload keeps it, and Remove from this day takes it off", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values-placed"));
      try {
        const values = [{ id: ID(1), name: "Honest", meaning: "" }];
        const yesterday = dayOf(Date.now() - 2 * 3600e3 - 86400000);
        assert.equal((await context.request.put(`${BASE_URL}/api/values/${yesterday}`, { data: { values, baseVersion: null } })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("values-sheet");
        await addValues(page);
        await until(async () => (await card(page)) === "Honest");
        assert.equal(await isOpen(page), false, "read first, edited on purpose");
        assert.equal(await inSheet(page, (root) => root.activeElement?.className), "card", "the keyboard on the list");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await card(page).catch(() => null)) === "Honest");
        assert.equal(await sheet.locator("h3 button").count(), 0, "no Edit beside the heading");
        await sheet.locator(".card").click();
        await until(async () => (await focusedField(page)) === "name");
        await sheet.locator(".unplace").click();
        await until(async () => (await sheet.evaluate((el) => getComputedStyle(el).display)) === "none");
        await page.reload({ waitUntil: "domcontentloaded" });
        await addValues(page);
        await until(async () => (await card(page)) === "Honest");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // The values arrive through the API under the test's own login.
    // Browser: focus and keys.
    test("Alt+Up moves a row and keeps the cursor; with Vim keys on Escape steps onto the row, dd and p move it", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values-order"));
      try {
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const values = [
          { id: ID(1), name: "Calm", meaning: "" },
          { id: ID(2), name: "Bee", meaning: "" },
          { id: ID(3), name: "Kind", meaning: "" },
        ];
        assert.equal((await context.request.put(`${BASE_URL}/api/values/${today()}`, { data: { values, baseVersion: null } })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("values-sheet");
        const order = () => inSheet(page, (root) => [...root.querySelectorAll(".rows > .row")].map((r) => r.dataset.id));
        const focusedRow = () => inSheet(page, (root) => root.activeElement?.closest(".row")?.dataset.id ?? null);
        const onRow = () => inSheet(page, (root) => (root.activeElement?.matches(".row") ? root.activeElement.dataset.id : null));
        await sheet.locator(".card").click();
        await until(async () => (await focusedField(page)) === "name");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await until(async () => (await focusedRow()) === ID(2));
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Alt+ArrowUp");
        await until(async () => (await order()).join() === [ID(2), ID(1), ID(3)].join());
        assert.equal(await focusedRow(), ID(2), "the keyboard moved with the row");
        assert.equal(await focusedField(page), "name");
        await page.keyboard.type("x");
        await until(async () => (await sheet.locator(`.row[data-id="${ID(2)}"] .box[data-field="name"] .cm-content`).innerText()) === "Bxee");

        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await until(async () => (await onRow()) === ID(2));
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await sheet.locator(`.row.cut[data-id="${ID(2)}"]`).waitFor();
        await page.keyboard.press("j");
        await page.keyboard.press("j");
        await until(async () => (await onRow()) === ID(3));
        await page.keyboard.press("p");
        await until(async () => (await order()).join() === [ID(1), ID(3), ID(2)].join());
        assert.equal(await sheet.locator(".row.cut").count(), 0);
        await until(async () => (await onRow()) === ID(2));
        await page.keyboard.press("Escape");
        await until(async () => (await card(page)) === "Calm · Kind · Bxee");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("x removes a value only once emptied; with Vim keys dd and Escape remove one at once and the next row has the keyboard", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      const cookie = forgeCookie("values-remove");
      await signedIn(context, cookie);
      try {
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const values = [
          { id: ID(1), name: "Honest", meaning: "" },
          { id: ID(2), name: "Kind", meaning: "Gentle with myself too" },
          { id: ID(3), name: "Calm", meaning: "" },
        ];
        const put = await context.request.put(`${BASE_URL}/api/values/${today()}`, { data: { values, baseVersion: null } });
        assert.equal(put.status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("values-sheet");
        await sheet.locator(".card").click();
        const remove = (n) => sheet.locator(`.row[data-id="${ID(n)}"] .remove`);
        assert.equal(await remove(1).getAttribute("aria-disabled"), "true", "a value with words in it stays");
        await remove(1).click({ force: true });
        assert.equal(await sheet.locator(`.row[data-id="${ID(1)}"]`).count(), 1);
        await sheet.locator(`.row[data-id="${ID(1)}"] .box`).first().click();
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Backspace");
        await until(async () => (await remove(1).getAttribute("aria-disabled")) === "false");
        await remove(1).click();
        await until(async () => (await sheet.locator(`.row[data-id="${ID(1)}"]`).count()) === 0);

        const onRow = () => inSheet(page, (root) => (root.activeElement?.matches(".row") ? root.activeElement.dataset.id : null));
        await sheet.locator(`.row[data-id="${ID(2)}"] .box`).first().click();
        // A click may leave Vim in insert or normal mode; Escape until the row has the keyboard.
        for (let i = 0; i < 2 && (await onRow()) !== ID(2); i++) await page.keyboard.press("Escape");
        await until(async () => (await onRow()) === ID(2));
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await sheet.locator(`.row.cut[data-id="${ID(2)}"]`).waitFor();
        await page.keyboard.press("Escape");
        await until(async () => (await sheet.locator(`.row[data-id="${ID(2)}"]`).count()) === 0);
        await until(async () => (await onRow()) === ID(3));
        await sheet.locator(".done").click();
        await until(async () => (await card(page)) === "Calm");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // The journal around the sheet hands a press on anything that cannot take the keyboard
    // to its own text (delegatesFocus); the section must keep it.
    // Browser: focus and keys.
    test("a press under the heading opens the folded sheet, and with it open leaves the journal's text alone", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values-gap"));
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const text = page.locator("journal-entry .cm-content").first();
        await text.click();
        await page.keyboard.type("Today");
        await addValues(page);
        await until(async () => (await focusedField(page)) === "name");
        await page.keyboard.type("Kind");
        await page.locator("values-sheet .done").click();
        await until(async () => (await card(page)) === "Kind");
        const gap = () =>
          inSheet(page, (root) => {
            const h = root.querySelector("h3").getBoundingClientRect();
            const next = root.querySelector("h3").nextElementSibling.getBoundingClientRect();
            return { x: h.x + h.width / 2, y: (h.bottom + next.y) / 2 };
          });
        let at = await gap();
        await page.mouse.click(at.x, at.y);
        await until(async () => (await focusedField(page)) === "name");
        at = await gap();
        await page.mouse.click(at.x, at.y);
        await page.keyboard.type("x");
        assert.equal(await text.innerText(), "Today", "the journal's text took no key");
        assert.equal(await isOpen(page), true, "the sheet stays open");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Today's values arrive through the API under the test's own login.
    // Browser: focus and keys.
    test("with Vim keys on, j and k go on out of the open sheet's first and last rows to the journal's text and + Add sheet, and back to the same row", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values-out"));
      try {
        await context.addInitScript((v) => localStorage.setItem("settings", v), VIM_ON);
        const values = [
          { id: ID(1), name: "Calm", meaning: "" },
          { id: ID(2), name: "Kind", meaning: "" },
        ];
        assert.equal((await context.request.put(`${BASE_URL}/api/values/${today()}`, { data: { values, baseVersion: null } })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator("sheet-picker .new").waitFor();
        // Where the keyboard is: a row of the sheet by its value's id, the journal's text, or
        // the + Add sheet row.
        const at = () =>
          page.evaluate(() => {
            const sheet = document.querySelector("values-sheet");
            if (sheet.matches(":focus-within")) return sheet.shadowRoot.activeElement?.closest(".row")?.dataset.id ?? "sheet";
            if (document.querySelector("sheet-picker").matches(":focus-within")) return "add sheet";
            return document.querySelector("journal-entry").shadowRoot.activeElement?.classList.contains("cm-content") ? "text" : null;
          });
        const press = async (key, want) => {
          await page.keyboard.press(key);
          await until(async () => (await at()) === want);
        };
        await page.locator("values-sheet .card").click();
        await until(async () => (await focusedField(page)) === "name");
        await page.keyboard.press("Escape");
        await press("Escape", ID(1));
        await press("k", "text");
        await press("j", ID(1));
        await press("j", ID(2));
        await press("j", "add sheet");
        await press("k", ID(2));
        assert.equal(await isOpen(page), true, "the sheet stays open");
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
        assert.equal((await put(`values/${today()}`, { values: [{ id: ID(2), name: "Brave", meaning: "" }], baseVersion: null })).status(), 200);
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
