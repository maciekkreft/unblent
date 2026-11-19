import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, STARTERS } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for (prompt-sets/machine.js).
const SYNC_IDLE_MS = 2000;

const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const FIRST = STARTERS[0].id;

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/prompt-set.changed.json"), "2020-12");
const deletedSchema = new Validator(schema("../events/prompt-set.deleted.json"), "2020-12");
const savedSchema = new Validator(schema("../../prompt-settings/events/prompt-set.saved.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");

const saved = (over = {}) => {
  const event = { id: ID, name: "Mine", occasion: "Evening", basedOn: "", prompts: ["How was today?"], position: "1", ...over };
  assert.ok(savedSchema.validate(event).valid, JSON.stringify(event));
  return { type: "prompt-set.saved", ...event };
};

const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore(initial = [], outboxRows = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const outbox = new Map(outboxRows.map((r) => [r.id, r]));
  const meta = new Map();
  return {
    rows,
    outbox,
    meta,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
    empty: () => (rows.clear(), outbox.clear(), meta.clear(), Promise.resolve()),
  };
}

const askUser = (userId) => () => Promise.resolve({ userId, registrationOpen: false });

// The server as a fake of prompt-sets/server: last write wins, a delete always wins, a
// restore names the tombstone's version, a starter is added only when nothing is held.
function fakeApi() {
  const server = new Map();
  const puts = [];
  const pulls = [];
  let seq = 0;
  let offline = false;
  return {
    server,
    puts,
    pulls,
    set offline(v) {
      offline = v;
    },
    hold: (r) => server.set(r.id, { deleted: false, ...r, seq: ++seq }),
    put: async (row) => {
      if (offline) throw new Error("offline");
      puts.push(structuredClone(row));
      const held = server.get(row.id);
      const { baseVersion, starter, ...rest } = row;
      if (held && starter) return held;
      if (held?.deleted && (row.deleted || baseVersion !== held.version)) return held;
      const r = { ...rest, deleted: Boolean(row.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1, seq: ++seq };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => {
      if (offline) throw new Error("offline");
      pulls.push(since);
      return { sets: [...server.values()].filter((r) => r.seq > since), cursor: seq };
    },
  };
}

function start(store, { api, ask } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask }, clock });
  const changed = [];
  const deleted = [];
  const steps = [];
  actor.on("prompt-set.changed", (e) => {
    assert.ok(changedSchema.validate({ set: e.set }).valid, JSON.stringify(e));
    changed.push(e.set);
  });
  actor.on("prompt-set.deleted", ({ type, ...e }) => {
    assert.ok(deletedSchema.validate(e).valid);
    deleted.push(e.id);
  });
  actor.on("step.recorded", (e) => steps.push(e));
  actor.start();
  return { actor, changed, deleted, steps, clock };
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

const list = (actor) =>
  new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply })).then((r) => {
    assert.ok(listReply.validate(r).valid, JSON.stringify(r));
    return r.sets;
  });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Starter sets ------------------------------------------------------------------------

test("the ten starter sets have fixed ids, credit their books and sort in their order", () => {
  assert.equal(STARTERS.length, 10);
  assert.ok(STARTERS.every((s) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s.id)));
  assert.equal(new Set(STARTERS.map((s) => s.id)).size, 10);
  assert.deepEqual(STARTERS.map((s) => s.position), [...STARTERS.map((s) => s.position)].sort());
  assert.equal(STARTERS[4].basedOn, "The Happiness Trap, Russ Harris");
  assert.ok(STARTERS.every((s) => s.name && s.occasion && s.basedOn && s.prompts.length >= 2));
});

test("signed out: an empty copy is given the starter sets at once, as no step", async () => {
  const store = fakeStore();
  const { actor, changed, steps } = start(store);
  await ready(actor);
  const sets = await list(actor);
  assert.deepEqual(sets.map((s) => s.name), STARTERS.map((s) => s.name));
  assert.deepEqual([sets[0].version, sets[0].pending], [1, false]);
  assert.equal(changed.length, 10);
  assert.equal(steps.length, 0, "writing the starters is not a step");
  assert.equal(store.rows.size, 10, "cached");
});

test("a copy holding any set, even only a deleted one, is never given the starters again", async () => {
  const gone = { ...STARTERS[0], version: 2, deleted: true };
  const { actor, changed } = start(fakeStore([gone]));
  await ready(actor);
  assert.deepEqual(await list(actor), []);
  assert.equal(changed.length, 0);
});

test("signed in: the starters wait for the first pull and go to the server as starters", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.equal((await list(actor)).length, 10);
  assert.ok([...store.outbox.values()].every((row) => row.starter === true && row.baseVersion === null));
  await drain(clock);
  assert.equal(api.puts.length, 10);
  assert.equal(store.outbox.size, 0);
  assert.equal(api.server.get(FIRST).version, 1);
});

test("signed in and offline at the first load: no starters until the account has answered", async () => {
  const api = fakeApi();
  api.offline = true;
  const { actor } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(await list(actor), []);
  api.offline = false;
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await list(actor)).length, 10);
});

test("an account that deleted a starter elsewhere is not given the starters on a new device", async () => {
  const api = fakeApi();
  for (const s of STARTERS.slice(1)) api.hold({ ...s, version: 1 });
  api.hold({ ...STARTERS[0], version: 2, deleted: true });
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  await drain(clock);
  assert.deepEqual((await list(actor)).map((s) => s.id), STARTERS.slice(1).map((s) => s.id));
  assert.equal(api.puts.length, 0);
});

