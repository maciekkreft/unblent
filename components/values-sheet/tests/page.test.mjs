import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// What only a browser shows: Write your values opens the sheet with the keyboard in the
// first name, Enter moves on, Escape folds it into a card that a reload keeps; Alt+Up
// moves a row with the cursor, and with Vim keys on Escape steps onto the row where dd and
// p move it; Jev's marks, their status line and the card's warning, on the desk and the
// phone; Could be's Use and its Undo; removing a value strikes it through
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
  describe(`values-sheet in ${engine.name}`, { timeout: 30000 }, () => {
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
        assert.equal((await context.request.put(`${BASE_URL}/api/values/${dayOf(Date.now())}`, { data: { values, baseVersion: null } })).status(), 200);
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

    // The evaluators, the values checks and the values arrive through the APIs under the
    // test's own login; Jev is answered here through page.route, so no real request is
    // made, and the account is told it has a key.
    for (const where of ["desk", "phone"]) {
      // Browser: rendering and layout.
      test(`on the ${where}, checked lines show Jev's marks, the status line says the answer, and the card warns`, async () => {
        const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie(`values-marks-${where}`));
        try {
          if (where === "phone") await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
          const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
          const [EV, EX, Q, QX, ACT, GOAL] = [id("E1"), id("E2"), id("Q1"), id("Q2"), id("A0"), id("A1")];
          const put = (path, data) => context.request.put(`${BASE_URL}/api/${path}`, { data });
          const options = [
            { id: ACT, name: "A way of acting", description: "", icon: "compass" },
            { id: GOAL, name: "A goal", description: "" },
          ];
          const pick = { id: Q, kind: "pick", text: "What is it?", yes: "", no: "", options, expect: ACT };
          assert.equal((await put(`evaluators/${EV}`, { book: id("B1"), name: "Is it a value?", on: true, baseVersion: null, questions: [pick] })).status(), 200);
          const fits = { id: QX, kind: "yesno", text: "Does it fit?", yes: "", no: "", options: [] };
          assert.equal((await put(`evaluators/${EX}`, { book: id("B1"), name: "Does the example fit?", on: true, baseVersion: null, questions: [fits] })).status(), 200);
          assert.equal((await put("value-checks/settings", { values: EV, examples: EX, baseVersion: null })).status(), 200);
          const values = [
            { id: ID(1), name: "Honest", meaning: "Tell the truth" },
            { id: ID(2), name: "Get rich", meaning: "" },
          ];
          assert.equal((await put(`values/${dayOf(Date.now())}`, { values, baseVersion: null })).status(), 200);
          const page = await context.newPage();
          const problems = watch(page);
          await page.route("**/api/llm", async (route) => {
            const res = await route.fetch();
            const json = await res.json();
            await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true } } });
          });
          await page.route("**/api/llm/decide", (route) => {
            const { state, questions } = route.request().postDataJSON();
            const answers = questions.map((q) => (q.id === Q ? { id: q.id, p: 0.95, choice: /rich/.test(state.text) ? GOAL : ACT } : { id: q.id, p: 0.9 }));
            route.fulfill({ json: { answers, inputTokens: 1, ms: 1 } });
          });
          await page.goto(PAGE, { waitUntil: "domcontentloaded" });
          if (where === "phone") await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
          const sheet = page.locator("values-sheet");
          await sheet.locator(".card .flag").waitFor();
          assert.equal(await inSheet(page, (root) => root.querySelector(".card .flag").previousElementSibling.textContent), "Get rich", "the warning stands beside the value");
          await sheet.locator(".card").click();
          const box = (n, field) => sheet.locator(`.row[data-id="${ID(n)}"] .box[data-field="${field}"]`);
          await box(1, "name").locator(".mark.right svg").waitFor();
          await box(1, "meaning").locator(".mark.plain").waitFor();
          await box(2, "name").locator(".mark.wrong").waitFor();
          assert.equal(await box(2, "meaning").locator(".mark").count(), 0, "an empty example is not checked");
          await box(2, "name").locator(".mark").hover();
          assert.equal(await sheet.locator(".status").innerText(), "A goal · you expect A way of acting");
          const orderShown = () => inSheet(page, (root) => getComputedStyle(root.querySelector(".row .order")).opacity);
          if (where === "phone") assert.equal(await orderShown(), "1", "the move buttons always show on a phone");
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });
    }

    // The evaluator, the values check, the values, Could be set to Echo (which needs no key
    // and calls nothing) and its suggestion, kept under the hash of what it was made from,
    // arrive through the APIs under the test's own login; Jev is answered here through
    // page.route, and the account is told it has a key.
    // Browser: a gesture.
    test("Use puts Could be's suggestion in a red value line, and Undo puts the old one back", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values-could-be"));
      try {
        const id = (tail) => "01J" + "0".repeat(23 - tail.length) + tail;
        const [EV, Q, ACT, GOAL] = [id("E1"), id("Q1"), id("A0"), id("A1")];
        const put = (path, data) => context.request.put(`${BASE_URL}/api/${path}`, { data });
        const options = [
          { id: ACT, name: "A way of acting", description: "" },
          { id: GOAL, name: "A goal", description: "" },
        ];
        const pick = { id: Q, kind: "pick", text: "What is it?", yes: "", no: "", options, expect: ACT };
        assert.equal((await put(`evaluators/${EV}`, { book: id("B1"), name: "Is it a value?", on: true, baseVersion: null, questions: [pick] })).status(), 200);
        assert.equal((await put("value-checks/settings", { values: EV, examples: null, baseVersion: null })).status(), 200);
        const generator = { name: "Could be", on: true, model: "echo", prompt: "Suggest a value.", baseVersion: null };
        assert.equal((await put("generators/generators/value-suggestion", generator)).status(), 200);
        const source = createHash("sha256").update(JSON.stringify({ value: "Get rich", example: "A house", reads: "A goal" })).digest("hex");
        const result = { generator: "value-suggestion", item: ID(1), text: "Building security.", source, baseVersion: null };
        assert.equal((await put(`generators/results/value-suggestion:${ID(1)}`, result)).status(), 200);
        assert.equal((await put(`values/${dayOf(Date.now())}`, { values: [{ id: ID(1), name: "Get rich", meaning: "A house" }], baseVersion: null })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.route("**/api/llm", async (route) => {
          const res = await route.fetch();
          const json = await res.json();
          await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true } } });
        });
        await page.route("**/api/llm/decide", (route) => {
          const { state, questions } = route.request().postDataJSON();
          const answers = questions.map((q) => ({ id: q.id, p: 0.95, choice: state.text === "Get rich" ? GOAL : ACT }));
          route.fulfill({ json: { answers, inputTokens: 1, ms: 1 } });
        });
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("values-sheet");
        await sheet.locator(".card").click();
        const name = sheet.locator(`.row[data-id="${ID(1)}"] .box[data-field="name"] .cm-content`);
        const suggest = sheet.locator(".suggest", { hasText: "Could be Building security" });
        await suggest.waitFor();
        await suggest.getByRole("button", { name: "Use" }).click();
        await until(async () => (await name.innerText()).trim() === "Building security");
        const was = sheet.locator(".suggest.was", { hasText: "Was Get rich" });
        await was.locator(".drain").waitFor();
        assert.equal(await sheet.locator(`.row[data-id="${ID(1)}"] .box[data-field="meaning"] .cm-content`).innerText(), "A house", "the example is kept");
        await was.getByRole("button", { name: /Undo/ }).click();
        await until(async () => (await name.innerText()).trim() === "Get rich");
        await suggest.waitFor();
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
