import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The journal's entry, walked as a user would: on its stem page signed out, where Jev is
// never asked, and once on the app page signed in, with Jev's answers made up here by
// answering the page's own request to its server, so no key is ever used.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const STEM = `${BASE_URL}/workshop/design/journal`;
const APP = `${BASE_URL}/workshop/apps/journal`;

// The journal's example detector "Cognitive Distortion": its question and one option.
const DISTORTION = "01K7SEED00000000000000JQ01";
const ALL_OR_NOTHING = "01K7SEED00000000000000JC04";
const SUNDAY = "01K7TEST00000000000000DY01";

const entry = (page) => page.locator("journal-entry");
const editor = (page) => entry(page).locator(".cm-content");
// Each margin block beside the text: the paragraph it sits beside and what it says.
const margins = (page) =>
  entry(page).evaluate((el) =>
    [...el.shadowRoot.querySelectorAll(".margins > .margin")].map((m) => [
      el.shadowRoot.querySelectorAll(".cm-line")[Number(m.dataset.line) - 1].textContent,
      m.textContent.replace(/\s+/g, " ").trim(),
    ]),
  );
// Where each margin block starts against where its paragraph starts, in pixels.
const tops = (page) =>
  entry(page).evaluate((el) =>
    [...el.shadowRoot.querySelectorAll(".margins > .margin")].map((m) => [
      Math.round(el.shadowRoot.querySelectorAll(".cm-line")[Number(m.dataset.line) - 1].getBoundingClientRect().top),
      Math.round(m.getBoundingClientRect().top),
    ]),
  );
// How many times the text appears on the page: once, in the editor.
const times = (page, text) => entry(page).evaluate((el, t) => el.shadowRoot.textContent.split(t).length - 1, text);
// Types into the editor as a user does, a line break as Enter.
const write = async (page, text) => {
  await editor(page).click();
  await page.keyboard.type(text);
};

