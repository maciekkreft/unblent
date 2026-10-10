import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Journal tab on the Judge app page, walked as a user would. Signed out, nothing is
// judged, so Jev is never called; the rows and the switch are what is checked.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const PAGE = `${BASE_URL}/workshop/apps/judge`;

for (const engine of ENGINES) {
  describe(`the Journal tab in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("two sentences show two rows, and Paragraphs shows them as one", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await page.locator('dock-desk [role="tab"]', { hasText: "Journal" }).click();
        const journal = page.locator("case-journal");
        const text = journal.locator("textarea.text");
        await text.waitFor();
        await text.fill("I always fail. Nobody likes me.");
        await text.blur();
        const pieces = journal.locator(".piece .text");
        await until(async () => (await pieces.count()) === 2);
        assert.deepEqual(await pieces.allTextContents(), ["I always fail.", "Nobody likes me."]);
        assert.equal(await journal.locator(".reason").textContent(), "Sign in to judge.");
        await journal.getByRole("button", { name: "Paragraphs" }).click();
        await until(async () => (await pieces.count()) === 1);
        assert.equal(await pieces.textContent(), "I always fail. Nobody likes me.");
        assert.equal(await journal.getByRole("button", { name: "Paragraphs" }).getAttribute("aria-pressed"), "true");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
