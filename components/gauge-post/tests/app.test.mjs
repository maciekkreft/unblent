import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Gauge app (8) at its own address: an app page under /workshop/apps/ is in the
// product profile once the user switched there (§12), so the page list is gone.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const links = (page) => page.evaluate(() => document.querySelector("page-nav")?.shadowRoot?.querySelectorAll("a").length ?? -1);

for (const engine of ENGINES) {
  describe(`the Gauge app in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("in the product profile the app shows the post and the tools, at its own address", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await context.addInitScript(() => localStorage.setItem("settings:profile", "product"));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/apps/gauge`, { waitUntil: "domcontentloaded" });
        await until(() => page.evaluate(() => document.querySelector("profile-switch")?.dataset.profile === "product"));
        await until(() => page.evaluate(() => Boolean(document.querySelector("gauge-post")?.shadowRoot?.querySelector("textarea"))));
        await until(() => page.evaluate(() => document.querySelector("gauge-list")?.shadowRoot?.querySelectorAll(".row").length === 6));
        assert.equal(await links(page), 0, "no page links in the product");
        // Signed out, Score says why it cannot run.
        assert.equal(await page.locator("gauge-post .line").textContent(), "Sign in to score.");
        assert.equal(await page.locator("gauge-post button").isDisabled(), true);

        await page.locator("profile-switch button").click();
        await until(async () => (await links(page)) > 0);
        assert.equal(new URL(page.url()).pathname, "/workshop/apps/gauge");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
