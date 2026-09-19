import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine } from "../machine.js";

// The idle window the network waits for (notes/machine.js); a SimulatedClock drives
// it without waiting real time, the way note-editor's throttle test does.
const SYNC_IDLE_MS = 2000;

// The actor is where decisions live (3.2): it is driven with a fake store, clock,
// session ask, and sync api — the shapes fact.js builds for real. Anonymous
// (no signed-in user) the fact mints locally, the anonymous behaviour; signed
// in it caches pending, queues the outbox, and syncs.
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore(initialNotes = []) {
  const notes = new Map(initialNotes.map((n) => [n.id, n]));
  const outbox = new Map();
  const meta = new Map();
  return {
    notes,
    outbox,
    meta,
    all: () => Promise.resolve([...notes.values()]),
    put: (r) => (notes.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

function clock(start = 100) {
  let n = start;
  return () => ++n;
}

const askUser = (userId) => () => Promise.resolve({ userId, registrationOpen: false });

function fakeApi(impl = {}) {
  const puts = [];
  const pulls = [];
  return {
    puts,
    pulls,
    put: async (row) => {
      const out = impl.put ? impl.put(row) : { id: row.id, title: row.title, body: row.body, version: (row.baseVersion || 0) + 1, updatedAt: 900, deleted: Boolean(row.deleted) };
      if (out && out.throw) throw new Error("offline");
      puts.push(row);
      return out;
    },
    pull: async (since) => {
      pulls.push(since);
      return impl.pull ? impl.pull(since) : { notes: [], cursor: since };
    },
  };
}

// A sync api whose put can be held in flight, to observe what a trigger arriving
// mid-sync does. hold() before a sync makes its put wait; release() lets it finish.
function gatedApi() {
  const puts = [];
  const pulls = [];
  let gate = null;
  return {
    puts,
    pulls,
    hold: () => {
      let resolve;
      gate = { promise: new Promise((r) => (resolve = r)), resolve };
    },
    release: () => {
      if (gate) (gate.resolve(), (gate = null));
    },
    put: async (row) => {
      puts.push(row);
      if (gate) await gate.promise;
      return { id: row.id, title: row.title, body: row.body, version: (row.baseVersion || 0) + 1, updatedAt: 900 };
    },
    pull: async (since) => {
      pulls.push(since);
      return { notes: [], cursor: since };
    },
  };
}

function start(store, { now = clock(), api, ask } = {}) {
  const simClock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, now, api, ask }, clock: simClock });
  const changed = [];
  const conflicted = [];
  const deleted = [];
  actor.on("note.changed", (e) => changed.push(e));
  actor.on("note.conflicted", (e) => conflicted.push(e));
  actor.on("note.deleted", (e) => deleted.push(e));
  actor.start();
  return { actor, changed, conflicted, deleted, clock: simClock };
}

// Let the idle window elapse so a save-triggered drain reaches the network.
async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// Wait until the machine reaches ready. A load or sign-in syncs at once (no idle
// wait), so a flush settles that initial sync without touching the clock.
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

// --- Anonymous: minting and announcing without a server --------------------------

test("queued queries are answered in order after the store loads (anonymous)", async () => {
  let resolveAll;
  const store = fakeStore();
  store.all = () => new Promise((r) => (resolveAll = () => r([{ id: ID, title: "T", body: "B", version: 3, updatedAt: 5 }])));
  const { actor } = start(store);
  assert.equal(actor.getSnapshot().value, "loading");
  const order = [];
  const list = askQuery(actor, "list").then((r) => (order.push("list"), r));
  const read = askQuery(actor, "read", { id: ID }).then((r) => (order.push("read"), r));
  resolveAll();
  await ready(actor);
  const [listReply, readReply] = await Promise.all([list, read]);
  assert.deepEqual(order, ["list", "read"]);
  assert.deepEqual(listReply, { notes: [{ id: ID, title: "T", subtitle: "", updatedAt: 5, about: [] }] });
  assert.equal(readReply.note.version, 3);
  assert.equal(readReply.note.pending, false);
});

