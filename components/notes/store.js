import { openStore } from "store";

// notes' private persistence (3.2), replicated (5): the IndexedDB cache of the
// notes, an outbox of local changes not yet acknowledged by the server (the one
// thing that must not be lost), and a meta table for the pull cursor and the
// last-synced user. One database, its own name (11.2). The machine receives only
// the operations it needs through input, so machine.js stays importable in Node.
export function openNotes() {
  const db = openStore("notes", { notes: "id, updatedAt", outbox: "id", meta: "key" });
  return {
    all: () => db.all("notes"),
    put: (note) => db.put("notes", note),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
  };
}
