import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub"));
const BOOK = "01K00000000000000000000BK1";

// The Slip-Box is not released until the admin releases it (3.1), so the account's
// picture of the features is answered by the route: every feature released and shown.
const showAll = (context) =>
  context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: ["slip-box"], shown: ["slip-box"] } }));

const VIM = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const PANEL = "note-editor:not([stage])";
const inPanel = (page, fn) => page.evaluate(([sel, body]) => new Function("root", body)(document.querySelector(sel).shadowRoot), [PANEL, fn]);
const lines = (page) => inPanel(page, `return [...root.querySelectorAll(".cm-line")].map((l) => [l.textContent, l.className.match(/cm-level-(\\w+)/)?.[1] ?? "body"])`);
const untouched = [["Literature Note", "title"], ["", "body"], ["", "body"]];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const engine of ENGINES) {
  // Browser: focus and keys (where the keyboard lands in the pre-written text, on a new
  // note picked in the list, in insert mode, and on the empty page after an Undo, in normal).
  test(`a new literature note takes the keyboard below its title in ${engine.name}`, async () => {
    const cookie = forgeCookie("editor-literature");
    const put = (path, type, body) => fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    await put(`/api/books/${BOOK}`, "application/epub+zip", SAMPLE);
    await put(`/api/books/${BOOK}/opened`, "application/json", "{}");
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, cookie);
      await showAll(context);
      await context.addInitScript((v) => ["settings", "settings:product"].forEach((key) => localStorage.setItem(key, v)), VIM);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await until(() =>
        page.evaluate(() => {
          const tile = [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile") ?? [])].find((t) => t.textContent.includes("Sample Book"));
          tile?.click();
          return Boolean(tile);
        }),
      );
      await until(() =>
        page.evaluate(() => {
          const row = [...(document.querySelector("note-list")?.shadowRoot?.querySelectorAll("li") ?? [])].find((l) => l.textContent.includes("New note"));
          row?.click();
          return Boolean(row);
        }),
      );
      await until(async () => same(await lines(page), untouched));
      await inPanel(page, `root.querySelector(".cm-content").focus()`);
      await page.keyboard.type("Mine");
      assert.deepEqual(await lines(page), [["Literature Note", "title"], ["", "body"], ["Mine", "body"]]);
      await page.keyboard.press("Escape");
      await inPanel(page, `root.querySelector(".cm-content").blur()`);

      // Undo takes the note back to the empty page, where nobody picked a note: normal mode.
      await until(() =>
        page.evaluate(() => {
          const undo = document.querySelector("undo-bar")?.shadowRoot?.querySelector("button.undo:not(:disabled)");
          undo?.click();
          return Boolean(undo);
        }),
      );
      await until(async () => same(await lines(page), untouched));
      await inPanel(page, `root.querySelector(".cm-content").focus()`);
      await page.keyboard.press("i");
      await page.keyboard.type("Again");
      assert.deepEqual(await lines(page), [["Literature Note", "title"], ["", "body"], ["Again", "body"]]);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
