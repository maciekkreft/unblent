import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// usage on the product page, signed in with Share usage statistics on: what the person
// does, as the views announce it (here the actions that follow opening the journal), is counted into this browser's IndexedDB, and a reload sends it to the account.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// This browser's totals, read straight from usage's own database.
const totals = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((ok, no) => {
      const r = indexedDB.open("usage");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    if (!db.objectStoreNames.contains("totals")) return [];
    const rows = await new Promise((ok) => {
      const r = db.transaction("totals").objectStore("totals").getAll();
      r.onsuccess = () => ok(r.result);
    });
    db.close();
    return rows;
  });

for (const engine of ENGINES) {
  describe(`usage in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    // Browser: a reload against real storage.
    test("opening the journal is counted in this browser, and the next load sends it to the account", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const cookie = forgeCookie("usage");
      await signedIn(context, cookie);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        // usage counts only once it has loaded its store and then confirmed who is signed
        // in, its second read of session; a click before that is not counted, which on a
        // busy host left nothing to count. The trace's console line says when it landed.
        let confirmed = 0;
        page.on("console", (m) => /reply read session → usage replied/.test(m.text()) && confirmed++);
        await page.addInitScript(() => localStorage.setItem("settings:product", JSON.stringify({ nav: [], usageCounting: true })));
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await until(async () => confirmed >= 2);
        await page.locator("book-shelf .tile:not(.adding)").filter({ hasText: "Journal" }).click();
        await until(async () => (await totals(page)).some((r) => r.ms > 0));
        await page.reload({ waitUntil: "domcontentloaded" });
        const summary = async () => {
          const res = await fetch(`${BASE_URL}/api/usage/summary?who=you`, { headers: { Cookie: `unblent_session=${cookie}` } });
          return res.json();
        };
        await until(async () => (await summary()).days.some((d) => d.ms > 0));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
