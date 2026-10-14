import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The journal's entry, walked as a user would on its stem page, signed out.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const STEM = `${BASE_URL}/workshop/design/journal`;

const SUNDAY = "01K7TEST00000000000000DY01";

const entry = (page) => page.locator("journal-entry");
const editor = (page) => entry(page).locator(".cm-content");
// How many times the text appears on the page: once, in the editor.
const times = (page, text) => entry(page).evaluate((el, t) => el.shadowRoot.textContent.split(t).length - 1, text);
// Types into the editor as a user does, a line break as Enter.
const write = async (page, text) => {
  await editor(page).click();
  await page.keyboard.type(text);
};

// Writes days straight into the journal's store in this browser, then reloads, as if
// they had been written on an earlier day.
async function seed(page, days) {
  await page.evaluate(
    async (days) => {
      const db = await new Promise((ok, no) => {
        const r = indexedDB.open("journal");
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
      });
      const tx = db.transaction("days", "readwrite");
      for (const d of days) tx.objectStore("days").put(d);
      await new Promise((ok) => (tx.oncomplete = ok));
      db.close();
    },
    days,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

for (const engine of ENGINES) {
  describe(`the journal entry in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    const run = (name, body) =>
      test(name, async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(4000);
        try {
          const page = await context.newPage();
          const problems = watch(page);
          await body(page, context);
          assert.deepEqual(problems, []);
        } finally {
          await context.close();
        }
      });

    run("typing two paragraphs shows the text once, and the Days list has today's entry", async (page) => {
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await write(page, "I always ruin my mornings.\nI want to run");
      await until(async () => (await times(page, "I want to run")) === 1);
      assert.equal(await times(page, "I always ruin my mornings."), 1, "the text is shown once");
      await editor(page).blur();
      // The Days list has today's entry, and says where it is kept.
      const days = page.locator("journal-days");
      await until(async () => (await days.locator(".row .first").first().textContent()) === "I always ruin my mornings.");
      assert.equal(await days.locator(".row .pill").first().textContent(), "today");
      assert.equal(await days.locator(".kept").textContent(), "Kept in this browser. Signing in keeps it on your account.");
    });

    run("an earlier day is read only, without level buttons", async (page) => {
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await editor(page).waitFor();
      const text = "I always ruin my mornings.\nNobody likes me.";
      await seed(page, [{ id: SUNDAY, day: "2025-03-02", text, editedAt: new Date(2025, 2, 2, 21).getTime(), version: 1 }]);
      await page.locator(`journal-days .row[data-day="${SUNDAY}"]`).click();
      await until(async () => (await entry(page).locator("h2").textContent()) === "Sunday 2 March");
      assert.equal(await editor(page).getAttribute("contenteditable"), "false", "nothing to type in");
      assert.equal(await times(page, "Nobody likes me."), 1, "the text is shown once");
      assert.equal(await entry(page).locator("button.level").count(), 0, "no level buttons on a day that cannot change");
      // Back to today: the text can be typed in again.
      await page.locator('journal-days .row[data-day="new"]').click();
      await until(async () => (await editor(page).getAttribute("contenteditable")) === "true");
    });

    run("with Vim keys on, the editor shows Vim's block cursor", async (page) => {
      // The stem page is in the workshop profile, whose preferences settings keeps under its own name.
      await page.addInitScript(() => localStorage.setItem("settings", JSON.stringify({ nav: [], vimKeys: true })));
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await editor(page).click();
      await until(async () => (await entry(page).locator(".cm-fat-cursor").count()) === 1);
    });

    run("the level buttons and Vim's \\1 \\2 \\0 set each line's level, saved as the note's prefixes", async (page) => {
      await page.addInitScript(() => localStorage.setItem("settings", JSON.stringify({ nav: [], vimKeys: true })));
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await editor(page).click();
      await until(async () => (await entry(page).locator(".cm-fat-cursor").count()) === 1);
      await page.keyboard.press("i");
      await page.keyboard.type("Monday");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Run");
      await page.keyboard.press("Escape");
      const levels = () => entry(page).evaluate((el) => [...el.shadowRoot.querySelectorAll(".cm-line")].map((l) => [l.textContent, l.dataset.level ?? "body"]));
      await page.keyboard.type("\\2");
      await until(async () => (await levels())[1]?.[1] === "heading");
      await page.keyboard.type("k\\1");
      await until(async () => (await levels())[0]?.[1] === "title");
      assert.deepEqual(await levels(), [["Monday", "title"], ["Run", "heading"]], "the text holds no markers");
      const bar = entry(page).locator("button.level");
      assert.deepEqual(await bar.allTextContents().then((t) => t.map((x) => x.replace(/\s+/g, " ").trim())), ["\\1 Title", "\\2 Heading", "\\3 Subheading", "\\0 Body"]);
      assert.equal(await entry(page).locator('button.level[aria-pressed="true"]').getAttribute("data-level"), "title", "the cursor line's level is marked");
      // A click sets the cursor line's level too, and leaves the keyboard in the text.
      await page.keyboard.type("j");
      await entry(page).locator('button.level[data-level="subheading"]').click();
      await until(async () => (await levels())[1]?.[1] === "subheading");
      await page.keyboard.type("\\0");
      await until(async () => (await levels())[1]?.[1] === "body");
      await editor(page).blur();
      const stored = () =>
        page.evaluate(async () => {
          const db = await new Promise((ok, no) => {
            const r = indexedDB.open("journal");
            r.onsuccess = () => ok(r.result);
            r.onerror = () => no(r.error);
          });
          const all = await new Promise((ok) => {
            const q = db.transaction("days").objectStore("days").getAll();
            q.onsuccess = () => ok(q.result);
          });
          db.close();
          return all.map((d) => d.text);
        });
      await until(async () => (await stored())[0] === "# Monday\nRun");
    });
  });
}
