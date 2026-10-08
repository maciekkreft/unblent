import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference (12), seeded the way settings stores it (the workshop
// profile, since the page is under /workshop/).
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

const inList = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("note-list").shadowRoot, arg), [fn.toString(), arg]);
const rowTitles = (page) => inList(page, (root) => [...root.querySelectorAll(".row .name")].map((n) => n.textContent.trim()));
const focusedTitle = (page) => inList(page, (root) => root.activeElement?.querySelector(".name")?.textContent.trim() ?? null);
const clickRow = (page, title) => inList(page, (root, t) => [...root.querySelectorAll(".row")].find((r) => r.querySelector(".name").textContent.trim() === t)?.click(), title);
// The roving row, where Tab lands in the list.
const focusList = (page) => inList(page, (root) => root.querySelector('.row[tabindex="0"]').focus());
const editorBody = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view.state.doc.toString());
// One edit and a blur, which saves at once (4.3).
const write = (page, text) =>
  page.evaluate((t) => {
    const view = document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    view.contentDOM.dispatchEvent(new FocusEvent("blur"));
  }, text);

for (const engine of ENGINES) {
  describe(`note-list Vim keys in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Two notes written through the editor, so the list holds New note, Second, First.
    const open = async (vimKeys) => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addInitScript((v) => localStorage.setItem("settings", v), seed(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/notes`, { waitUntil: "domcontentloaded" });
      await until(() => page.evaluate(() => Boolean(document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content") && document.querySelector("note-list")?.shadowRoot)));
      await write(page, "First\nbody");
      await until(async () => (await rowTitles(page)).includes("First"));
      await clickRow(page, "New note");
      await until(async () => (await editorBody(page)) === "");
      await write(page, "Second\nbody");
      await until(async () => (await rowTitles(page)).join() === "New note,Second,First");
      return { context, page, problems };
    };

    test("with Vim keys on, j/k, G and gg move along the list and Enter opens", async () => {
      const { context, page, problems } = await open(true);
      try {
        await focusList(page);
        assert.equal(await focusedTitle(page), "Second", "the open note holds the roving focus");
        await page.keyboard.press("k");
        await until(async () => (await focusedTitle(page)) === "New note");
        await page.keyboard.press("G");
        await until(async () => (await focusedTitle(page)) === "First");
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        await until(async () => (await focusedTitle(page)) === "New note");
        await page.keyboard.press("j");
        await until(async () => (await focusedTitle(page)) === "Second");
        await page.keyboard.press("j");
        await page.keyboard.press("Enter");
        await until(async () => (await editorBody(page)) === "First\nbody");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    test("with Vim keys off, j does nothing", async () => {
      const { context, page, problems } = await open(false);
      try {
        await focusList(page);
        await page.keyboard.press("j");
        await page.keyboard.press("G");
        await page.waitForTimeout(200);
        assert.equal(await focusedTitle(page), "Second");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
