// The store interface (architecture.md 3.2, 10): the one wrapper around Dexie, so
// a fact component's store.js names tables and records but never Dexie, and the
// store could later be swapped (SQLite in the browser) without touching a fact.
// One database per fact, its own name (11.2). Needs IndexedDB, so its Node tests
// cover only the surface; the real path is exercised by a stem's page test.
import Dexie from "dexie";

export function openStore(name, tables) {
  // 11.2, one owner per fact: the name is the component's own, so it is a string
  // the caller states, never computed.
  if (typeof name !== "string") throw new TypeError("openStore(name, tables): name must be a string");
  const db = new Dexie(name);
  db.version(1).stores(tables);
  return {
    get: (table, id) => db.table(table).get(id),
    put: (table, record) => db.table(table).put(record),
    delete: (table, id) => db.table(table).delete(id),
    all: (table) => db.table(table).toArray(), // primary-key order (3.2)
    transaction: (tables, work) => db.transaction("rw", tables, work),
    close: () => db.close(),
  };
}
