import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// What only a browser shows of Jev's marks on the values: the marks, their status line and
// the card's warning, on the desk and the phone; Done folding the sheet while a mark's answer
// is in the status line; and Could be's Use. The rest of the sheet is in page.test.mjs, and
// the decisions are tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/design/journal`;

const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("values-sheet").shadowRoot), fn.toString());
// The folded list's values, joined so one string says them in order.
const card = (page) =>
  inSheet(page, (root) => (root.querySelector(".card") ? [...root.querySelectorAll(".card .value")].map((n) => n.textContent.trim()).join(" · ") : null));

const dayOf = (ms) => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};
// Today's journal day: it ends at 2:00 the next night (13, Journal).
const today = () => dayOf(Date.now() - 2 * 3600e3);
const ID = (n) => `01J0000000000000000000VAR${n}`;


// Two evaluators and the values checks that use them, and today's values "Honest" and
// "Get rich", arrive through the APIs under the test's own login; Jev is answered through
// page.route, so no real request is made: "Get rich" is A goal where A way of acting is
// expected. The account is told it has a key.
async function withMarks(context) {
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
  assert.equal((await put(`values/${today()}`, { values, baseVersion: null })).status(), 200);
  const page = await context.newPage();
  await page.route("**/api/llm", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true }, decider: { ...json.decider, ready: true } } });
  });
  await page.route("**/api/llm/decide", (route) => {
    const { state, questions } = route.request().postDataJSON();
    const answers = questions.map((q) => (q.id === Q ? { id: q.id, p: 0.95, choice: /rich/.test(state.text) ? GOAL : ACT } : { id: q.id, p: 0.9 }));
    route.fulfill({ json: { answers, inputTokens: 1, ms: 1 } });
  });
  return page;
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`values-sheet marks in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // The marks come from withMarks.
    for (const where of ["desk", "phone"]) {
      // Browser: rendering and layout.
      test(`on the ${where}, checked lines show Jev's marks, the status line says the answer, and the card warns`, async () => {
        const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
        context.setDefaultTimeout(4000);
        await signedIn(context, forgeCookie(`values-marks-${where}`));
        try {
          if (where === "phone") await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
          const page = await withMarks(context);
          const problems = watch(page);
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
          assert.equal(await sheet.locator(".status").innerText(), "Is it a value?: A goal, you expect A way of acting", "what was checked, then the answer");
          const orderShown = () => inSheet(page, (root) => getComputedStyle(root.querySelector(".row .order")).opacity);
          if (where === "phone") assert.equal(await orderShown(), "1", "the move buttons always show on a phone");
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });
    }

    // Pressing Done takes the cursor out of the checked line, which empties the status
    // line; Done must stay where it was pressed until the button is released.
    // Browser: a gesture.
    test("with a mark's answer in the status line, a press and release on Done folds the sheet", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("values-done-marks"));
      try {
        const page = await withMarks(context);
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        const sheet = page.locator("values-sheet");
        await sheet.locator(".card").click();
        const name = sheet.locator(`.row[data-id="${ID(2)}"] .box[data-field="name"]`);
        await name.locator(".mark.wrong").waitFor();
        await name.locator(".cm-content").click();
        await until(async () => (await sheet.locator(".status").innerText()) === "Is it a value?: A goal, you expect A way of acting");
        const at = await sheet.locator(".done").boundingBox();
        await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(100);
        assert.deepEqual(await sheet.locator(".done").boundingBox(), at, "Done stays under the pointer");
        await page.mouse.up();
        await until(async () => (await card(page)) === "Honest · Get rich");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // The evaluator, the values check, the values, Could be set to Echo (which needs no key
    // and calls nothing) and its suggestion, kept under the hash of what it was made from,
    // arrive through the APIs under the test's own login; Jev is answered here through
    // page.route, and the account is told it has a key.
    // Browser: a gesture.
    test("Use puts Could be's suggestion in a red value line and keeps the example", async () => {
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
        assert.equal((await put(`values/${today()}`, { values: [{ id: ID(1), name: "Get rich", meaning: "A house" }], baseVersion: null })).status(), 200);
        const page = await context.newPage();
        const problems = watch(page);
        await page.route("**/api/llm", async (route) => {
          const res = await route.fetch();
          const json = await res.json();
          await route.fulfill({ response: res, json: { ...json, jev: { ...json.jev, keySet: true }, decider: { ...json.decider, ready: true } } });
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
        assert.equal(await sheet.locator(`.row[data-id="${ID(1)}"] .box[data-field="meaning"] .cm-content`).innerText(), "A house", "the example is kept");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
