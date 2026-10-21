import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Days list on the journal's stem page, signed out (14).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

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

    // Browser: focus and keys.
    test("with Vim keys on, j, k, G and gg move along the days as the arrows do", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("journal-days"));
        for (const n of ["1", "2", "3"]) {
          const record = { id: `01K7TEST00000000000000DA0${n}`, day: `2026-10-0${n}`, text: `Day ${n}`, editedAt: 1000 };
          const put = await context.request.put(`${BASE_URL}/api/journal/days`, { data: { record, baseVersion: null } });
          assert.ok(put.ok(), "a day is on the server");
        }
        // The "Vim keys" preference (12), seeded the way settings stores it (workshop profile).
        await context.addInitScript(() =>
          localStorage.setItem("settings", JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true })),
        );
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/journal`, { waitUntil: "domcontentloaded" });
        const days = page.locator("journal-days");
        await until(async () => (await days.locator(".row").count()) === 4);
        const focused = () => days.evaluate((el) => [...el.shadowRoot.querySelectorAll(".row")].indexOf(el.shadowRoot.activeElement));
        await days.evaluate((el) => el.shadowRoot.querySelector(".row").focus());
        for (const [key, at] of [["j", 1], ["G", 3], ["k", 2], ["ArrowUp", 1]]) {
          await page.keyboard.press(key);
          await until(async () => (await focused()) === at);
        }
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        await until(async () => (await focused()) === 0);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