test("a store that rejects fails the fact, and queries still get honest replies", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no indexeddb"));
  const { actor } = start(store);
  await new Promise((resolve) => {
    const sub = actor.subscribe((s) => s.matches("failed") && (sub.unsubscribe(), resolve()));
  });
  assert.deepEqual(await askQuery(actor, "list"), { notes: [] });
  assert.deepEqual(await askQuery(actor, "read", { id: ID }), { error: "not-found" });
});

test("anonymous: a new note is announced at version 1, pending false, and never calls the api", async () => {
  const api = fakeApi();
  const { actor, changed } = start(fakeStore(), { api });
  await ready(actor);
  actor.send({ type: "note.saved", id: ID, title: "Hi", body: "Hi\nthere", baseVersion: null });
  await flush();
  // subtitle is derived from the body's second non-empty line, on every note.changed.
  assert.deepEqual(changed, [
    { type: "note.changed", id: ID, title: "Hi", subtitle: "there", body: "Hi\nthere", version: 1, updatedAt: 101, about: [], pending: false },
  ]);
  assert.equal(api.puts.length, 0, "anonymous never writes to the server");
  assert.equal(api.pulls.length, 0, "anonymous never pulls");
});

test("anonymous: a save on a stale base is a conflict, not a silent loss", async () => {
  const { actor, changed, conflicted } = start(
    fakeStore([{ id: ID, title: "A", body: "a", version: 2, updatedAt: 5 }]),
  );
  await ready(actor);
  actor.send({ type: "note.saved", id: ID, title: "C", body: "c", baseVersion: 1 });
  await flush();
  assert.equal(changed.length, 0);
  assert.deepEqual(conflicted, [
    { type: "note.conflicted", id: ID, mine: { title: "C", body: "c", baseVersion: 1 }, theirs: { title: "A", body: "a", version: 2, updatedAt: 5 } },
  ]);
});

// --- Note links (about) ----------------------------------------------------------

test("a note's about rides note.changed and both replies; absent keeps it, present replaces it", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  // A new note created with one link to the subject.
  actor.send({ type: "note.saved", id: ID, title: "N", body: "N", baseVersion: null, about: [{ kind: "book", id: "b1" }] });
  await flush();
  assert.deepEqual(changed.at(-1).about, [{ kind: "book", id: "b1" }]);
  assert.deepEqual((await askQuery(actor, "read", { id: ID })).note.about, [{ kind: "book", id: "b1" }]);
  assert.deepEqual((await askQuery(actor, "list")).notes[0].about, [{ kind: "book", id: "b1" }]);

  // A later save without about keeps the stored links (D2).
  actor.send({ type: "note.saved", id: ID, title: "N2", body: "N2", baseVersion: 1 });
  await flush();
  assert.deepEqual(changed.at(-1).about, [{ kind: "book", id: "b1" }]);

  // A save carrying about replaces the links; unlinking is a shorter list.
  actor.send({ type: "note.saved", id: ID, title: "N3", body: "N3", baseVersion: 2, about: [] });
  await flush();
  assert.deepEqual(changed.at(-1).about, []);
});

test("a note cached before links existed reads as about: []", async () => {
  const { actor } = start(fakeStore([{ id: ID, title: "Old", body: "old", version: 1, updatedAt: 5 }]));
  await ready(actor);
  assert.deepEqual((await askQuery(actor, "read", { id: ID })).note.about, []);
  assert.deepEqual((await askQuery(actor, "list")).notes[0].about, []);
});

test("signed in: a new note's link is sent to the server in the outbox row", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send({ type: "note.saved", id: ID, title: "N", body: "N", baseVersion: null, about: [{ kind: "book", id: "b1" }] });
  await flush();
  await drain(clock);
  assert.deepEqual(api.puts[0].about, [{ kind: "book", id: "b1" }]);
});

