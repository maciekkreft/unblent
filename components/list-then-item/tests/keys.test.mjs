import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference (12), seeded the way the settings fact stores it; `/` is in
// the product profile, which keeps its own copy under its own key.
const VIM = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

// The Notes pair's focused child (its light DOM), or null when the keyboard is elsewhere.
const inNotes = (page) =>
  page.evaluate(() => {
    const notes = document.getElementById("notes");
    return [...notes.children].find((c) => c.contains(document.activeElement))?.localName ?? null;
  });

const shown = (page) =>
  page.evaluate(() =>
    document.getElementById("notes").shadowRoot.querySelector("slot").assignedElements().map((e) => e.localName).join(),
  );

for (const engine of ENGINES) {
  test(`Enter on a note lands in the editor and Escape returns to the list on / in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, forgeCookie("list-keys"));
      await context.addInitScript((value) => {
        localStorage.setItem("settings", value);
        localStorage.setItem("settings:product", value);
      }, VIM);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`);
      await page.waitForFunction(() => document.querySelector("note-list")?.shadowRoot?.querySelector("li.draft"));

      await page.evaluate(() => document.querySelector("note-list").shadowRoot.querySelector("li.draft").focus());
      await page.keyboard.press("Enter");
      await until(async () => (await inNotes(page)) === "note-editor");
      assert.equal(await shown(page), "note-editor", "the editor is shown and holds the keyboard");

      // Insert mode claims the first Escape; the next one, unclaimed, goes back.
      await page.keyboard.press("i");
      await page.keyboard.type("Panel keys");
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await shown(page), "note-editor", "the first Escape only leaves insert mode");
      await page.keyboard.press("Escape");
      await until(async () => (await shown(page)) === "note-list");
      assert.equal(await inNotes(page), "note-list", "the keyboard is back on the list");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
