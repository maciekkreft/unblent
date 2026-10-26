import { openStore } from "store";

// value-checks' private persistence (3.2), replicated (5): the IndexedDB cache of the
// settings and of Jev's answers, an outbox of local changes not yet acknowledged by the
// server (the one thing that must not be lost), and a meta table for the pull cursor and
// the last-synced user. One database, its own name (11.2).
export function openValueChecks() {
  const db = openStore("value-checks", { settings: "key", answers: "key", outbox: "id", meta: "key" });
  return {
    settingsGet: async () => (await db.get("settings", "settings")) ?? null,
    settingsPut: (settings) => db.put("settings", { ...settings, key: "settings" }),
    answerAll: () => db.all("answers"),
    answerPut: (answer) => db.put("answers", answer),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
    // The browser is changing account (12): everything goes, outbox and cache together.
    empty: () => db.empty(),
  };
}