test("a link's place and quote ride note.changed, both replies, and the api put", async () => {
  const api = fakeApi();
  const { actor, changed, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  // A highlight's link (12): the place (Path B, a book anchor) and the quote.
  const link = {
    kind: "book",
    id: "b1",
    place: { chapter: 3, contentVersion: 1, start: { block: 12, offset: 45 }, end: { block: 13, offset: 10 } },
    quote: { exact: "the quoted text", prefix: "before ", suffix: " after" },
  };
  actor.send({ type: "note.saved", id: ID, title: "", body: "", baseVersion: null, about: [link] });
  await flush();
  await drain(clock);

  assert.deepEqual(changed.at(-1).about, [link], "note.changed carries the place and quote");
  assert.deepEqual((await askQuery(actor, "read", { id: ID })).note.about, [link], "read replies them");
  assert.deepEqual((await askQuery(actor, "list")).notes[0].about, [link], "list replies them");
  assert.deepEqual(api.puts.at(-1).about, [link], "and they reach the api put");
});

// --- Signed in: pending, outbox, and sync ----------------------------------------

test("signed in: a save is pending, queued in the outbox, then acknowledged by the server", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor); // initial sync (pull since 0) settles
  assert.equal(api.pulls.length, 1, "signing in pulls at once");
  changed.length = 0;

  actor.send({ type: "note.saved", id: ID, title: "Hi", body: "there", baseVersion: null });
  await flush();
  await drain(clock);

  // pending, then acknowledged at the server's version.
  assert.equal(changed[0].pending, true);
  assert.equal(changed[0].version, 1);
  assert.equal(changed.at(-1).pending, false);
  assert.equal(changed.at(-1).version, 1);
  assert.equal(api.puts.length, 1);
  assert.equal(store.outbox.size, 0, "the row is gone once acknowledged");
  const { note } = await askQuery(actor, "read", { id: ID });
  assert.equal(note.pending, false);
});

test("signed in but offline: edits coalesce into one outbox row keeping the first base", async () => {
  const store = fakeStore([{ id: ID, title: "A", body: "a", version: 4, updatedAt: 5 }]);
  const api = fakeApi({ put: () => ({ throw: true }) }); // offline: every write fails
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);

  actor.send({ type: "note.saved", id: ID, title: "B", body: "b", baseVersion: 4 });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "C", body: "c", baseVersion: 4 });
  await flush();

  assert.equal(store.outbox.size, 1, "three edits, one write pending");
  const row = store.outbox.get(ID);
  assert.equal(row.title, "C", "the latest text");
  assert.equal(row.baseVersion, 4, "the base of the first unsynced edit");
});

test("signed in: saves within the idle window are one drain of one coalesced row", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor); // initial sync settles
  api.puts.length = 0;
  api.pulls.length = 0;

  // A throttled typing run: three saves to one note inside the window.
  actor.send({ type: "note.saved", id: ID, title: "v1", body: "1", baseVersion: null });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "v2", body: "2", baseVersion: null });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "v3", body: "3", baseVersion: null });
  await flush();
  assert.equal(api.puts.length, 0, "nothing hits the network before the window ends");

  await drain(clock);
  // One drain of one coalesced row (one put) after the pause; a save-triggered
  // drain does not pull: the fact debounced the network, not the news (4.3, 5).
  assert.equal(api.puts.length, 1, "one coalesced write");
  assert.equal(api.puts[0].body, "3", "carrying the latest text");
  assert.equal(api.pulls.length, 0, "a save-triggered drain does not pull");
});

