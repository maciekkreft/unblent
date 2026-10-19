import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// Starters, the whole way (5, 8): the admin ticks an evaluator in Administration ›
// Starters, a fresh browser opens the Evaluators try page and finds a copy of it in the
// Journal before anything is made on the server, runs it as a guest, and finds it again
// after a reload, now the guest's own on the server. The admin's cookie is forged as
// session's server module sets it, and only who is the admin (the registry has no
// passkey account here) is answered by request routing. Jev is answered by request
// routing too, and llm's picture is told a guest key is saved, so nothing is spent and
// no key is used; what a request costs is tested in llm's spending test.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forge, signedIn } = await import(process.env.UNBLENT_KIT);

const { ulid } = await import("ulid");

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory");

const JOURNAL = "00000000000000000000000JRN";
const QUESTION = { id: "01K7TEST0000000000000S0Q01", kind: "yesno", text: "Is it kind?", yes: "", no: "", options: [] };
// A name of this run's own, so a starter ticked by another run on the same server is
// told apart.
const NAME = `Kind or harsh ${Date.now().toString(36)}`;

const listText = (page) => page.evaluate(() => document.querySelector("evaluator-list").shadowRoot.textContent.replace(/\s+/g, " "));

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`Starters in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a gesture.
    test("the admin ticks an evaluator in Administration › Starters", async () => {
      const adminId = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const admin = forge(`${adminId}|admin`);
      const id = ulid();
      const saved = await fetch(`${BASE_URL}/api/evaluators/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", Cookie: `unblent_session=${admin}` },
        body: JSON.stringify({ book: JOURNAL, name: NAME, on: true, questions: [QUESTION], baseVersion: null, deleted: false }),
      });
      assert.equal(saved.status, 200);

      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, admin);
        await context.route(/\/api\/session\/me$/, (route) =>
          route.fulfill({ json: { userId: adminId, registrationOpen: false, admin: true, name: "Admin" } }),
        );
        await context.route(/\/api\/session\/people$/, (route) => route.fulfill({ json: { people: [] } }));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.locator("dock-desk .controls button.pill").click();
        await page.locator('settings-tabs [role="tab"]', { hasText: "Administration" }).click();

        const group = page.locator("evaluator-starters .try");
        await group.waitFor();
        assert.match(await group.locator(".head").innerText(), new RegExp(`Evaluators\\s+${new URL(BASE_URL).host}/try/evaluators\\s+Copy link`));
        const box = page.locator("evaluator-starters label.check", { hasText: NAME }).locator("input");
        assert.equal(await box.isChecked(), false);
        await box.check();
        // The tab coming back into view sends what waits at once (5), instead of after the
        // pause a run of edits waits for.
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await until(async () => {
          const res = await fetch(`${BASE_URL}/api/evaluators/starters/evaluators`);
          return (await res.json()).evaluators.some((e) => e.name === NAME);
        });
        assert.equal(await box.isChecked(), true);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: a page's composition.
    test("a fresh browser finds a copy on the try page, runs it as a guest, and keeps it", async () => {
      const context = await browser.newContext();
      try {
        context.setDefaultTimeout(4000);
        await context.route(/\/api\/llm$/, async (route) => {
          const response = await route.fetch();
          const picture = await response.json();
          await route.fulfill({ response, json: picture.freeUse ? { ...picture, jev: { keySet: true }, freeUse: { left: 1, blocked: false, paused: [] } } : picture });
        });
        await context.route(/\/api\/llm\/decide$/, (route) => {
          const { questions } = route.request().postDataJSON();
          return route.fulfill({ json: { answers: questions.map((q) => ({ id: q.id, p: 0.8 })), inputTokens: 40, ms: 5 } });
        });
        const page = await context.newPage();
        const problems = watch(page);
        const writes = [];
        page.on("request", (r) => r.method() !== "GET" && r.url().includes("/api/") && writes.push(new URL(r.url()).pathname));

        await page.goto(`${BASE_URL}/try/evaluators`, { waitUntil: "domcontentloaded" });
        await until(async () => (await listText(page)).includes(NAME));
        assert.match(await listText(page), /About: Journal/);
        assert.deepEqual(writes, [], "the copy is made in this browser, nothing on the server");

        await page.getByRole("textbox", { name: "Write one sentence per line" }).click();

        await page.keyboard.insertText("You did your best today.");
        await page.getByRole("button", { name: "Evaluate 1 line" }).click();
        await until(async () => (await page.locator("evaluator-list .marks").count()) === 1);
        assert.equal(writes[0], "/api/session/guest", "the first Run makes the guest");

        // The copy is uploaded as the guest's own, with an id of its own, in the Journal.
        let mine = [];
        await until(async () => {
          mine = (await (await context.request.get(`${BASE_URL}/api/evaluators?since=0`)).json()).evaluators.filter((e) => e.name === NAME);
          return mine.length === 1;
        });
        assert.equal(mine[0].book, JOURNAL);
        assert.equal("starterFor" in mine[0], false, "the copy is a starter for nothing");
        assert.notEqual(mine[0].questions[0].id, QUESTION.id);

        // A reload cuts a request still in flight, which the watch would count as a failure.
        await page.waitForLoadState("networkidle");
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await listText(page)).includes(NAME));
        // The try page keeps the list folded under the box until it is shown.
        await page.locator("evaluator-list button.fold").click();
        await until(async () => (await page.locator("evaluator-list .row", { hasText: NAME }).count()) > 0);
        assert.equal(await page.locator("evaluator-list .row", { hasText: NAME }).count(), 1, "one copy, not a second one");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