test("two devices writing the starters keep one of each, and the account's edit of one stays", async () => {
  const api = fakeApi();
  api.hold({ ...STARTERS[0], name: "Our truths", version: 3 });
  api.hold({ ...STARTERS[1], version: 2, deleted: true });
  // This device seeded before the pull could reach the account's copies.
  const rows = STARTERS.map((s) => ({ ...s, version: 1 }));
  const outbox = STARTERS.map((s) => ({ ...s, baseVersion: null, starter: true }));
  const store = fakeStore(rows, outbox);
  store.meta.set("userId", "u1");
  const { actor, clock, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  await drain(clock);
  const sets = await list(actor);
  assert.equal(sets.length, 9);
  assert.equal(sets[0].name, "Our truths");
  assert.deepEqual(deleted, [STARTERS[1].id]);
  assert.equal(api.server.size, 10);
  assert.equal(api.server.get(FIRST).name, "Our truths");
  assert.equal(store.outbox.size, 0);
});

test("sign-in sends an untouched starter as a starter and a changed one as a write", async () => {
  const store = fakeStore();
  const api = fakeApi();
  api.hold({ ...STARTERS[2], name: "Edited on the phone", version: 4 });
  const { actor } = start(store, { api });
  await ready(actor);
  actor.send(saved({ id: FIRST, ...STARTERS[0], name: "My truths" }));
  actor.send({ type: "session.changed", userId: "u1" });
  await flush(20);
  const rows = new Map(api.puts.map((p) => [p.id, p]));
  assert.equal(rows.get(FIRST).starter, undefined);
  assert.equal(rows.get(STARTERS[2].id).starter, true);
  const sets = await list(actor);
  assert.equal(sets[0].name, "My truths");
  assert.equal(sets[2].name, "Edited on the phone", "the account's edit is not undone by this browser's starter");
});

// --- Saves -----------------------------------------------------------------------------

test("a save adds, edits and deletes a set, and a deleted id stays deleted", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved());
  assert.deepEqual(changed.at(-1), { id: ID, name: "Mine", occasion: "Evening", basedOn: "", prompts: ["How was today?"], position: "1", version: 1, pending: false });
  assert.equal((await list(actor))[0].id, ID, "listed by its position");
  actor.send(saved({ prompts: ["How was today?", "What next?"] }));
  assert.deepEqual([changed.at(-1).prompts.length, changed.at(-1).version], [2, 2]);
  const count = changed.length;
  actor.send(saved({ prompts: ["How was today?", "What next?"] }));
  assert.equal(changed.length, count, "the same set is no change");
  actor.send(saved({ deleted: true }));
  assert.deepEqual(deleted, [ID]);
  assert.equal(store.rows.get(ID).deleted, true);
  assert.equal(store.rows.get(ID).prompts.length, 2, "the tombstone keeps what it had");
  actor.send(saved({ name: "Again" }));
  assert.equal((await list(actor)).some((s) => s.id === ID), false);
});

test("a gesture or query that lands while the store loads waits for it", async () => {
  let release;
  const store = fakeStore();
  const all = store.all;
  const gate = new Promise((r) => (release = r));
  store.all = () => gate.then(() => all());
  const { actor } = start(store);
  actor.send(saved());
  const answer = list(actor);
  release();
  await ready(actor);
  assert.equal((await answer).length, 11);
});

test("a store that rejects fails the fact, and the list is answered empty", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no idb"));
  const { actor } = start(store);
  const answer = list(actor);
  await flush();
  assert.deepEqual(await answer, []);
});

// --- Sync ------------------------------------------------------------------------------

test("signed in: a save is pending, waits out the idle window, then is acknowledged", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  await drain(clock);
  actor.send(saved());
  assert.equal(changed.at(-1).pending, true);
  const before = api.puts.length;
  await drain(clock);
  assert.equal(api.puts.length, before + 1);
  assert.deepEqual(Object.keys(api.puts.at(-1)).sort(), ["baseVersion", "basedOn", "id", "name", "occasion", "position", "prompts"]);
  assert.equal(changed.at(-1).pending, false);
  assert.equal(store.outbox.size, 0);
});

test("the last write wins: a pulled edit is adopted, and a local unsent one wins over it", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  await drain(clock);
  api.hold({ ...STARTERS[3], name: "From the phone", version: 5 });
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await list(actor))[3].name, "From the phone");
  actor.send(saved({ ...STARTERS[3], name: "Here" }));
  api.hold({ ...STARTERS[3], name: "Phone again", version: 6 });
  actor.send({ type: "_sync", pull: true });
  await flush(20);
  assert.equal((await list(actor))[3].name, "Here");
  assert.equal(api.server.get(STARTERS[3].id).name, "Here");
});

test("a pulled tombstone takes away a set this tab was showing", async () => {
  const api = fakeApi();
  const { actor, clock, deleted } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  await drain(clock);
  api.hold({ ...STARTERS[5], version: 2, deleted: true });
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.deepEqual(deleted, [STARTERS[5].id]);
  assert.equal((await list(actor)).length, 9);
});

test("leaving uploads what is left and then empties the copy", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  await drain(clock);
  actor.send(saved());
  actor.send({ type: "session.changed", userId: "u1", leaving: true });
  await flush(20);
  assert.equal(api.server.get(ID).name, "Mine");
  assert.equal(store.rows.size, 0);
});

test("keep: a copy joins an empty account, untouched starters as starters", async () => {
  const store = fakeStore(STARTERS.map((s) => ({ ...s, version: 1 })));
  store.meta.set("userId", "mac");
  store.meta.set("adopt", "mac");
  const api = fakeApi();
  api.hold({ ...STARTERS[0], version: 2, deleted: true });
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  await drain(clock);
  assert.equal(store.meta.get("adopt"), null);
  assert.equal((await list(actor)).length, 9, "the account's delete wins");
  assert.equal(api.server.size, 10);
});
