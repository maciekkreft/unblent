import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine } from "../machine.js";

// The network debounce window (notes/machine.js); a SimulatedClock drives it
// without waiting real time, the way note-editor's throttle test does.
const SYNC_DEBOUNCE_MS = 500;

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
      const out = impl.put ? impl.put(row) : { id: row.id, title: row.title, body: row.body, version: (row.baseVersion || 0) + 1, updatedAt: 900 };
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

function start(store, { now = clock(), api, ask } = {}) {
  const simClock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, now, api, ask }, clock: simClock });
  const changed = [];
  const conflicted = [];
  actor.on("note.changed", (e) => changed.push(e));
  actor.on("note.conflicted", (e) => conflicted.push(e));
  actor.start();
  return { actor, changed, conflicted, clock: simClock };
}

// Let the debounce window elapse so a raised _sync reaches the network.
async function drain(clock) {
  clock.increment(SYNC_DEBOUNCE_MS);
  await flush();
}

// Wait until the machine reaches ready, then let any sync raised on entry run
// through the debounce window (clock given for signed-in starts).
async function ready(actor, clock) {
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
  if (clock) await drain(clock);
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
  assert.deepEqual(listReply, { notes: [{ id: ID, title: "T", updatedAt: 5 }] });
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
  actor.send({ type: "note.saved", id: ID, title: "Hi", body: "there", baseVersion: null });
  await flush();
  assert.deepEqual(changed, [
    { type: "note.changed", id: ID, title: "Hi", body: "there", version: 1, updatedAt: 101, pending: false },
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

// --- Signed in: pending, outbox, and sync ----------------------------------------

test("signed in: a save is pending, queued in the outbox, then acknowledged by the server", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor, clock); // initial sync (pull since 0) settles
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
  await ready(actor, clock);

  actor.send({ type: "note.saved", id: ID, title: "B", body: "b", baseVersion: 4 });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "C", body: "c", baseVersion: 4 });
  await flush();

  assert.equal(store.outbox.size, 1, "three edits, one write pending");
  const row = store.outbox.get(ID);
  assert.equal(row.title, "C", "the latest text");
  assert.equal(row.baseVersion, 4, "the base of the first unsynced edit");
});

test("signed in: saves within the debounce window are one sync of one coalesced row", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor, clock); // initial sync settles
  api.puts.length = 0;
  api.pulls.length = 0;

  // A throttled typing run: three saves to one note inside the window.
  actor.send({ type: "note.saved", id: ID, title: "v1", body: "1", baseVersion: null });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "v2", body: "2", baseVersion: null });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "v3", body: "3", baseVersion: null });
  await flush();
  assert.equal(api.pulls.length, 0, "nothing hits the network before the window ends");

  await drain(clock);
  // One sync invocation (one pull) draining one coalesced row (one put): the
  // fact debounced the network, not the news (4.3).
  assert.equal(api.pulls.length, 1, "one sync for the whole run");
  assert.equal(api.puts.length, 1, "one coalesced write");
  assert.equal(api.puts[0].body, "3", "carrying the latest text");
});

test("signed in: the outbox drains in id order once online", async () => {
  const store = fakeStore();
  let offline = true;
  const api = fakeApi({ put: (row) => (offline ? { throw: true } : { id: row.id, title: row.title, body: row.body, version: 1, updatedAt: 900 }) });
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor, clock);

  actor.send({ type: "note.saved", id: ID2, title: "two", body: "2", baseVersion: null });
  await flush();
  actor.send({ type: "note.saved", id: ID, title: "one", body: "1", baseVersion: null });
  await flush();
  await drain(clock); // the window ends; the drain fails while offline
  assert.equal(store.outbox.size, 2);

  offline = false;
  actor.send({ type: "_sync" });
  await flush();
  await drain(clock);
  assert.deepEqual(api.puts.map((r) => r.id), [ID, ID2], "sorted by id");
  assert.equal(store.outbox.size, 0);
});

test("signed in: a 409 adopts the server's copy and surfaces the conflict", async () => {
  const store = fakeStore([{ id: ID, title: "mine", body: "m", version: 1, updatedAt: 5 }]);
  const api = fakeApi({ put: () => ({ conflict: true, note: { id: ID, title: "theirs", body: "t", version: 7, updatedAt: 800 } }) });
  const { actor, changed, conflicted, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor, clock);
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
  await ready(actor, clock);

  actor.send({ type: "note.saved", id: ID, title: "x", body: "y", baseVersion: null });
  await flush();
  await drain(clock);
  assert.equal(actor.getSnapshot().context.userId, null, "signed out on a 401");
});

test("signed in: a pull adopts newer records and advances the cursor", async () => {
  const store = fakeStore();
  const api = fakeApi({ pull: () => ({ notes: [{ id: ID, title: "server", body: "s", version: 4, updatedAt: 700 }], cursor: 9 }) });
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor, clock);

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
  await drain(clock);
  assert.equal(api.puts.length, 1, "the anonymous note is pushed to the account on sign-in");
  assert.equal(api.puts[0].id, ID);
  assert.equal(actor.getSnapshot().context.userId, "u1");
});
