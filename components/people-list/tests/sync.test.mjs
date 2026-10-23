import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// Can sync in Administration › People (3.4): the admin's own row has the switch, a
// guest's has none, and pressing it moves it at once and reaches the server; pressing
// it again undoes it. Who is the admin and the people list are answered by request
// routing, since a passkey account needs a ceremony.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forge, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory");

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`Can sync in ${engine.name}`, { timeout: 15000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 15000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 10000 });

    // Browser: a gesture.
    test("the admin turns Can sync on for their own account and off again", async () => {
      const adminId = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const people = (sync) => [
        { userId: adminId, name: "Admin", guest: false, admin: true, firstSeen: now, lastSeen: now, space: 0, sync },
        { userId: "g1", name: "Guest 1", guest: true, admin: false, firstSeen: now, lastSeen: now, space: 0 },
      ];
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forge(`${adminId}|admin`));
        await context.route(/\/api\/session\/me$/, (route) =>
          route.fulfill({ json: { userId: adminId, registrationOpen: false, admin: true, name: "Admin" } }),
        );
        await context.route(/\/api\/session\/people$/, (route) => route.fulfill({ json: { people: people(false) } }));
        const sent = [];
        await context.route(/\/api\/session\/people\/[^/]+\/sync$/, (route) => {
          const { allowed } = route.request().postDataJSON();
          sent.push([route.request().method(), decodeURIComponent(route.request().url().split("/").at(-2)), allowed]);
          route.fulfill({ json: { people: people(allowed) } });
        });
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.locator("dock-desk .controls button.pill").click();
        await page.locator('settings-tabs [role="tab"]', { hasText: "Administration" }).click();

        const own = page.locator(`people-list tr[data-user="${adminId}"]`).getByRole("switch", { name: "Can sync, you" });
        await own.waitFor();
        assert.equal(await own.isChecked(), false, "off at first");
        assert.equal(await page.locator('people-list tr[data-user="g1"] [role="switch"]').count(), 0, "a guest has none");
        await own.click();
        assert.equal(await own.isChecked(), true);
        await until(() => sent.length === 1);
        await own.click();
        assert.equal(await own.isChecked(), false, "pressing it again undoes it");
        await until(() => sent.length === 2);
        assert.deepEqual(sent, [["PUT", adminId, true], ["PUT", adminId, false]]);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
