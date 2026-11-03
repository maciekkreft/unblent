import { openStore } from "store";

// usage's private persistence (3.2), replicated (5): this device's running totals per
// day and feature, an outbox of the totals not yet acknowledged by the server, and a
// meta table for the device id and the account the totals were counted for. One
// database, its own name (11.2).
export function openUsage() {
  const db = openStore("usage", { totals: "id", outbox: "id", meta: "key" });
  return {
    all: () => db.all("totals"),
    put: (total) => db.put("totals", total),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
    // The browser is changing account (12): everything goes, outbox and totals together.
    empty: () => db.empty(),
  };
}