test("signed in: the outbox drains in id order once online", async () => {
  const store = fakeStore();
  let offline = true;
  const api = fakeApi({ put: (row) => (offline ? { throw: true } : { id: row.id, title: row.title, body: row.body, version: 1, updatedAt: 900 }) });
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);

  actor.send({ type: "note.saved", id: ID2, title: "two", body: "2", baseVersion: null });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "one", body: "1", baseVersion: null });
  await flush();
  await drain(clock); // the window ends; the drain fails while offline
  assert.equal(store.outbox.size, 2);

  offline = false;
  actor.send({ type: "_sync", pull: true }); // a tab-focus, back online
  await flush();
  assert.deepEqual(api.puts.map((r) => r.id), [ID, ID2], "sorted by id");
  assert.equal(store.outbox.size, 0);
});

test("signed in: a 409 adopts the server's copy and surfaces the conflict", async () => {
  const store = fakeStore([{ id: ID, title: "mine", body: "m", version: 1, updatedAt: 5 }]);
  const api = fakeApi({ put: () => ({ conflict: true, note: { id: ID, title: "theirs", body: "t", version: 7, updatedAt: 800 } }) });
  const { actor, changed, conflicted, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  changed.length = 0;

  actor.send({ type: "note.saved", id: ID, title: "mine2", body: "m2", baseVersion: 1 });
  await flush();
  await drain(clock);

  assert.equal(conflicted.length, 1);
  assert.deepEqual(conflicted[0].theirs, { title: "theirs", body: "t", version: 7, updatedAt: 800 });
  assert.equal(changed.at(-1).title, "theirs");
  assert.equal(changed.at(-1).version, 7);
  assert.equal(store.outbox.size, 0, "the losing write is dropped");
});

test("signed in: a 401 drops the session and stops", async () => {
  const store = fakeStore();
  const api = fakeApi({ put: () => ({ error: "unauthorized" }) });
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);

  actor.send({ type: "note.saved", id: ID, title: "x", body: "y", baseVersion: null });
  await flush();
  await drain(clock);
  assert.equal(actor.getSnapshot().context.userId, null, "signed out on a 401");
});

test("signed in: a pull adopts newer records and advances the cursor", async () => {
  const store = fakeStore();
  const api = fakeApi({ pull: () => ({ notes: [{ id: ID, title: "server", body: "s", version: 4, updatedAt: 700 }], cursor: 9 }) });
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);

  assert.equal(changed.at(-1).title, "server");
  assert.equal(changed.at(-1).version, 4);
  assert.equal(actor.getSnapshot().context.cursor, 9);
  assert.equal(store.meta.get("cursor"), 9);
});

test("sign-in enqueues the anonymous cache and drains it to the account", async () => {
  const store = fakeStore([{ id: ID, title: "local", body: "l", version: 1, updatedAt: 5 }]);
  const api = fakeApi();
  // Start anonymous, then session.changed brings a user.
  const { actor, clock } = start(store, { api, ask: askUser(null) });
  await ready(actor);
  assert.equal(api.puts.length, 0, "nothing uploaded while anonymous");

  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.equal(api.puts.length, 1, "the anonymous note is pushed to the account on sign-in");
  assert.equal(api.puts[0].id, ID);
  assert.equal(api.pulls.length, 1, "sign-in pulls at once");
  assert.equal(actor.getSnapshot().context.userId, "u1");
});

test("sign-in carries the anonymous note's links into the account", async () => {
  const store = fakeStore([{ id: ID, title: "local", body: "l", version: 1, updatedAt: 5, about: [{ kind: "book", id: "b1" }] }]);
  const api = fakeApi();
  const { actor } = start(store, { api, ask: askUser(null) });
  await ready(actor);

  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(api.puts[0].about, [{ kind: "book", id: "b1" }], "the adopted row keeps its links");
});

// --- The idle window and the immediate triggers ----------------------------------

