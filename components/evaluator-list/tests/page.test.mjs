import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The keys every list shares (12, "Vim keys"): arrows always; with Vim keys on, j, k, gg
// and G too.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const JOURNAL = "00000000000000000000000JRN";
const settings = (vimKeys) => JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

const inList = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("evaluator-list").shadowRoot, arg), [fn.toString(), arg]);
const names = (page) => inList(page, (root) => [...root.querySelectorAll(".row .name")].map((n) => n.textContent.trim()));
const focusedName = (page) => inList(page, (root) => root.activeElement?.closest(".row")?.querySelector(".name")?.textContent.trim() ?? null);

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`evaluator-list keys in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Two evaluators of the journal on the server, so the list holds New evaluator,
    // Goals, Values.
    const open = async (vimKeys) => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("evaluator-list"));
      for (const [id, name] of [["01K7TEST0000000000000E0001", "Goals"], ["01K7TEST0000000000000E0002", "Values"]]) {
        const put = await context.request.put(`${BASE_URL}/api/evaluators/${id}`, {
          data: { book: JOURNAL, name, on: true, questions: [], baseVersion: null, deleted: false },
        });
        assert.ok(put.ok(), "an evaluator is on the server");
      }
      await context.addInitScript((v) => localStorage.setItem("settings", v), settings(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
      await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
      await until(async () => (await names(page)).join() === "New evaluator,Goals,Values");
      await inList(page, (root) => root.querySelector('.open[tabindex="0"]').focus());
      return { context, page, problems };
    };

    // Browser: rendering and layout.
    test("signed out, with a book open, the panel shows only the line asking to sign in", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
        await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
        await until(async () => (await inList(page, (root) => root.textContent.trim())) === "Sign in to run evaluators.");
        assert.equal(await inList(page, (root) => root.querySelectorAll(".run, .row, button").length), 0, "no box, no rows, no buttons");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, j, k, G and gg move along the rows and Enter opens", async () => {
      const { context, page, problems } = await open(true);
      try {
        assert.equal(await focusedName(page), "New evaluator");
        await page.keyboard.press("G");
        await until(async () => (await focusedName(page)) === "Values");
        await page.keyboard.press("k");
        await until(async () => (await focusedName(page)) === "Goals");
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        await until(async () => (await focusedName(page)) === "New evaluator");
        await page.keyboard.press("j");
        await until(async () => (await focusedName(page)) === "Goals");
        assert.equal(await inList(page, (root) => root.querySelectorAll('[tabindex="0"]').length), 2, "one row, its tick box and its name, is the tab stop");
        await page.keyboard.press("Enter");
        await until(async () => (await page.evaluate(() => document.querySelector("evaluator-editor").shadowRoot.querySelector("input.title")?.value)) === "Goals");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys off, j does nothing and the arrows move", async () => {
      const { context, page, problems } = await open(false);
      try {
        await page.keyboard.press("j");
        await page.keyboard.press("ArrowDown");
        await until(async () => (await focusedName(page)) === "Goals");
        await page.keyboard.press("j");
        assert.equal(await focusedName(page), "Goals");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
