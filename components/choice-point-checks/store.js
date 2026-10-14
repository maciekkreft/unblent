import { openStore } from "store";

// choice-point-checks' private persistence (3.2), replicated (5): the IndexedDB cache of
// the four boxes' settings and of Jev's answers, an outbox of local changes not yet
// acknowledged by the server (the one thing that must not be lost), and a meta table for
// the pull cursor and the last-synced user. One database, its own name (11.2).
export function openChoicePointChecks() {
  const db = openStore("choice-point-checks", { boxes: "field", answers: "key", outbox: "id", meta: "key" });
  return {
    boxAll: () => db.all("boxes"),
    boxPut: (box) => db.put("boxes", box),
    answerAll: () => db.all("answers"),
    answerPut: (answer) => db.put("answers", answer),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
  };
}
