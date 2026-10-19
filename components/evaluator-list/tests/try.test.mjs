import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Evaluators try page (8): a visitor sees the Journal's evaluators with nothing made
// on the server, and the first Evaluate makes the guest (3.4), who is told that free
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

    // Browser: a page's composition.
    test("a visitor writes an evaluator for the Journal, and the first Evaluate makes the guest", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        const writes = [];
        page.on("request", (r) => r.method() !== "GET" && r.url().includes("/api/") && writes.push(new URL(r.url()).pathname));
        await page.goto(`${BASE_URL}/try/evaluators`, { waitUntil: "domcontentloaded" });
        await until(async () => (await listText(page)).includes("About: Journal"));

        // The try page starts with the list of evaluators folded under the box.
        assert.equal(await page.locator("evaluator-list button.fold").getAttribute("aria-expanded"), "false");
        await page.locator("evaluator-list button.fold").click();
        await page.getByText("New evaluator", { exact: true }).click();
        await page.getByPlaceholder("Name the evaluator").fill("Clear goal");
        await page.click('evaluator-editor .question [data-field="text"] .cm-content');
        await page.keyboard.type("Is this a goal the writer can act on today?");
        await page.getByRole("button", { name: "Evaluators" }).first().click();
        await until(async () => (await listText(page)).includes("Clear goal"));
        assert.deepEqual(writes, [], "opening the page and writing makes nothing on the server");
        assert.equal((await context.cookies()).length, 0, "no account before the first Evaluate");

        await page.getByRole("textbox", { name: "Write one sentence per line" }).click();

        await page.keyboard.insertText("Walk for ten minutes after lunch.");
        await page.getByRole("button", { name: "Evaluate 1 line" }).click();
        await until(async () => (await listText(page)).includes("Free trials are paused for now."));
        assert.equal(writes[0], "/api/session/guest", "the first Evaluate makes the guest");
        const me = await (await context.request.get(`${BASE_URL}/api/session/me`)).json();
        assert.equal(me.guest, true);
        assert.match(me.name, /^Guest \d+$/);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a reload against real storage.
    test("the list starts folded here, and the visitor's own fold is kept across a reload", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(BASE_URL + "/try/evaluators", { waitUntil: "domcontentloaded" });
        const fold = page.locator("evaluator-list button.fold");
        const rowsShown = () => page.evaluate(() => document.querySelector("evaluator-list").shadowRoot.querySelectorAll(".list .row").length);
        await until(async () => (await fold.getAttribute("aria-expanded")) === "false");
        assert.equal(await rowsShown(), 0, "folded at the start");
        await fold.click();
        await until(async () => (await rowsShown()) > 0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await fold.getAttribute("aria-expanded")) === "true");
        assert.ok((await rowsShown()) > 0, "still shown after a reload");
        await fold.click();
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await fold.getAttribute("aria-expanded")) === "false");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
