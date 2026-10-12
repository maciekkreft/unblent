import { openStore } from "store";

// journal's private persistence (3.2), replicated (5): one table per record kind, each
// record carrying its version and, once deleted, a tombstone flag; an answer is kept by
// its question's id and its paragraph's text. The outbox holds local changes the server
// has not acknowledged, one row per record kind and id, and the meta table the seed
// version and, when syncing, the pull cursor and the last-synced user. Every table is
// declared now because the store has one schema version, so a table added later would
// not open in a browser that already holds the journal. One database, its own name
// (11.2). The machine receives only these operations through input, so machine.js stays
// importable in Node.
export function openJournal() {
  const db = openStore("journal", {
    days: "id",
    projects: "id",
    detectors: "id",
    answers: "key",
    outbox: "key",
    meta: "key",
  });
  return {
    all: (table) => db.all(table),
    put: (table, record) => db.put(table, record),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
  };
}
