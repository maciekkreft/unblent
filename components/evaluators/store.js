import { openStore } from "store";

// evaluators' private persistence (3.2), replicated (5): the IndexedDB cache of the
// evaluators, an outbox of local changes not yet acknowledged by the server (the one
// thing that must not be lost), and a meta table for the pull cursor and the
// last-synced user. One database, its own name (11.2).
export function openEvaluators() {
  const db = openStore("evaluators", { evaluators: "id, book", outbox: "id", meta: "key" });
  return {
    all: () => db.all("evaluators"),
    put: (evaluator) => db.put("evaluators", evaluator),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
  };
}
