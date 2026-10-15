import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for (choice-points/machine.js).
const SYNC_IDLE_MS = 2000;

const DAY = "2026-10-14";
const DAY2 = "2026-10-13";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const ID3 = "01ARZ3NDEKTSV4RRFFQ69G5CP3";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/choice-point.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");

const saved = (over = {}) => ({
  type: "choice-point.saved",
  id: ID,
  day: DAY,
  situation: "Meeting ran late",
  thoughts: "",
  away: "",
  towards: "",
  ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
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
  };
}

const askUser = (userId) => () => Promise.resolve({ userId, registrationOpen: false });

// The server as a fake: last write wins, a delete always wins, versions assigned here.
function fakeApi({ pull } = {}) {
  const server = new Map();
  const puts = [];
  const pulls = [];
  return {
    server,
    puts,
    pulls,
    put: async (row) => {
      puts.push(row);
      const held = server.get(row.id);
      if (held?.deleted) return held;
      const { baseVersion, ...rest } = row;
      const r = { ...rest, deleted: Boolean(row.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1 };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => {
      pulls.push(since);
      return pull ? pull(since) : { choicePoints: [], cursor: since };
    },
  };
}

function start(store, { api, ask } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask }, clock });
  const changed = [];
  const deleted = [];
  actor.on("choice-point.changed", (e) => {
    assert.ok(changedSchema.validate({ choicePoint: e.choicePoint }).valid, JSON.stringify(e));
    changed.push(e.choicePoint);
  });
  actor.on("choice-point.deleted", (e) => deleted.push(e));
  actor.start();
  return { actor, changed, deleted, clock };
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

const list = (actor, payload = { day: DAY }) =>
  new Promise((reply) => actor.send({ type: "list?", cid: "c", payload, reply })).then((r) => {
    assert.ok(listReply.validate(r).valid, JSON.stringify(r));
    return r.choicePoints;
  });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Signed out ------------------------------------------------------------------------

test("signed out: a new choice point is version 1, announced with when it was added, and listed with its day", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved());
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0], {
    id: ID,
    day: DAY,
    situation: "Meeting ran late",
    thoughts: "",
    away: "",
    towards: "",
    createdAt: "2016-07-30T23:54:10.259Z",
    version: 1,
    pending: false,
    removing: false,
  });
  assert.equal((await list(actor)).length, 1);
  assert.deepEqual(await list(actor, { day: DAY2 }), [], "another day has its own list");
  assert.equal(store.rows.get(ID).version, 1, "cached");
  assert.equal(api.puts.length, 0, "signed out never calls the api");
});

test("list answers one day's choice points, or every day's, oldest first", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ id: ID2, situation: "Second" }));
  actor.send(saved({ id: ID, situation: "First" }));
  actor.send(saved({ id: ID3, day: DAY2, situation: "Yesterday" }));
  assert.deepEqual((await list(actor)).map((c) => c.situation), ["First", "Second"]);
  assert.deepEqual((await list(actor, {})).map((c) => c.situation), ["First", "Second", "Yesterday"]);
});

test("a new choice point with all four boxes empty, or without a day, is not kept", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ situation: "" }));
  actor.send(saved({ day: "today" }));
  assert.equal(changed.length, 0);
  actor.send(saved({ situation: "", towards: "Breathe" }));
  assert.equal(changed.length, 1);
});

test("a save changes the texts, keeps the day, mints the next version, and the same texts are no change", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ day: DAY2, thoughts: "Not again", away: "Snapped", towards: "Paused" }));
  const last = changed.at(-1);
  assert.deepEqual([last.day, last.thoughts, last.away, last.towards, last.version], [DAY, "Not again", "Snapped", "Paused", 2]);
  actor.send(saved({ thoughts: "Not again", away: "Snapped", towards: "Paused" }));
  assert.equal(changed.length, 2);
});

test("a save that empties all four boxes of a kept one removes it, and its tombstone keeps the texts", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved({ away: "Snapped" }));
  actor.send(saved({ situation: "", thoughts: "", away: "", towards: "" }));
  assert.equal(changed.length, 1, "no change is announced, only the deletion");
  assert.deepEqual(deleted, [{ type: "choice-point.deleted", id: ID, day: DAY }]);
  assert.deepEqual(await list(actor), []);
  const tomb = store.rows.get(ID);
  assert.deepEqual([tomb.deleted, tomb.situation, tomb.away, tomb.version], [true, "Meeting ran late", "Snapped", 2]);
});

