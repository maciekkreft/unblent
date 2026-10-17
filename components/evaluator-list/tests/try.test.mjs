import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Evaluators try page (8): a visitor sees the Journal's evaluators with nothing made
// on the server, and the first Run makes the guest (3.4), whose Run is told that free
// trials are paused (no guest key here), with nothing failing in the console.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const listText = (page) => page.evaluate(() => document.querySelector("evaluator-list").shadowRoot.textContent);

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`the Evaluators try page in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("a visitor writes an evaluator for the Journal, and the first Run makes the guest", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        const writes = [];
        page.on("request", (r) => r.method() !== "GET" && r.url().includes("/api/") && writes.push(new URL(r.url()).pathname));
        await page.goto(`${BASE_URL}/try/evaluators`, { waitUntil: "domcontentloaded" });
        await until(async () => (await listText(page)).includes("About: Journal"));

        await page.getByText("New evaluator", { exact: true }).click();
        await page.getByPlaceholder("Name the evaluator").fill("Clear goal");
        await page.click('evaluator-editor .question [data-field="text"] .cm-content');
        await page.keyboard.type("Is this a goal the writer can act on today?");
        await page.getByRole("button", { name: "Evaluators" }).first().click();
        await until(async () => (await listText(page)).includes("Clear goal"));
        assert.deepEqual(writes, [], "opening the page and writing makes nothing on the server");
        assert.equal((await context.cookies()).length, 0, "no account before the first Run");

        await page.getByPlaceholder("Type or paste a text to judge…").fill("Walk for ten minutes after lunch.");
        await page.getByRole("button", { name: "Run" }).click();
        await until(async () => (await listText(page)).includes("Free trials are paused for now."));
        assert.equal(writes[0], "/api/session/guest", "the first Run makes the guest");
        const me = await (await context.request.get(`${BASE_URL}/api/session/me`)).json();
        assert.equal(me.guest, true);
        assert.match(me.name, /^Guest \d+$/);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