test("signed in: typing never drains; the outbox waits for a pause", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  api.puts.length = 0;
  api.pulls.length = 0;

  // A run of saves, each well inside the 2 s window: every save restarts it.
  actor.send({ type: "note.saved", id: ID, title: "v0", body: "0", baseVersion: null });
  await flush();
  for (let i = 1; i <= 4; i += 1) {
    clock.increment(1500);
    actor.send({ type: "note.saved", id: ID, title: `v${i}`, body: String(i), baseVersion: null });
    await flush();
  }
  assert.equal(api.puts.length, 0, "no drain while typing, 6 s of it");

  clock.increment(SYNC_IDLE_MS - 1);
  await flush();
  assert.equal(api.puts.length, 0, "still none a tick before the window ends");
  clock.increment(1);
  await flush();
  assert.equal(api.puts.length, 1, "one drain once typing paused for the window");
  assert.equal(api.puts[0].body, "4", "carrying the latest text");
  assert.equal(api.pulls.length, 0, "and it did not pull");
});

test("a bare _sync drains a queued row at once, without pulling (a hidden tab)", async () => {
  const store = fakeStore();
  let offline = true;
  const api = fakeApi({ put: (row) => (offline ? { throw: true } : { id: row.id, title: row.title, body: row.body, version: 1, updatedAt: 900 }) });
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  api.pulls.length = 0;

  actor.send({ type: "note.saved", id: ID, title: "x", body: "x", baseVersion: null });
  await flush();
  await drain(clock); // the window ends; the drain fails offline, the row stays
  assert.equal(store.outbox.size, 1);

  offline = false;
  api.puts.length = 0;
  actor.send({ type: "_sync", pull: false }); // the tab goes hidden
  await flush();
  assert.equal(api.puts.length, 1, "the queued row drains at once, no idle wait");
  assert.equal(api.pulls.length, 0, "a hidden-tab drain does not pull");
  assert.equal(store.outbox.size, 0);
});

test("a bare _sync with an empty outbox is a no-op", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  api.puts.length = 0;
  api.pulls.length = 0;

  actor.send({ type: "_sync", pull: false });
  assert.ok(actor.getSnapshot().matches({ ready: "idle" }), "stays idle, nothing to do");
  await flush();
  assert.equal(api.puts.length, 0);
  assert.equal(api.pulls.length, 0);
});

test("a focus syncs and pulls at once, even with an empty outbox", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  const before = api.pulls.length; // the sign-in pull

  actor.send({ type: "_sync", pull: true }); // the tab regains focus
  assert.ok(actor.getSnapshot().matches({ ready: "syncing" }), "syncs at once");
  await flush();
  assert.equal(api.pulls.length, before + 1, "a focus pulls");
});

test("a save arriving mid-sync waits out the idle window before draining", async () => {
  const store = fakeStore();
  const api = gatedApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  api.puts.length = 0;
  api.pulls.length = 0;

  api.hold();
  actor.send({ type: "note.saved", id: ID, title: "one", body: "1", baseVersion: null });
  await flush();
  await drain(clock); // the window ends; the drain starts and hangs on the held put
  assert.equal(api.puts.length, 1, "the drain is in flight");
  assert.ok(actor.getSnapshot().matches({ ready: "syncing" }));

  actor.send({ type: "note.saved", id: ID, title: "two", body: "2", baseVersion: null });
  await flush();
  api.release();
  await flush();
  assert.equal(api.puts.length, 1, "no second drain the instant the first finishes");
  assert.ok(actor.getSnapshot().matches({ ready: "debouncing" }), "the mid-sync edit waits out the window");

  await drain(clock);
  assert.equal(api.puts.length, 2, "it drains after the window");
  assert.equal(api.puts[1].body, "2", "the mid-sync text");
  assert.equal(api.pulls.length, 0, "no save-triggered drain pulled");
});

