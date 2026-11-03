import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Test versions row of This device. Only a Mac's server answers /api/updates, so the
// test answers it here: as a Mac first, and then as the website, which answers 204.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const row = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("settings-sheet")?.shadowRoot;
    const label = [...(root?.querySelectorAll("label.field.check") ?? [])].find((l) => l.textContent.trim() === "Test versions");
    if (!label) return root?.querySelector(".switches") ? { shown: false } : null;
    return {
      shown: true,
      checked: label.querySelector("input").checked,
      line: label.nextElementSibling?.textContent.trim(),
    };
  });

for (const engine of ENGINES) {
  describe(`Test versions in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Browser: rendering and layout.
    test("the Mac app shows the switch with its line and saves a flip; the website shows none", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        let saved = { test: false };
        const puts = [];
        await context.route("**/api/updates", async (route) => {
          const request = route.request();
          assert.equal(request.headers()["x-unblent-local"], "1", "a connected Mac's relay keeps it on the Mac");
          if (request.method() === "PUT") {
            saved = request.postDataJSON();
            puts.push(saved);
          }
          return route.fulfill({ json: saved });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/settings`, { waitUntil: "domcontentloaded" });

        await until(async () => (await row(page))?.shown);
        assert.deepEqual(await row(page), {
          shown: true,
          checked: false,
          line: "Offer test builds of the next version as updates. Turn off to get only finished versions.",
        });
        await page.locator("settings-sheet label.field.check", { hasText: "Test versions" }).locator("input").click();
        await until(async () => (await row(page))?.checked === true);
        assert.deepEqual(puts, [{ test: true }]);

        await context.unroute("**/api/updates");
        await context.route("**/api/updates", (route) => route.fulfill({ status: 204, body: "" }));
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await row(page)) !== null);
        assert.deepEqual(await row(page), { shown: false });
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
