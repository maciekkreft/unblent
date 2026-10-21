import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Days list on the journal's stem page, signed out (14).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`journal-days in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Browser: rendering and layout.
    test("signed out, the Days list shows only the line asking to sign in", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/journal`, { waitUntil: "domcontentloaded" });
        const days = page.locator("journal-days");
        await until(async () => (await days.evaluate((el) => el.shadowRoot.textContent.trim())) === "Sign in to write in your journal.");
        assert.equal(await days.locator(".row, .kept").count(), 0, "no rows, no line about where it is kept");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
