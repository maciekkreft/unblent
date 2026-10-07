import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The gauge stem page (8): Score sends the post and every question in one request and
// draws a dial, a band word and a leaning per answer on each card. Jev is never called:
// the page's request to its own server is answered here with canned answers.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

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
        assert.equal((await line.textContent()).replace(/\s+/g, " ").trim(), "5 tools · 25 questions in one request · 310 ms");
        assert.equal(sent.length, 1);
        assert.equal(sent[0].state.post, POST);
        assert.equal(await page.locator("gauge-post .card .dial").count(), 5);
        const words = await page.locator("gauge-post .bandword").allTextContents();
        assert.ok(words.every((w) => ["High", "Mixed", "Low"].includes(w)), words.join(","));
        assert.ok((await page.locator("gauge-post .word.unsure").count()) > 0, "an unsure answer is shown as such");
        // The list in the dock shows the same band word as the card.
        const listBands = await page.locator("gauge-list .band").allTextContents();
        assert.deepEqual(listBands, words);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