// Writes records straight into the journal's store in this browser, then reloads, as if
// they had been written on an earlier day.
async function seed(page, { days = [], answers = [] }) {
  await page.evaluate(
    async ({ days, answers }) => {
      const db = await new Promise((ok, no) => {
        const r = indexedDB.open("journal");
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
      });
      const tx = db.transaction(["days", "answers"], "readwrite");
      for (const d of days) tx.objectStore("days").put(d);
      for (const a of answers) tx.objectStore("answers").put(a);
      await new Promise((ok) => (tx.oncomplete = ok));
      db.close();
    },
    { days, answers },
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

    run("typing two paragraphs shows two margin blocks level with them, the text once, the last not finished until the box is left", async (page) => {
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await write(page, "I always ruin my mornings.\nI want to run");
      await until(async () => (await margins(page)).length === 2);
      assert.deepEqual(await margins(page), [
        ["I always ruin my mornings.", ""],
        ["I want to run", "Not finished yet"],
      ]);
      await until(async () => (await tops(page)).every(([line, block]) => Math.abs(line - block) <= 2));
      assert.equal(await times(page, "I always ruin my mornings."), 1, "the text is shown once");
      assert.equal(await entry(page).locator(".reason").textContent(), "Sign in to judge.");
      await editor(page).blur();
      await until(async () => (await margins(page))[1][1] === "");
      // The Days list has today's entry, and says where it is kept.
      const days = page.locator("journal-days");
      await until(async () => (await days.locator(".row .first").first().textContent()) === "I always ruin my mornings.");
      assert.equal(await days.locator(".row .pill").first().textContent(), "today");
      assert.equal(await days.locator(".kept").textContent(), "Kept in this browser. Signing in keeps it on your account.");
    });

    run("an earlier day is read only, with Judge this day and its earlier wording", async (page) => {
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await editor(page).waitFor();
      const text = "I always ruin my mornings.\nNobody likes me.";
      await seed(page, {
        days: [{ id: SUNDAY, day: "2025-03-02", text, editedAt: new Date(2025, 2, 2, 21).getTime(), version: 1 }],
        answers: [
          {
            key: `${DISTORTION}\nI always ruin my mornings.`,
            text: "I always ruin my mornings.",
            wording: { text: "Which distortion is it?", yes: "", no: "", options: [{ id: ALL_OR_NOTHING, name: "All-or-nothing thinking" }] },
            answer: { id: DISTORTION, p: 0.8, choice: ALL_OR_NOTHING },
            at: new Date(2025, 2, 2, 21).getTime(),
            version: 1,
          },
        ],
      });
      await page.locator(`journal-days .row[data-day="${SUNDAY}"]`).click();
      await until(async () => (await entry(page).locator("h2").textContent()) === "Sunday 2 March");
      assert.equal(await editor(page).getAttribute("contenteditable"), "false", "nothing to type in");
      assert.equal(await times(page, "Nobody likes me."), 1, "the text is shown once");
      assert.equal((await entry(page).locator(".status").textContent()).trim(), "Read only");
      assert.equal(await entry(page).locator("button.level").count(), 0, "no level buttons on a day that cannot change");
      const judge = entry(page).locator("button.judge-day");
      assert.equal((await judge.textContent()).trim(), "Judge this day · 2 ¶");
      assert.ok(await judge.isDisabled(), "signed out, Jev cannot be asked");
      const tag = entry(page).locator(".margins > .margin").first().locator(".earlier");
      assert.equal(await tag.textContent(), "earlier wording");
      assert.equal(await tag.getAttribute("title"), "Asked as: Which distortion is it?\nOptions: All-or-nothing thinking");
      assert.match((await margins(page))[0][1], /Cognitive Distortion Cognitive Distortion All-or-nothing thinking sure 80%/);
      // Back to today: the text can be typed in again.
      await page.locator('journal-days .row[data-day="new"]').click();
      await until(async () => (await editor(page).getAttribute("contenteditable")) === "true");
    });

    run("on the app page, a finished paragraph gets Jev's answers in its margin", async (page, context) => {
      const cookie = forgeCookie("journal-entry");
      const res = await fetch(`${BASE_URL}/api/llm`, {
        method: "PUT",
        headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
        body: JSON.stringify({ jevKey: "not-a-real-key" }),
      });
      assert.equal(res.status, 200);
      await signedIn(context, cookie);
      const asked = [];
      await context.route("**/api/llm/decide", (route) => {
        const body = route.request().postDataJSON();
        asked.push(body.state.text);
        const answers = body.questions.map((q) => {
          const o = q.options.find((x) => x.name === "Goal") ?? q.options[0];
          return { id: q.id, p: 0.9, choice: o.id, probabilities: q.options.map((x) => ({ id: x.id, p: x === o ? 0.9 : 0.01 })), confidence: 0.8 };
        });
        route.fulfill({ json: { answers, inputTokens: 40, ms: 5 } });
      });
      await page.goto(APP, { waitUntil: "domcontentloaded" });
      await write(page, "I want to run a marathon.\n");
      await until(async () => /Goal sure 90%/.test((await margins(page))[0]?.[1] ?? ""));
      const [[, margin]] = await margins(page);
      assert.match(margin, /^Cognitive Distortion Cognitive Distortion .* Goals and values Goal or value Goal sure 90%$/);
      assert.deepEqual(asked, ["I want to run a marathon."], "one request for the paragraph");
      await until(async () => (await page.locator("journal-days .kept").textContent()) === "Kept on your account, on every device.");
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

    run("on a phone the answers sit under each paragraph, and the text is shown once", async (page) => {
      await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await write(page, "I always ruin my mornings.\nI want to run");
      const placed = () =>
        entry(page).evaluate((el) => {
          const lines = [...el.shadowRoot.querySelectorAll(".cm-line")];
          return [...el.shadowRoot.querySelectorAll(".margin.under")].map((m) => {
            const above = m.previousElementSibling;
            return [above.textContent, Math.round(m.getBoundingClientRect().top) >= Math.round(above.getBoundingClientRect().bottom), m.textContent.trim(), lines.includes(above)];
          });
        });
      await until(async () => (await placed()).length === 2);
      assert.deepEqual(await placed(), [
        ["I always ruin my mornings.", true, "", true],
        ["I want to run", true, "Not finished yet", true],
      ]);
      assert.equal(await entry(page).locator(".margins > .margin").count(), 0, "no column beside the text");
      assert.equal(await times(page, "I always ruin my mornings."), 1, "the text is shown once");
    });
  });
}
