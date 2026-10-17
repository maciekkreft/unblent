// The store interface (architecture.md 3.2, 10): the one wrapper around Dexie, so
// a fact component's store.js names tables and records but never Dexie, and the
// store could later be swapped (SQLite in the browser) without touching a fact.
// One database per fact, its own name (11.2). Needs IndexedDB, so its Node tests
// cover only the surface; the real path is exercised by a stem's page test.
import Dexie from "dexie";

// `version` goes up when a fact drops a table: the table is then named with null, and
// opening the database at the higher version deletes it.
export function openStore(name, tables, version = 1) {
  // 11.2, one owner per fact: the name is the component's own, so it is a string
  // the caller states, never computed.
  if (typeof name !== "string") throw new TypeError("openStore(name, tables): name must be a string");
  const db = new Dexie(name);
  db.version(version).stores(tables);
  return {
    get: (table, id) => db.table(table).get(id),
    put: (table, record) => db.table(table).put(record),
    delete: (table, id) => db.table(table).delete(id),
    all: (table) => db.table(table).toArray(), // primary-key order (3.2)
    transaction: (tables, work) => db.transaction("rw", tables, work),
    // Empties every table in one transaction, so a fact's outbox and its cache go
    // together: nothing can see the outbox empty while the copy is still there (12).
    empty: () => db.transaction("rw", db.tables, () => Promise.all(db.tables.map((t) => t.clear()))),
    close: () => db.close(),
  };
}

// Whether any outbox in this browser still holds a row: the one look `session` may
// take across facts while the browser changes account (11.2, 12). It reads, never
// writes, and finds the outboxes by their table name, so it knows no fact. A database
// that cannot be read counts as holding a row, so nothing is assumed uploaded.
export async function outboxesHoldRows() {
  for (const name of await Dexie.getDatabaseNames()) {
    const db = new Dexie(name);
    try {
      await db.open();
      if (db.tables.some((t) => t.name === "outbox") && (await db.table("outbox").count()) > 0) return true;
    } catch (error) {
      if (error?.name !== "NoSuchDatabaseError") return true;
    } finally {
      db.close();
    }
  }
  return false;
}
