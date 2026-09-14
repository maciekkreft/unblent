import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake store and a
// fake clock, the shapes fact.js builds for real.
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function clock(start = 100) {
  let n = start;
  return () => ++n;
}

function start(store, now = clock()) {
  const actor = createActor(machine, { input: { store, now } });
  const changed = [];
  const conflicted = [];
  actor.on("note.changed", (e) => changed.push(e));
  actor.on("note.conflicted", (e) => conflicted.push(e));
  actor.start();
  return { actor, changed, conflicted };
}

function settled(actor) {
  return new Promise((resolve) => {
    if (actor.getSnapshot().value !== "loading") return resolve(actor.getSnapshot());
    const sub = actor.subscribe((snap) => {
      if (snap.value !== "loading") {
        sub.unsubscribe();
        resolve(snap);
      }
    });
  });
}

// A query as the bus delivers it (4.2): a reply function the answerer calls once.
function ask(actor, name, payload = {}) {
  return new Promise((reply) => actor.send({ type: `${name}?`, cid: "c", payload, reply }));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("queued queries are answered in order after the store loads", async () => {
  const d = deferred();
  const { actor } = start({ all: () => d.promise, put: () => Promise.resolve() });
  assert.equal(actor.getSnapshot().value, "loading");
  const order = [];
  const list = ask(actor, "list").then((r) => (order.push("list"), r));
  const read = ask(actor, "read", { id: ID }).then((r) => (order.push("read"), r));
  d.resolve([{ id: ID, title: "T", body: "B", version: 3, updatedAt: 5 }]);
  await settled(actor);
  const [listReply, readReply] = await Promise.all([list, read]);
  assert.deepEqual(order, ["list", "read"], "answered in the order they arrived");
  assert.deepEqual(listReply, { notes: [{ id: ID, title: "T", updatedAt: 5 }] });
  assert.equal(readReply.note.version, 3);
});

test("a store that rejects fails the fact, and queries still get honest replies", async () => {
  const d = deferred();
  const { actor } = start({ all: () => d.promise, put: () => Promise.resolve() });
  d.reject(new Error("no indexeddb"));
  const s = await settled(actor);
  assert.equal(s.value, "failed");
  assert.deepEqual(await ask(actor, "list"), { notes: [] });
  assert.deepEqual(await ask(actor, "read", { id: ID }), { error: "not-found" });
});

test("a new note (baseVersion null) is announced at version 1 and stored without pending", async () => {
  const puts = [];
  const { actor, changed } = start({
    all: () => Promise.resolve([]),
    put: (r) => (puts.push(r), Promise.resolve()),
  });
  await settled(actor);
  actor.send({ type: "note.saved", id: ID, title: "Hi", body: "there", baseVersion: null });
  await tick();
  assert.deepEqual(changed, [
    { type: "note.changed", id: ID, title: "Hi", body: "there", version: 1, updatedAt: 101, pending: false },
  ]);
  assert.deepEqual(puts, [{ id: ID, title: "Hi", body: "there", version: 1, updatedAt: 101 }]);
});

test("a save based on the held version bumps it; a stale base conflicts", async () => {
  const puts = [];
  const { actor, changed, conflicted } = start({
    all: () => Promise.resolve([{ id: ID, title: "A", body: "a", version: 1, updatedAt: 5 }]),
    put: (r) => (puts.push(r), Promise.resolve()),
  });
  await settled(actor);
  actor.send({ type: "note.saved", id: ID, title: "B", body: "b", baseVersion: 1 });
  await tick();
  assert.equal(changed.at(-1).version, 2);
  assert.equal(puts.length, 1);

  // Another save still based on version 1 is stale now the note is at 2.
  actor.send({ type: "note.saved", id: ID, title: "C", body: "c", baseVersion: 1 });
  await tick();
  assert.equal(changed.length, 1, "no further note.changed");
  assert.equal(puts.length, 1, "no further write");
  assert.deepEqual(conflicted, [
    {
      type: "note.conflicted",
      id: ID,
      mine: { title: "C", body: "c", baseVersion: 1 },
      theirs: { title: "B", body: "b", version: 2, updatedAt: 101 },
    },
  ]);
});

test("a null base for an id that already exists is a conflict", async () => {
  const puts = [];
  const { actor, changed, conflicted } = start({
    all: () => Promise.resolve([{ id: ID, title: "A", body: "a", version: 1, updatedAt: 5 }]),
    put: (r) => (puts.push(r), Promise.resolve()),
  });
  await settled(actor);
  actor.send({ type: "note.saved", id: ID, title: "B", body: "b", baseVersion: null });
  await tick();
  assert.equal(changed.length, 0);
  assert.equal(puts.length, 0);
  assert.equal(conflicted.length, 1);
  assert.deepEqual(conflicted[0].theirs, { title: "A", body: "a", version: 1, updatedAt: 5 });
});

test("a non-null base for an unknown id is an idempotent upsert at base + 1", async () => {
  const puts = [];
  const { actor, changed, conflicted } = start({
    all: () => Promise.resolve([]),
    put: (r) => (puts.push(r), Promise.resolve()),
  });
  await settled(actor);
  actor.send({ type: "note.saved", id: ID, title: "T", body: "B", baseVersion: 4 });
  await tick();
  assert.equal(conflicted.length, 0);
  assert.equal(changed.at(-1).version, 5);
  assert.equal(puts.at(-1).version, 5);
});

test("read of an unknown id is not-found; list returns id/title/updatedAt newest first", async () => {
  const { actor } = start({
    all: () =>
      Promise.resolve([
        { id: ID, title: "Old", body: "o", version: 1, updatedAt: 5 },
        { id: ID2, title: "New", body: "n", version: 1, updatedAt: 9 },
      ]),
    put: () => Promise.resolve(),
  });
  await settled(actor);
  assert.deepEqual(await ask(actor, "read", { id: "01ARZ3NDEKTSV4RRFFQ69G5ZZZ" }), { error: "not-found" });
  assert.deepEqual(await ask(actor, "list"), {
    notes: [
      { id: ID2, title: "New", updatedAt: 9 },
      { id: ID, title: "Old", updatedAt: 5 },
    ],
  });
});

test("a note.saved during loading is applied after the load", async () => {
  const d = deferred();
  const puts = [];
  const { actor, changed } = start({
    all: () => d.promise,
    put: (r) => (puts.push(r), Promise.resolve()),
  });
  assert.equal(actor.getSnapshot().value, "loading");
  actor.send({ type: "note.saved", id: ID, title: "Draft", body: "typed early", baseVersion: null });
  assert.equal(changed.length, 0, "nothing announced while loading");
  d.resolve([]);
  await settled(actor);
  await tick();
  assert.equal(changed.at(-1).title, "Draft");
  assert.equal(changed.at(-1).version, 1);
  assert.equal(puts.length, 1);
});

test("a save with the same text on the right base is not a change: no version, no note.changed", async () => {
  const puts = [];
  const { actor, changed, conflicted } = start({ all: () => Promise.resolve([]), put: (r) => (puts.push(r), Promise.resolve()) });
  await settled(actor);
  actor.send({ type: "note.saved", id: ID, title: "T", body: "B", baseVersion: null });
  assert.equal(changed.length, 1);
  actor.send({ type: "note.saved", id: ID, title: "T", body: "B", baseVersion: 1 });
  await tick();
  assert.equal(changed.length, 1, "nothing announced");
  assert.equal(puts.length, 1, "nothing written");
  assert.deepEqual(conflicted, []);
  const { note } = await ask(actor, "read", { id: ID });
  assert.equal(note.version, 1);
  // The same text on a stale base is still a conflict, not a silent pass.
  actor.send({ type: "note.saved", id: ID, title: "T", body: "B", baseVersion: 0 });
  assert.equal(conflicted.length, 1);
});
