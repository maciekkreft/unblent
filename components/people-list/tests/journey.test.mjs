import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Delete on a guest (12), the whole way: the admin presses Delete in the People tab, the
// row goes at once, the guest is signed out and the short notice offers Undo; Undo
// brings the guest back with its work. Its files go only when the step leaves the undo
// list, which session's Node and server tests cover. The guest is
// a real registry row with a saved evaluator; the admin's cookie is forged as session's
// server module sets it, and who is the admin and the people list, which need a passkey
// account in the registry, are answered by request routing.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, watch, forge, signedIn } = await import(process.env.UNBLENT_KIT);

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
    test("Delete hides and signs out the guest at once, and Undo brings it back with its work", async () => {
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
        await page.locator('settings-tabs [role="tab"]', { hasText: "People" }).click();

        const row = page.locator(`people-list tr[data-user="${guest.userId}"]`);
        await row.waitFor();
        await row.getByRole("button", { name: `Delete ${guest.name}` }).click();
        await row.waitFor({ state: "detached" });
        const me = async () => (await (await fetch(`${BASE_URL}/api/session/me`, { headers: { Cookie: guestCookie } })).json()).userId;
        const notice = page.locator("notice-stack .removal");
        await notice.waitFor();
        assert.match(await notice.innerText(), new RegExp(`Delete account ${guest.name}`));
        assert.equal(await me(), null, "the guest's browser is signed out at once");
        assert.ok(existsSync(dir), "its work stays while the delete can be undone");
        await notice.getByRole("button", { name: "Undo" }).click();
        await row.waitFor();
        assert.equal(await me(), guest.userId, "Undo brings the guest back");
        assert.ok(existsSync(dir));
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
