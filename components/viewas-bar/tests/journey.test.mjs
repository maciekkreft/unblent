import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// View as and Back to you, the whole way (12): the admin on the product page opens
// Administration, presses View as on a guest, and the browser becomes the guest on the
// guest's try page under the bar, with the admin's own notes gone from this browser;
// Back to you returns it to the admin, whose notes come back from the server. The
// guest is a real one on the throwaway server and the admin's cookie is forged as
// session's server module sets it; only who is the admin (the registry has no passkey
// account here) and the People list are answered by request routing.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forge, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const NOTE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const shadowText = (page, tag) =>
  page.evaluate((tag) => document.querySelector(tag)?.shadowRoot?.textContent.replace(/\s+/g, " ").trim() ?? "", tag);
// What this browser keeps of the notes, read straight from IndexedDB.
const cachedNotes = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("notes");
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("notes")) return resolve((db.close(), 0));
          const count = db.transaction("notes").objectStore("notes").count();
          count.onsuccess = () => resolve((db.close(), count.result));
        };
        open.onerror = () => resolve(-1);
      }),
  );

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`View as in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test(`the admin views as a guest under the bar and comes back to their own notes in ${engine.name}`, async () => {
      const adminId = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const admin = forge(`${adminId}|admin`);
      const guestRes = await fetch(`${BASE_URL}/api/session/guest`, { method: "POST" });
      const guest = await guestRes.json();
      const saved = await fetch(`${BASE_URL}/api/notes/${NOTE}`, {
        method: "PUT",
        headers: { "content-type": "application/json", Cookie: `unblent_session=${admin}` },
        body: JSON.stringify({ title: "Admin's own note", body: "Admin's own note", baseVersion: null, deleted: false }),
      });
      assert.equal(saved.status, 200);

      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, admin);
        // The registry has no passkey account here, so /me is answered while the browser
        // holds the admin (the server would set the cookie again without the admin's
        // flag); while viewing as the guest it reaches the server.
        let viewing = false;
        await context.route(/\/api\/session\/me$/, (route) =>
          viewing ? route.continue() : route.fulfill({ json: { userId: adminId, registrationOpen: false, admin: true, name: "Admin" } }),
        );
        await context.route(/\/api\/session\/(viewas|back)$/, (route) => {
          viewing = route.request().url().endsWith("/viewas");
          return route.continue();
        });
        const now = Date.now();
        await context.route(/\/api\/session\/people$/, (route) =>
          route.fulfill({
            json: {
              people: [
                { userId: adminId, name: "Admin", guest: false, admin: true, firstSeen: now, lastSeen: now, space: 0 },
                { userId: guest.userId, name: guest.name, guest: true, admin: false, firstSeen: now, lastSeen: now, space: 0 },
              ],
            },
          }),
        );
        const page = await context.newPage();
        const problems = watch(page);

        // The admin's own page, with their note.
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await until(async () => (await shadowText(page, "note-list")).includes("Admin's own note"));
        assert.equal(await shadowText(page, "viewas-bar"), "", "no bar on the admin's own page");

        // Administration › People › View as.
        await page.locator("dock-desk .controls button.pill").click();
        await page.locator('settings-tabs [role="tab"]', { hasText: "Administration" }).click();
        await page.locator(`people-list button[aria-label="View as ${guest.name}"]`).click();

        // The guest's try page, under the bar, with the admin's notes gone from this browser.
        await page.waitForURL(/\/try\/evaluators$/);
        const bar = page.locator("viewas-bar .bar");
        await bar.waitFor();
        assert.equal((await bar.innerText()).replace(/\s+/g, " ").trim(), `Viewing as ${guest.name} · what you change is changed for them Back to you`);
        assert.equal(await cachedNotes(page), 0, "the admin's local copy was emptied");
        const top = await bar.boundingBox();
        assert.equal(top.y, 0, "the bar is above everything");

        // Back to you: the admin's own page again, their note back from the server.
        await page.locator("viewas-bar button", { hasText: "Back to you" }).click();
        await page.waitForURL((url) => url.pathname === "/");
        await until(async () => (await shadowText(page, "note-list")).includes("Admin's own note"));
        assert.equal(await shadowText(page, "viewas-bar"), "", "the bar is gone");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });
  });
}
