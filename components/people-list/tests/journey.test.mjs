import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Delete on a guest (12), the whole way: the admin presses Delete in Administration ›
// People, the row goes at once and the notice offers Undo; Undo brings it back; a
// second Delete left to run out removes the guest's account and its files. The guest is
// a real registry row with a saved evaluator; the admin's cookie is forged as session's
// server module sets it, and who is the admin and the people list, which need a passkey
// account in the registry, are answered by request routing.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forge, signedIn, shortUndo } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory");

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`Delete a guest in ${engine.name}`, { timeout: 20000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 15000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 10000 });

    // Browser: a gesture.
    test("Delete hides the guest with an Undo, and once it runs out the guest and its work are gone", async () => {
      const made = await fetch(`${BASE_URL}/api/session/guest`, { method: "POST" });
      const guest = await made.json();
      const guestCookie = (made.headers.get("set-cookie") || "").split(";")[0];
      const saved = await fetch(`${BASE_URL}/api/evaluators/01K7TEST00000000000000DE01`, {
        method: "PUT",
        headers: { "content-type": "application/json", Cookie: guestCookie },
        body: JSON.stringify({ book: "00000000000000000000000JRN", name: "Mine", on: true, questions: [], baseVersion: null, deleted: false }),
      });
      assert.equal(saved.status, 200);
      const dir = join(process.env.UNBLENT_DATA, guest.userId);
      assert.ok(existsSync(dir));

      const adminId = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, forge(`${adminId}|admin`));
        // Long enough to press Undo, short enough to let run out.
        await shortUndo(context, 600);
        await context.route(/\/api\/session\/me$/, (route) =>
          route.fulfill({ json: { userId: adminId, registrationOpen: false, admin: true, name: "Admin" } }),
        );
        await context.route(/\/api\/session\/people$/, (route) =>
          route.fulfill({
            json: {
              people: [
                { userId: adminId, name: "Admin", guest: false, admin: true, firstSeen: Date.now(), lastSeen: Date.now(), space: 0 },
                { userId: guest.userId, name: guest.name, guest: true, admin: false, firstSeen: Date.now(), lastSeen: Date.now(), space: 1 },
              ],
            },
          }),
        );
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.locator("dock-desk .controls button.pill").click();
        await page.locator('settings-tabs [role="tab"]', { hasText: "Administration" }).click();

        const row = page.locator(`people-list tr[data-user="${guest.userId}"]`);
        await row.waitFor();
        await row.getByRole("button", { name: `Delete ${guest.name}` }).click();
        await row.waitFor({ state: "detached" });
        const notice = page.locator("notice-stack .removal");
        assert.match(await notice.innerText(), new RegExp(`Account “${guest.name}” deleted`));
        await notice.getByRole("button", { name: "Undo" }).click();
        await row.waitFor();
        assert.ok(existsSync(dir), "Undo deleted nothing");

        await row.getByRole("button", { name: `Delete ${guest.name}` }).click();
        await until(() => !existsSync(dir));
        assert.equal(await row.count(), 0, "the row stays gone");
        const me = await (await fetch(`${BASE_URL}/api/session/me`, { headers: { Cookie: guestCookie } })).json();
        assert.equal(me.userId, null, "the guest's browser is signed out");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
