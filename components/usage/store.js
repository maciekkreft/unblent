import { openStore } from "store";

// usage's private persistence (3.2), replicated (5): this device's running totals per
// day and feature, an outbox of the totals not yet acknowledged by the server, and a
// meta table for the device id and the account the totals were counted for. One
// database, its own name (11.2).
export function openUsage() {
  const db = openStore("usage", { totals: "id", outbox: "id", meta: "key" });
  return {
    all: () => db.all("totals"),
    // Adds `ms` to the stored total in one transaction, so two tabs of this browser
    // counting at once both land; `queue` also puts the new total in the outbox.
    add: (total, ms, queue) =>
      db.transaction(["totals", "outbox"], async () => {
        const held = await db.get("totals", total.id);
        const row = { ...total, ms: (held?.ms ?? 0) + ms };
        await db.put("totals", row);
        if (queue) await db.put("outbox", row);
        return row;
      }),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
    // The browser is changing account (12): everything goes, outbox and totals together.
    empty: () => db.empty(),
  };
}
