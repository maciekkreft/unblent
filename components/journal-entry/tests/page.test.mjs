import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The journal's entry, walked as a user would on its stem page, signed in, since signed
// out it only asks to sign in.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const STEM = `${BASE_URL}/workshop/design/journal`;

const SUNDAY = "01K7TEST00000000000000DY01";

const entry = (page) => page.locator("journal-entry");
const editor = (page) => entry(page).locator(".cm-content");
// How many times the text appears on the page: once, in the editor.
const times = (page, text) => entry(page).evaluate((el, t) => el.shadowRoot.textContent.split(t).length - 1, text);
// Types into the editor as a user does: each "\n" presses Enter, which starts a paragraph.
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
        await signedIn(context, forgeCookie("journal-entry"));
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
      assert.equal(await days.locator(".kept").textContent(), "Kept on your account, on every device.");
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
      await page.keyboard.press("Shift+Enter");
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

    run("Enter starts a paragraph drawn as a gap, Shift+Enter breaks the line, and the gap is Body", async (page) => {
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await editor(page).click();
      await page.keyboard.type("Monday");
      await entry(page).locator('button.level[data-level="title"]').click();
      await page.keyboard.press("Enter");
      await page.keyboard.type("Ran");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("Rested");
      const shown = () =>
        entry(page).evaluate((el) =>
          [...el.shadowRoot.querySelectorAll(".cm-line")].map((l) => [l.textContent, l.dataset.level ?? "body", l.classList.contains("cm-gap")]),
        );
      await until(async () => (await shown()).length === 4);
      assert.deepEqual(await shown(), [
        ["Monday", "title", false],
        ["", "body", true],
        ["Ran", "body", false],
        ["Rested", "body", false],
      ]);
      const gap = await entry(page).evaluate((el) => {
        const [, gap, ran] = el.shadowRoot.querySelectorAll(".cm-line");
        return { gap: gap.getBoundingClientRect().height, line: ran.getBoundingClientRect().height };
      });
      assert.ok(gap.gap > 0 && gap.gap < gap.line, `a gap is shorter than a line, saw ${gap.gap} vs ${gap.line}`);
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
      await until(async () => (await stored())[0] === "# Monday\n\nRan\nRested");
    });

    // On the stem page, since on the product the stage itself hides while signed out.
    // Browser: rendering and layout.
    test("signed out, the journal shows only the line asking to sign in", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(STEM, { waitUntil: "domcontentloaded" });
        await until(async () => (await entry(page).evaluate((el) => el.shadowRoot.textContent.trim())) === "Sign in to write in your journal.");
        // The entry's own shadow root: the choice points stay in the page, only not shown.
        assert.equal(await entry(page).evaluate((el) => el.shadowRoot.querySelectorAll(".cm-content, button, slot").length), 0, "no text box, no level buttons");
        assert.equal(await page.locator("choice-point-cards").isVisible(), false, "no choice points");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    run("a source link in the day is drawn as one tag, grey when its highlight is gone, and saved as typed", async (page) => {
      // The product page, where notes answers which highlights exist.
      const link = "[A quote](note:01K7TEST0000000000000000H1)";
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.locator("book-shelf .tile:not(.adding)").filter({ hasText: "Journal" }).click();
      await editor(page).click();
      await page.keyboard.type(`see ${link} end`);
      const tag = entry(page).locator(".cm-source-link");
      await tag.waitFor();
      assert.equal(await tag.count(), 1);
      assert.equal(await tag.locator(".cm-source-label").textContent(), "A quote");
      assert.equal(await tag.locator("svg").count(), 1, "the link icon");
      await until(async () => (await tag.getAttribute("class")).includes("removed"));
      assert.equal(await tag.evaluate((el) => getComputedStyle(el).textDecorationLine), "line-through");
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
      await until(async () => (await stored())[0] === `see ${link} end`);
    });

    // Browser: focus and keys.
    run("with Vim keys on, :q in the product's journal closes the journal's book", async (page) => {
      // The product page, because there books names the journal; its preferences are the product profile's.
      await page.addInitScript(() => localStorage.setItem("settings:product", JSON.stringify({ nav: [], vimKeys: true })));
      const debug = [];
      page.on("console", (msg) => msg.type() === "debug" && debug.push(msg.text()));
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.locator("book-shelf .tile:not(.adding)").filter({ hasText: "Journal" }).click();
      await editor(page).click();
      await until(async () => (await entry(page).locator(".cm-fat-cursor").count()) === 1);
      await until(async () => debug.some((l) => / event book\.opened books → .*journal-entry/.test(l)));
      await page.keyboard.type(":q");
      await page.keyboard.press("Enter");
      await until(async () => debug.some((l) => / event book\.closed journal-entry → /.test(l)));
    });
  });
}
