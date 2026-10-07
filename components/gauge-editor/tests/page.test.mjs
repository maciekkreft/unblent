import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The gauge stem page (8): the list and the editor in their list-then-item pair. A pick
// opens the editor under the Back bar, an edit there reaches the list through gauge.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const names = (page) =>
  page.evaluate(() =>
    [...document.querySelector("gauge-list").shadowRoot.querySelectorAll(".row .name")].map((n) => n.textContent.trim()),
  );

for (const engine of ENGINES) {
  describe(`the gauge list and editor in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("pick a tool, rename it, go back, and the list shows the new name", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/gauge`, { waitUntil: "domcontentloaded" });
        await until(async () => (await names(page)).length === 6);
        assert.deepEqual(await names(page), ["New tool", "Viewability", "Followability", "Shareability", "Likeability", "Saveability"]);

        await page.locator("gauge-list .row", { hasText: "Shareability" }).click();
        const title = page.locator("gauge-editor input.title");
        await title.waitFor();
        assert.equal(await title.inputValue(), "Shareability");
        await title.fill("Sendability");
        await title.blur();
        await page.locator("list-then-item .bar button").click();
        await until(async () => (await names(page)).includes("Sendability"));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
