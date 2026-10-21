import { openStore } from "store";

// books' private persistence (3.2), replicated (5): the IndexedDB cache of the book
// rows (metadata and position only; chapters and images are files the reader fetches
// by URL, Decision 2), an outbox of positions and deletes not yet acknowledged, and
// a meta table for the pull cursor and the last-synced user. One database, its own
// name (11.2). The machine receives only the operations it needs through input, so
// machine.js stays importable in Node.
export function openBooks() {
  const db = openStore("books", { books: "id, addedAt", outbox: "id", meta: "key" });
  return {
    all: () => db.all("books"),
    put: (book) => db.put("books", book),
    outboxAll: () => db.all("outbox"),
    outboxPut: (row) => db.put("outbox", row),
    outboxDelete: (id) => db.delete("outbox", id),
    metaGet: async (key) => (await db.get("meta", key))?.value,
    metaPut: (key, value) => db.put("meta", { key, value }),
    // The browser is changing account (12): everything goes, outbox and cache together.
    empty: () => db.empty(),
    // Another account signed in without a reload: the cache and the outbox go, and the
    // meta is rewritten for the new account.
    clear: async () => {
      const [books, outbox] = await Promise.all([db.all("books"), db.all("outbox")]);
      await Promise.all([...books.map((b) => db.delete("books", b.id)), ...outbox.map((r) => db.delete("outbox", r.id))]);
    },
  };
}
