import { openStore } from "store";

// journal's private persistence (3.2), replicated (5): its days, each carrying its
// version and, once deleted, a tombstone flag. The outbox holds local changes the server
// has not acknowledged, one row per day, and the meta table, when syncing, the pull
// cursor and the last-synced user. Version 2 deletes the tables the journal kept for its
// detectors, which nothing reads any more. One database, its own name (11.2). The
// machine receives only these operations through input, so machine.js stays importable
// in Node.
export function openJournal() {
  const db = openStore(
    "journal",
    {
      days: "id",
      outbox: "key",
      meta: "key",
      projects: null,
      detectors: null,
      answers: null,
    },
    2,
  );
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