test("a focus arriving mid-sync resyncs at once, carrying the pull", async () => {
  const store = fakeStore();
  const api = gatedApi();
  const { actor } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  api.puts.length = 0;
  api.pulls.length = 0;

  api.hold();
  actor.send({ type: "note.saved", id: ID, title: "x", body: "x", baseVersion: null });
  await flush();
  actor.send({ type: "_sync", pull: true }); // a focus starts the sync, its put held
  await flush();
  assert.ok(actor.getSnapshot().matches({ ready: "syncing" }));
  assert.equal(api.pulls.length, 0, "the pull waits behind the held put");

  actor.send({ type: "_sync", pull: true }); // a second focus, mid-sync
  await flush();
  api.release();
  await flush();
  // The first sync pulled once; the mid-sync focus resynced at once (no idle wait)
  // and pulled again, its outbox already drained.
  assert.equal(api.pulls.length, 2, "the mid-sync focus synced again immediately");
});

// --- Deletion: tombstones (5) ----------------------------------------------------

test("anonymous: a discard tombstones the note, announces it gone, and hides it", async () => {
  const store = fakeStore([{ id: ID, title: "A", body: "a", version: 2, updatedAt: 5 }]);
  const api = fakeApi();
  const { actor, changed, deleted } = start(store, { api });
  await ready(actor);

  actor.send({ type: "note.discarded", id: ID });
  await flush();
  assert.equal(store.notes.get(ID).deleted, true, "the record stays as a tombstone");
  assert.equal(store.notes.get(ID).version, 3, "a delete mints the next version");
  assert.deepEqual(deleted, [{ type: "note.deleted", id: ID }]);
  assert.equal(changed.length, 0, "a tombstone never rides note.changed");
  assert.equal(api.puts.length, 0, "anonymous never writes to the server");
  assert.deepEqual(await askQuery(actor, "list"), { notes: [] }, "the list excludes it");
  assert.deepEqual(await askQuery(actor, "read", { id: ID }), { error: "not-found" });
});

test("a discard of an unknown or already-deleted note does nothing", async () => {
  const store = fakeStore([{ id: ID, title: "A", body: "a", version: 1, updatedAt: 5, deleted: true }]);
  const { actor, deleted } = start(store);
  await ready(actor);
  actor.send({ type: "note.discarded", id: ID2 }); // unknown
  actor.send({ type: "note.discarded", id: ID }); // already a tombstone
  await flush();
  assert.equal(deleted.length, 0);
});

test("signed in: a discard queues a delete, the api sends it, the ack clears it, no change", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, deleted, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  // A saved, acknowledged note to delete.
  actor.send({ type: "note.saved", id: ID, title: "A", body: "a", baseVersion: null });
  await flush();
  await drain(clock);
  changed.length = 0;
  api.puts.length = 0;

  actor.send({ type: "note.discarded", id: ID });
  await flush();
  assert.equal(store.outbox.get(ID).deleted, true, "the outbox row is a delete");
  assert.deepEqual(deleted, [{ type: "note.deleted", id: ID }]);
  assert.equal(changed.length, 0, "the tombstone does not ride note.changed");

  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.equal(api.puts[0].deleted, true, "the delete travels to the server");
  assert.equal(store.outbox.size, 0, "the ack clears the outbox row");
  assert.equal(store.notes.get(ID).deleted, true, "and the record is still a tombstone");
  assert.equal(changed.length, 0, "the ack of a delete emits no note.changed");
});

test("a save after a discard is dropped: a delete always wins", async () => {
  const store = fakeStore([{ id: ID, title: "A", body: "a", version: 2, updatedAt: 5, deleted: true }]);
  const api = fakeApi();
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  api.puts.length = 0;

  actor.send({ type: "note.saved", id: ID, title: "revive", body: "me", baseVersion: 2 });
  await flush();
  assert.equal(changed.length, 0, "nothing announced");
  assert.equal(store.outbox.size, 0, "nothing queued");
});

