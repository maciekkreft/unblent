import { openStore } from "store";

// wheels' private persistence (3.2), replicated (5): the IndexedDB cache of the wheels, an
// outbox of local changes not yet acknowledged by the server (the one thing that must not
// be lost), and a meta table for the pull cursor and the last-synced user. One database,
// its own name (11.2).
export function openWheels() {
  const db = openStore("wheels", { wheels: "id, day", outbox: "id", meta: "key" });
  return {
    all: () => db.all("wheels"),
    put: (wheel) => db.put("wheels", wheel),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
    // The browser is changing account (12): everything goes, outbox and cache together.
    empty: () => db.empty(),
  };
}
