import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine } from "../machine.js";

// The idle window the network waits for (books/machine.js); a SimulatedClock drives it
// without waiting real time. The actor is where decisions live (3.2): it is driven with
// a fake store, clock, session ask, api and revoke — the shapes fact.js builds for real.
const SYNC_IDLE_MS = 2000;
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

// The book row shape, used both as a cached record and as a server reply.
const book = (id, over = {}) => ({
  id,
  title: "T",
  author: "A",
  cover: null,
  chapters: [{ title: "One" }, { title: "Two" }],
  toc: [],
  position: { chapter: 0, block: 0 },
  version: 1,
  contentVersion: 1,
  addedAt: 10,
  updatedAt: 10,
  deleted: false,
  ...over,
});

function fakeStore(initial = []) {
  const books = new Map(initial.map((b) => [b.id, b]));
  const outbox = new Map();
  const meta = new Map();
  return {
    books,
    outbox,
    meta,
    all: () => Promise.resolve([...books.values()]),
    put: (r) => (books.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
    clear: () => (books.clear(), outbox.clear(), Promise.resolve()),
  };
}

function clock(start = 100) {
  let n = start;
  return () => ++n;
}

const askUser = (userId) => () => Promise.resolve({ userId, registrationOpen: false });

function fakeApi(impl = {}) {
  const uploads = [];
  const positions = [];
  const removes = [];
  const pulls = [];
  const chapters = [];
  return {
    uploads,
    positions,
    removes,
    pulls,
    chapters,
    upload: async (id, url) => {
      uploads.push([id, url]);
      if (impl.upload) {
        const r = impl.upload(id, url);
        if (r && r.throw) throw new Error("offline");
        return r;
      }
      return { row: book(id) };
    },
    position: async (id, ch, bl) => {
      positions.push([id, ch, bl]);
      return impl.position ? impl.position(id, ch, bl) : book(id, { version: 2, position: { chapter: ch, block: bl } });
    },
    remove: async (id) => {
      removes.push(id);
      return impl.remove ? impl.remove(id) : book(id, { version: 2, deleted: true });
    },
    pull: async (since) => {
      pulls.push(since);
      return impl.pull ? impl.pull(since) : { books: [], cursor: since };
    },
    chapter: async (id, cv, ix) => {
      chapters.push([id, cv, ix]);
      return impl.chapter ? impl.chapter(id, cv, ix) : { html: "<p>x</p>" };
    },
  };
}

function start(store, { now = clock(), api, ask, revoke } = {}) {
  const simClock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, now, api, ask, revoke }, clock: simClock });
  const changed = [];
  const refused = [];
  const deleted = [];
  actor.on("book.changed", (e) => changed.push(e));
  actor.on("book.refused", (e) => refused.push(e));
  actor.on("book.deleted", (e) => deleted.push(e));
  actor.start();
  return { actor, changed, refused, deleted, clock: simClock };
}

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

async function ready(actor) {
  await new Promise((resolve) => {
    if (actor.getSnapshot().matches("ready")) return resolve();
    const sub = actor.subscribe((snap) => {
      if (snap.matches("ready")) {
        sub.unsubscribe();
        resolve();
      }
    });
  });
  await flush();
}

function askQuery(actor, name, payload = {}) {
  return new Promise((reply) => actor.send({ type: `${name}?`, cid: "c", payload, reply }));
}

// --- Import: an upload, not a local mint -----------------------------------------

test("signed out: a pick is refused and its object URL revoked", async () => {
  const revoked = [];
  const api = fakeApi();
  const { actor, refused } = start(fakeStore(), { api, ask: askUser(null), revoke: (u) => revoked.push(u) });
  await ready(actor);
  actor.send({ type: "book.picked", id: ID, name: "b.epub", size: 9, url: "blob:x" });
  await flush();
  assert.deepEqual(refused, [{ type: "book.refused", id: ID, reason: "signed-out" }]);
  assert.deepEqual(revoked, ["blob:x"], "the tab-local URL is revoked");
  assert.equal(api.uploads.length, 0, "nothing is uploaded while signed out");
});

test("signed in: a pick uploads and is announced pending false", async () => {
  const api = fakeApi();
  const { actor, changed } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  changed.length = 0;
  actor.send({ type: "book.picked", id: ID, name: "b.epub", size: 9, url: "blob:x" });
  await flush();
  assert.deepEqual(api.uploads, [[ID, "blob:x"]]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, ID);
  assert.equal(changed[0].pending, false);
  assert.equal(changed[0].version, 1);
});

test("signed in: an unreadable file is refused, and an unavailable server too", async () => {
  const api = fakeApi({ upload: () => ({ error: "unreadable" }) });
  const { actor, refused } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send({ type: "book.picked", id: ID, name: "b.epub", size: 9, url: "blob:x" });
  await flush();
  assert.deepEqual(refused, [{ type: "book.refused", id: ID, reason: "unreadable" }]);

  const api2 = fakeApi({ upload: () => ({ throw: true }) });
  const { actor: a2, refused: r2 } = start(fakeStore(), { api: api2, ask: askUser("u1") });
  await ready(a2);
  a2.send({ type: "book.picked", id: ID2, name: "b.epub", size: 9, url: "blob:y" });
  await flush();
  assert.deepEqual(r2, [{ type: "book.refused", id: ID2, reason: "unavailable" }]);
});

// --- Position: last write wins, coalesced, debounced -----------------------------

