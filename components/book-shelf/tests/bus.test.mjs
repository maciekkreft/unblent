import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): book-shelf with `books`, real machines on the real bus. The store and the
// server are faked, and the account is signed in, so a delete is sent. The shelf's
// gestures are sent to its actor the way its view forwards them; a tile's bin itself is
// clicked in the browser test.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const ID = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const BOOK = {
  id: ID, title: "Sample Book", fileTitle: "Sample Book", author: "A", cover: null,
  chapters: [{ title: "One" }], toc: [], position: { chapter: 0, block: 0 },
  version: 1, contentVersion: 1, addedAt: 10, updatedAt: 10, deleted: false,
};

function booksStore(rows) {
  const books = new Map(rows.map((b) => [b.id, b]));
  const outbox = new Map();
  const meta = new Map([["userId", "u1"]]);
  return {
    books,
    outbox,
    all: () => Promise.resolve([...books.values()]),
    put: (r) => (books.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
    empty: () => (books.clear(), outbox.clear(), Promise.resolve()),
  };
}

function fakeApi() {
  const removes = [];
  return {
    removes,
    remove: async (id) => (removes.push(id), { ...BOOK, id, version: 2, deleted: true }),
    pull: async (since) => ({ books: [], cursor: since }),
    opened: async (id) => ({ id, at: 500 }),
    position: async () => BOOK,
    title: async () => BOOK,
  };
}

async function start(store, api, extra = [], extraInputs = {}) {
  const wired = await wire(["books", "book-shelf", ...extra], {
    books: {
      store,
      api,
      now: (() => { let n = 100; return () => ++n; })(),
      revoke: () => {},
      ask: async (target) => (target === "session" ? { userId: "u1", registrationOpen: false } : { error: "no-answerer" }),
    },
    "book-shelf": {},
    ...extraInputs,
  });
  const tiles = () => wired.actors["book-shelf"].getSnapshot().context.books.filter((b) => !b.written).map((b) => b.id);
  const emitted = (type) => wired.records.filter((r) => r.kind === "event" && r.name === type);
  return { ...wired, tiles, emitted };
}

// The trash deletes at once (12, Undo): book.discarded, which `books` turns into a
// tombstone, a step with the short notice, the delete sent, and book.deleted, so the tile
// goes, and a fresh start does not bring it back.
test("delete happens at once as one step and stays gone", async () => {
  const store = booksStore([BOOK]);
  const api = fakeApi();
  const h = await start(store, api);
  try {
    await until(() => h.tiles().includes(ID));
    h.actors["book-shelf"].send({ type: "_discard", id: ID });
    await until(() => h.emitted("book.discarded").length === 1 && h.emitted("book.deleted").length === 1);
    await until(() => !h.tiles().includes(ID));
    const [step] = h.emitted("step.recorded");
    assert.equal(step.payload.owner, "books");
    assert.equal(step.payload.notice, true);
    assert.equal(step.payload.label, "delete book Sample Book");
    assert.equal(store.books.get(ID).deleted, true, "the book is a tombstone");
    await until(() => api.removes.includes(ID));
  } finally {
    h.unwire();
  }
  const again = await start(store, fakeApi());
  try {
    await until(() => again.actors["book-shelf"].getSnapshot().matches("ready"));
    assert.ok(!again.tiles().includes(ID), "it stays gone after a restart");
  } finally {
    again.unwire();
  }
});

// Vim's dd deletes a tile at once, p brings the book back as one step `books` records,
// Undo deletes it again and a second Undo brings it back; Redo goes forward the same way
// (12, Vim keys; 12, Undo).
test("dd then p brings a book back through books, and Undo and Redo walk both steps", async () => {
  const store = booksStore([BOOK]);
  const rows = new Map();
  const undoStore = { read: async (account) => rows.get(account), write: async (account, lists) => void rows.set(account, structuredClone(lists)) };
  const h = await start(store, fakeApi(), ["undo"], { undo: { store: undoStore, tell: () => {} } });
  try {
    await until(() => h.tiles().includes(ID));
    const shelf = h.actors["book-shelf"];
    shelf.send({ type: "_dd", id: ID });
    await until(() => !h.tiles().includes(ID));
    assert.equal(store.books.get(ID).deleted, true);
    shelf.send({ type: "_paste" });
    await until(() => h.tiles().includes(ID));
    assert.equal(h.emitted("book.restored").length, 1);
    assert.equal(h.emitted("step.recorded").at(-1).payload.label, "restore book Sample Book");
    const undo = h.actors["undo"];
    const request = (direction) => undo.send({ type: "step.requested", direction });
    request("undo");
    await until(() => !h.tiles().includes(ID));
    request("undo");
    await until(() => h.tiles().includes(ID));
    request("redo");
    await until(() => !h.tiles().includes(ID));
    request("redo");
    await until(() => h.tiles().includes(ID));
    assert.equal(store.books.get(ID).deleted, false);
  } finally {
    h.unwire();
  }
});