test("a pulled tombstone announces the deletion of a note this device was showing", async () => {
  const store = fakeStore([{ id: ID, title: "A", body: "a", version: 1, updatedAt: 5 }]);
  const api = fakeApi({ pull: () => ({ notes: [{ id: ID, title: "A", body: "a", version: 2, updatedAt: 700, deleted: true }], cursor: 9 }) });
  const { actor, changed, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(deleted, [{ type: "note.deleted", id: ID }]);
  assert.equal(changed.length, 0, "a pulled tombstone is not a change");
  assert.equal(store.notes.get(ID).deleted, true);
});

test("a pulled tombstone for an unknown note is stored silently", async () => {
  const store = fakeStore();
  const api = fakeApi({ pull: () => ({ notes: [{ id: ID, title: "A", body: "a", version: 2, updatedAt: 700, deleted: true }], cursor: 9 }) });
  const { actor, changed, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.equal(deleted.length, 0, "no note was on screen to announce gone");
  assert.equal(changed.length, 0);
  assert.equal(store.notes.get(ID).deleted, true);
});

test("a live pull never resurrects a local tombstone", async () => {
  const store = fakeStore([{ id: ID, title: "A", body: "a", version: 3, updatedAt: 5, deleted: true }]);
  const api = fakeApi({ pull: () => ({ notes: [{ id: ID, title: "A", body: "a", version: 2, updatedAt: 700, deleted: false }], cursor: 9 }) });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.equal(store.notes.get(ID).deleted, true, "the tombstone stands");
  assert.equal(changed.length, 0);
});

test("sign-in enqueues an anonymous tombstone so the deletion becomes the account's", async () => {
  const store = fakeStore([{ id: ID, title: "A", body: "a", version: 2, updatedAt: 5, deleted: true }]);
  const api = fakeApi();
  const { actor } = start(store, { api, ask: askUser(null) });
  await ready(actor);

  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.equal(api.puts.length, 1);
  assert.equal(api.puts[0].deleted, true, "the tombstone uploads as a delete");
});

test("a 409 whose server copy is a tombstone adopts the delete and surfaces the lost edit", async () => {
  const store = fakeStore();
  let deletedOnServer = false;
  const api = fakeApi({
    put: (row) => {
      if (!deletedOnServer) {
        deletedOnServer = true; // the first write wins the create; the note is then deleted elsewhere
        return { id: row.id, title: row.title, body: row.body, version: 1, updatedAt: 900, deleted: false };
      }
      return { conflict: true, note: { id: row.id, title: "A", body: "a", version: 5, updatedAt: 800, deleted: true } };
    },
  });
  const { actor, changed, conflicted, deleted, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  // First save creates it (acked live).
  actor.send({ type: "note.saved", id: ID, title: "A", body: "a", baseVersion: null });
  await flush();
  await drain(clock);
  changed.length = 0;
  deleted.length = 0;

  // A later edit collides with a delete made on another device. The edit shows
  // optimistically (one pending note.changed) before the sync reveals the conflict.
  actor.send({ type: "note.saved", id: ID, title: "mine", body: "edit", baseVersion: 1 });
  await flush();
  changed.length = 0; // from here, only what the conflict resolution emits
  await drain(clock);
  assert.equal(conflicted.length, 1, "the lost edit is surfaced");
  assert.equal(conflicted[0].theirs.deleted, undefined, "the deleted flag never rides note.conflicted");
  assert.deepEqual(deleted, [{ type: "note.deleted", id: ID }], "and the note is announced gone");
  assert.equal(changed.length, 0, "a won delete resolves as gone, not changed");
  assert.equal(store.notes.get(ID).deleted, true);
});

test("a discard queued while the store is loading is applied once ready", async () => {
  let resolveAll;
  const store = fakeStore();
  store.all = () => new Promise((r) => (resolveAll = () => r([{ id: ID, title: "A", body: "a", version: 1, updatedAt: 5 }])));
  const { actor, deleted } = start(store);
  actor.send({ type: "note.discarded", id: ID });
  resolveAll();
  await ready(actor);
  assert.deepEqual(deleted, [{ type: "note.deleted", id: ID }]);
  assert.equal(store.notes.get(ID).deleted, true);
});