test("signed in: a progress is pending, drains after the window, then acknowledged", async () => {
  const store = fakeStore([book(ID)]);
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  changed.length = 0;

  actor.send({ type: "book.progressed", id: ID, chapter: 1, block: 5 });
  await flush();
  assert.equal(changed[0].pending, true);
  assert.deepEqual(changed[0].position, { chapter: 1, block: 5 });
  assert.equal(store.outbox.get(ID).kind, "position");

  await drain(clock);
  assert.deepEqual(api.positions, [[ID, 1, 5]]);
  assert.equal(changed.at(-1).pending, false);
  assert.equal(store.outbox.size, 0, "the row is gone once acknowledged");
});

test("signed in: two progressions within the window coalesce to one write", async () => {
  const store = fakeStore([book(ID)]);
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);

  actor.send({ type: "book.progressed", id: ID, chapter: 1, block: 2 });
  await flush();
  actor.send({ type: "book.progressed", id: ID, chapter: 1, block: 7 });
  await flush();
  assert.equal(store.outbox.size, 1);
  await drain(clock);
  assert.deepEqual(api.positions, [[ID, 1, 7]], "one write, the latest place");
});

test("a progress for a missing or unchanged place is ignored", async () => {
  const store = fakeStore([book(ID)]);
  const api = fakeApi();
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  changed.length = 0;
  actor.send({ type: "book.progressed", id: ID2, chapter: 1, block: 1 }); // unknown
  actor.send({ type: "book.progressed", id: ID, chapter: 0, block: 0 }); // unchanged
  await flush();
  assert.equal(changed.length, 0);
  assert.equal(store.outbox.size, 0);
});

// --- Delete with undo ------------------------------------------------------------

test("signed in: a discard announces the book gone and sends a delete", async () => {
  const store = fakeStore([book(ID)]);
  const api = fakeApi();
  const { actor, changed, deleted, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  changed.length = 0;

  actor.send({ type: "book.discarded", id: ID });
  await flush();
  assert.deepEqual(deleted, [{ type: "book.deleted", id: ID }]);
  assert.equal(changed.length, 0, "a tombstone never rides book.changed");
  assert.equal(store.outbox.get(ID).kind, "delete");

  await drain(clock);
  assert.deepEqual(api.removes, [ID]);
  assert.equal(store.outbox.size, 0);
  assert.equal(store.books.get(ID).deleted, true);
});

// --- Sync: pull, and sign-out ----------------------------------------------------

test("signed in: a pull adopts a newer row and ignores an older one", async () => {
  const store = fakeStore([book(ID, { version: 3 })]);
  const api = fakeApi({
    pull: () => ({ books: [book(ID, { version: 5, title: "Newer" }), book(ID2, { version: 1, title: "Old?" })], cursor: 9 }),
  });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  const forId = changed.filter((c) => c.id === ID);
  assert.equal(forId.at(-1).title, "Newer", "the newer version wins");
  assert.equal(store.books.get(ID).version, 5);
  assert.equal(actor.getSnapshot().context.cursor, 9);
});

test("signing out empties the library and announces every book gone", async () => {
  const store = fakeStore([book(ID), book(ID2)]);
  const api = fakeApi();
  const { actor, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);

  actor.send({ type: "session.changed", userId: null });
  await flush();
  assert.deepEqual(deleted.map((d) => d.id).sort(), [ID, ID2].sort());
  assert.deepEqual(await askQuery(actor, "list"), { books: [] }, "the cache is cleared");
  assert.equal(store.books.size, 0);
});

// --- Queries ---------------------------------------------------------------------

test("list, read and chapter reply from the cache and honestly on a miss", async () => {
  const store = fakeStore([book(ID, { title: "Kept" })]);
  const api = fakeApi();
  const { actor } = start(store, { api, ask: askUser("u1") });
  await ready(actor);

  const listed = await askQuery(actor, "list");
  assert.equal(listed.books.length, 1);
  assert.equal(listed.books[0].chapterCount, 2);

  assert.equal((await askQuery(actor, "read", { id: ID })).book.title, "Kept");
  assert.deepEqual(await askQuery(actor, "read", { id: ID2 }), { error: "not-found" });

  const chapter = await askQuery(actor, "chapter", { id: ID, chapter: 1 });
  assert.deepEqual(chapter, { title: "Two", html: "<p>x</p>" });
  assert.deepEqual(await askQuery(actor, "chapter", { id: ID2, chapter: 0 }), { error: "not-found" });
  assert.deepEqual(await askQuery(actor, "chapter", { id: ID, chapter: 9 }), { error: "not-found" });
});

test("chapter replies unavailable when the fetch fails", async () => {
  const store = fakeStore([book(ID)]);
  const api = fakeApi({ chapter: () => ({ error: "unavailable" }) });
  const { actor } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(await askQuery(actor, "chapter", { id: ID, chapter: 0 }), { error: "unavailable" });
});

test("a store that rejects fails the fact, and queries still get honest replies", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no indexeddb"));
  const { actor } = start(store, { api: fakeApi() });
  await new Promise((resolve) => {
    const sub = actor.subscribe((s) => s.matches("failed") && (sub.unsubscribe(), resolve()));
  });
  assert.deepEqual(await askQuery(actor, "list"), { books: [] });
  assert.deepEqual(await askQuery(actor, "read", { id: ID }), { error: "not-found" });
  assert.deepEqual(await askQuery(actor, "chapter", { id: ID, chapter: 0 }), { error: "unavailable" });
});
