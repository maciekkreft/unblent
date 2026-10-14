import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The browser store (3.2) against real IndexedDB: a browser that kept the journal's
// detectors still holds their tables and perhaps an outbox row for one. Opening the
// journal deletes the tables, drops the row, and keeps the days.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const DAY = "01K7TEST00000000000000DA01";
const OLD = "01K7TEST00000000000000PR01";

// The journal database as the first version of its store left it (Dexie numbers
// version 1 as 10), with one day, one project and an outbox row for the project.
const seedOld = ([day, old]) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open("journal", 10);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, keyPath] of [["days", "id"], ["projects", "id"], ["detectors", "id"], ["answers", "key"], ["outbox", "key"], ["meta", "key"]])
        db.createObjectStore(name, { keyPath });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(["days", "projects", "outbox"], "readwrite");
      tx.objectStore("days").put({ id: day, day: new Date().toISOString().slice(0, 10), text: "kept", editedAt: Date.now(), version: 1 });
      tx.objectStore("projects").put({ id: old, name: "Goals and values", on: true, version: 1 });
      tx.objectStore("outbox").put({ key: `projects:${old}`, table: "projects", id: old, record: { id: old }, baseVersion: null });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });

// What the database holds now: its tables and its outbox keys, read without upgrading it.
const look = () =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open("journal");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tables = [...db.objectStoreNames].sort();
      const tx = db.transaction(["outbox", "days"], "readonly");
      const keys = tx.objectStore("outbox").getAllKeys();
      const days = tx.objectStore("days").getAll();
      tx.oncomplete = () => {
        db.close();
        resolve({ version: db.version, tables, outbox: keys.result, days: days.result.map((d) => d.text) });
      };
    };
  });

for (const engine of ENGINES) {
  describe(`journal store in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("an older journal database loses the detectors' tables and their outbox row, and keeps its days", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const problems = watch(page);
        // A page of the origin that does not open the journal, to seed the old database.
        await page.goto(`${BASE_URL}/static/tokens/tokens.css`);
        await page.evaluate(seedOld, [DAY, OLD]);
        await page.goto(`${BASE_URL}/workshop/design/journal`, { waitUntil: "domcontentloaded" });
        let now;
        await until(async () => {
          now = await page.evaluate(look);
          return now.version === 20 && now.outbox.length === 0;
        });
        assert.deepEqual(now.tables, ["days", "meta", "outbox"]);
        assert.deepEqual(now.days, ["kept"]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
