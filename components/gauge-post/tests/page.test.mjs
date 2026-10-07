import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The gauge stem page (8): Score sends the post and every question in one request and
// draws a dial, a band word and a leaning per answer on each card; every Score is kept in
// History, where a pick brings it back and a delete waits out the undo window. Jev is never called:
// the page's request to its own server is answered here with canned answers.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const POST = "Every Friday I write down one thing I got wrong this week. Here is this week's: I reviewed a plan before reading the brief.";

// Leans across the scale, so the cards show every band word and every leaning.
const P = [0.92, 0.7, 0.5, 0.3, 0.1];

for (const engine of ENGINES) {
  describe(`Score on the gauge stem page in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("a Score fills every card from one request", async () => {
      const cookie = forgeCookie("gauge-post");
      // A Jev key must be saved for llm to let a Score through (no-key otherwise).
      const res = await fetch(`${BASE_URL}/api/llm`, {
        method: "PUT",
        headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
        body: JSON.stringify({ jevKey: "not-a-real-key" }),
      });
      assert.equal(res.status, 200);
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, cookie);
        const sent = [];
        await context.route("**/api/llm/decide", (route) => {
          const body = route.request().postDataJSON();
          sent.push(body);
          const answers = body.questions.map((q, i) => ({ id: q.id, p: P[i % P.length] }));
          route.fulfill({ json: { answers, inputTokens: 1200, ms: 310 } });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/gauge`, { waitUntil: "domcontentloaded" });
        const box = page.locator("gauge-post textarea");
        await box.fill(POST);
        const score = page.locator("gauge-post button");
        await until(() => score.isEnabled());
        await score.click();
        const line = page.locator("gauge-post .line");
        await until(async () => (await line.textContent()).includes("310 ms"));
        assert.equal((await line.textContent()).replace(/\s+/g, " ").trim(), "6 tools · 30 questions in one request · 310 ms · $0.000050");
        assert.equal(sent.length, 1);
        assert.equal(sent[0].state.post, POST);
        assert.equal(await page.locator("gauge-post .card .dial").count(), 6);
        const words = await page.locator("gauge-post .bandword").allTextContents();
        assert.ok(words.every((w) => ["High", "Mixed", "Low"].includes(w)), words.join(","));
        assert.ok((await page.locator("gauge-post .word.unsure").count()) > 0, "an unsure answer is shown as such");
        assert.equal(await page.locator("gauge-post .card .headline").count(), 6, "every card names its headline question");
        const cards = (await page.locator("gauge-post .cards").textContent()).replace(/\s+/g, " ");
        assert.ok(!cards.includes("Asked as one question"), "the headline is the score, not a row");
        assert.ok(!/\d/.test(cards), `no number on a card: ${cards}`);
        // The list in the dock shows the same band word as the card.
        const listBands = await page.locator("gauge-list .band").allTextContents();
        assert.deepEqual(listBands, words);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    test("History keeps every Score, brings one back, and deletes with Undo", async () => {
      const cookie = forgeCookie("gauge-history");
      const res = await fetch(`${BASE_URL}/api/llm`, {
        method: "PUT",
        headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
        body: JSON.stringify({ jevKey: "not-a-real-key" }),
      });
      assert.equal(res.status, 200);
      const context = await browser.newContext();
      context.setDefaultTimeout(3000);
      try {
        await signedIn(context, cookie);
        // Long enough to press Undo, short enough to wait out.
        await shortUndo(context, 700);
        // The first Score reads high everywhere, the second low, so the cards tell them apart.
        let calls = 0;
        await context.route("**/api/llm/decide", (route) => {
          const p = calls++ === 0 ? 0.9 : 0.1;
          const answers = route.request().postDataJSON().questions.map((q) => ({ id: q.id, p }));
          route.fulfill({ json: { answers, inputTokens: 10, ms: 5 } });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/gauge`, { waitUntil: "domcontentloaded" });
        const stage = page.locator("gauge-post .page");
        await until(async () => (await stage.textContent()).includes("Nothing scored yet"));
        assert.equal(await page.locator("scoring-list .empty").textContent(), "No scores yet");
        const box = page.locator("gauge-post textarea");
        const score = page.locator("gauge-post button");
        const rows = page.locator("scoring-list .row");
        for (const [i, post] of ["First post\nmore", "Second post"].entries()) {
          await box.fill(post);
          await until(() => score.isEnabled());
          await score.click();
          await until(async () => (await rows.count()) === i + 1);
        }
        assert.match(await rows.nth(0).textContent(), /Second post/);
        assert.equal(await rows.nth(0).getAttribute("aria-selected"), "true", "the newest is the one on the stage");
        assert.deepEqual([...new Set(await page.locator("gauge-post .bandword").allTextContents())], ["Low"]);
        await rows.nth(1).click();
        await until(async () => (await box.inputValue()) === "First post\nmore");
        await until(async () => (await rows.nth(1).getAttribute("aria-selected")) === "true");
        assert.deepEqual([...new Set(await page.locator("gauge-post .bandword").allTextContents())], ["High"]);
        await rows.nth(1).hover();
        await rows.nth(1).locator(".bin").click();
        await page.locator("scoring-list .undo").click();
        assert.equal(await page.locator("scoring-list .undo").count(), 0);
        await rows.nth(1).hover();
        await rows.nth(1).locator(".bin").click();
        await until(async () => (await rows.count()) === 1);
        await until(async () => (await stage.textContent()).includes("Nothing scored yet"));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
