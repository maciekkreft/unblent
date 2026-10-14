import { openStore } from "store";

// journal's private persistence (3.2), replicated (5): its days, each carrying its
// version and, once deleted, a tombstone flag. The outbox holds local changes the server
// has not acknowledged, one row per day, and the meta table, when syncing, the pull
// cursor and the last-synced user. The store has one schema version, so every table a
// browser may already hold stays declared; nothing reads or writes projects, detectors
// or answers. One database, its own name (11.2). The machine receives only these
// operations through input, so machine.js stays importable in Node.
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
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (key) => db.delete("outbox", key),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
  };
}
