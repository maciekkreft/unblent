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
const margins = (page) =>
  entry(page).evaluate((el) => [...el.shadowRoot.querySelectorAll(".para")].map((p) => [p.querySelector(".text").textContent, p.querySelector(".margin").textContent.replace(/\s+/g, " ").trim()]));

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

    run("typing two paragraphs shows two margin rows, the last not finished until the box is left", async (page) => {
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      const text = entry(page).locator("textarea.text");
      await text.fill("I always ruin my mornings.\nI want to run");
      await until(async () => (await margins(page)).length === 2);
      assert.deepEqual(await margins(page), [
        ["I always ruin my mornings.", ""],
        ["I want to run", "Not finished yet"],
      ]);
      assert.equal(await entry(page).locator(".reason").textContent(), "Sign in to judge.");
      await text.blur();
      await until(async () => (await margins(page))[1][1] === "");
      // The Days list has today's entry, and says where it is kept.
      const days = page.locator("journal-days");
      await until(async () => (await days.locator(".row .first").first().textContent()) === "I always ruin my mornings.");
      assert.equal(await days.locator(".row .pill").first().textContent(), "today");
      assert.equal(await days.locator(".kept").textContent(), "Kept in this browser. Signing in keeps it on your account.");
    });

    run("an earlier day is read only, with Judge this day and its earlier wording", async (page) => {
      await page.goto(STEM, { waitUntil: "domcontentloaded" });
      await entry(page).locator("textarea.text").waitFor();
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
      assert.equal(await entry(page).locator("textarea").count(), 0, "nothing to type in");
      assert.equal((await entry(page).locator(".status").textContent()).trim(), "Read only");
      const judge = entry(page).locator("button.judge-day");
      assert.equal((await judge.textContent()).trim(), "Judge this day · 2 ¶");
      assert.ok(await judge.isDisabled(), "signed out, Jev cannot be asked");
      const tag = entry(page).locator(".para").first().locator(".earlier");
      assert.equal(await tag.textContent(), "earlier wording");
      assert.equal(await tag.getAttribute("title"), "Asked as: Which distortion is it?\nOptions: All-or-nothing thinking");
      assert.match((await margins(page))[0][1], /Cognitive Distortion Cognitive Distortion All-or-nothing thinking sure 80%/);
      // Back to today: the writing box returns.
      await page.locator('journal-days .row[data-day="new"]').click();
      await entry(page).locator("textarea.text").waitFor();
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
      const text = entry(page).locator("textarea.text");
      await text.fill("I want to run a marathon.\n");
      await until(async () => /Goal sure 90%/.test((await margins(page))[0]?.[1] ?? ""));
      const [[, margin]] = await margins(page);
      assert.match(margin, /^Cognitive Distortion Cognitive Distortion .* Goals and values Goal or value Goal sure 90%$/);
      assert.deepEqual(asked, ["I want to run a marathon."], "one request for the paragraph");
      await until(async () => (await page.locator("journal-days .kept").textContent()) === "Kept on your account, on every device.");
    });
  });
}
