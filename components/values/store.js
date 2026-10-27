import { openStore } from "store";

// values' private persistence (3.2), replicated (5): the IndexedDB cache of the versions,
// one per day and keyed by it, the days' placements of Your values, also keyed by day, an
// outbox of local changes not yet acknowledged by the
// server (the one thing that must not be lost), and a meta table for the pull cursor and
// the last-synced user. One database, its own name (11.2).
export function openValues() {
  // Version 2 is the schema with `days`. The outbox holds placements too, under their own
  // keys, because `session` waits on the table named outbox alone (12).
  const db = openStore("values", { versions: "day", days: "day", outbox: "day", meta: "key" }, 2);
  return {
    all: () => db.all("versions"),
    put: (version) => db.put("versions", version),
    placesAll: () => db.all("days"),
    placePut: (placement) => db.put("days", placement),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (day) => db.delete("outbox", day),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
    // The browser is changing account (12): everything goes, outbox and cache together.
    empty: () => db.empty(),
  };
}