test("a gesture or query that lands while the store loads waits for it", async () => {
  let release;
  const store = fakeStore();
  const all = store.all;
  store.all = () => new Promise((r) => (release = () => r(all())));
  const { actor, changed } = start(store);
  actor.send(saved());
  const answer = list(actor);
  release();
  await ready(actor);
  assert.equal(changed.length, 1);
  assert.equal((await answer).length, 1);
});

test("a store that rejects fails the fact, and the list is answered empty", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no idb"));
  const { actor } = start(store);
  const answer = list(actor);
  await flush();
  assert.deepEqual(await answer, []);
  assert.deepEqual(await list(actor), []);
});

// --- Signed in -------------------------------------------------------------------------

test("signed in: a save is pending, waits out the idle window, then is acknowledged", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  assert.equal(changed.at(-1).pending, true);
  assert.equal(store.outbox.get(ID).baseVersion, null);
  assert.equal(api.puts.length, 0, "not before the window");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual(Object.keys(api.puts[0]).sort(), ["away", "baseVersion", "day", "id", "situation", "thoughts", "towards"]);
  assert.deepEqual([changed.at(-1).pending, changed.at(-1).version], [false, 1]);
  assert.equal(store.outbox.size, 0);
});

test("signed in: edits within the window coalesce into one write", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ away: "Two" }));
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(saved({ away: "Three" }));
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual([api.puts[0].away, api.puts[0].baseVersion], ["Three", null]);
});

test("signed in: emptying the boxes is sent as a delete and drains", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  actor.send(saved({ situation: "" }));
  assert.equal(deleted.length, 1);
  await drain(clock);
  assert.deepEqual([api.puts[1].deleted, api.puts[1].baseVersion], [true, 1]);
  assert.equal(store.outbox.size, 0);
  assert.equal(api.server.get(ID).deleted, true);
});

test("signed in but offline: the row stays and is sent at the next focus", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const put = api.put;
  let offline = true;
  api.put = (row) => (offline ? Promise.reject(new Error("offline")) : put(row));
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  assert.equal(store.outbox.size, 1);
  offline = false;
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(store.outbox.size, 0);
  assert.equal(changed.at(-1).pending, false);
});

test("signed in: a 401 drops the session", async () => {
  const store = fakeStore();
  const api = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ choicePoints: [], cursor: since }) };
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  assert.equal(store.meta.get("userId"), null);
  assert.equal(store.outbox.size, 1, "the change waits for the next sign-in");
});

test("signed in: a pull adopts newer records, announces them and advances the cursor", async () => {
  const store = fakeStore();
  const remote = { id: ID, day: DAY, situation: "From the phone", thoughts: "", away: "", towards: "", version: 4, deleted: false };
  const api = fakeApi({ pull: () => ({ choicePoints: [remote], cursor: 7 }) });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual([changed.at(-1).situation, changed.at(-1).version, changed.at(-1).pending], ["From the phone", 4, false]);
  assert.equal(store.meta.get("cursor"), 7);
});

test("a pulled tombstone takes away a choice point this tab was showing", async () => {
  const held = { id: ID, day: DAY, situation: "Kept", thoughts: "", away: "", towards: "", version: 1 };
  const api = fakeApi({ pull: () => ({ choicePoints: [{ ...held, version: 2, deleted: true }], cursor: 3 }) });
  const { actor, deleted } = start(fakeStore([held]), { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(deleted, [{ type: "choice-point.deleted", id: ID, day: DAY }]);
  assert.deepEqual(await list(actor), []);
});

test("a write onto a tombstone on the server adopts the delete", async () => {
  const api = fakeApi();
  const { actor, clock, deleted } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  api.server.set(ID, { id: ID, day: DAY, situation: "Gone", thoughts: "", away: "", towards: "", version: 3, deleted: true });
  actor.send(saved());
  await drain(clock);
  assert.equal(deleted.length, 1);
  assert.deepEqual(await list(actor), []);
});

test("sign-in uploads what was made signed out, with its history, tombstones included", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ away: "Snapped" }));
  actor.send(saved({ id: ID2, situation: "Gone" }));
  actor.send(saved({ id: ID2, situation: "" }));
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(
    api.puts.map((p) => [p.id, p.baseVersion, Boolean(p.deleted)]),
    [
      [ID, 2, false],
      [ID2, 2, true],
    ],
  );
  assert.equal(api.server.get(ID).version, 3, "the server continues from the version minted signed out");
  assert.equal(changed.at(-1).version, 3);
  assert.equal(store.outbox.size, 0);
  assert.equal(store.meta.get("userId"), "u1");
});
