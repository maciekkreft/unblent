import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for (matrices/machine.js). Nothing here lists the Eisenhower
// evaluator, so nothing is asked about; suggest.test.mjs covers that.
const SYNC_IDLE_MS = 2000;

const DAY = "2026-10-14";
const DAY2 = "2026-10-13";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const ID3 = "01ARZ3NDEKTSV4RRFFQ69G5CP3";
const T1 = "01ARZ3NDEKTSV4RRFFQ69G5TA1";
const T2 = "01ARZ3NDEKTSV4RRFFQ69G5TA2";
const NOW = Date.parse("2026-10-14T09:00:00.000Z");
const CREATED = "2026-10-14T09:00:00.000Z";

const task = (over = {}) => ({ id: T1, text: "Call the bank", place: null, done: false, ...over });

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/matrix.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");

const saved = (over = {}) => ({ type: "matrix.saved", id: ID, day: DAY, tasks: [task()], ...over });

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

const askUser = (userId) => (target) =>
  Promise.resolve(target === "session" ? { userId, registrationOpen: false } : { error: "no-answerer" });

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
      return pull ? pull(since) : { matrices: [], cursor: since };
    },
  };
}

function start(store, { api, ask } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask, now: () => NOW }, clock });
  const changed = [];
  const deleted = [];
  actor.on("matrix.changed", (e) => {
    assert.ok(changedSchema.validate({ matrix: e.matrix }).valid, JSON.stringify(e));
    changed.push(e.matrix);
  });
  actor.on("matrix.deleted", (e) => deleted.push(e));
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

const reply = (actor, payload = { day: DAY }) =>
  new Promise((r) => actor.send({ type: "list?", cid: "c", payload, reply: r })).then((r) => {
    assert.ok(listReply.validate(r).valid, JSON.stringify(r));
    return r;
  });
const list = async (actor, payload) => (await reply(actor, payload)).matrices;

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Signed out ------------------------------------------------------------------------

test("signed out: a new matrix is version 1, announced whole with when it was added, and listed with its day", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved({ tasks: [task(), task({ id: T2, text: "Book flights", place: "schedule", done: true })] }));
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0], {
    id: ID,
    day: DAY,
    tasks: [task(), task({ id: T2, text: "Book flights", place: "schedule", done: true })],
    createdAt: CREATED,
    version: 1,
    pending: false,
  });
  assert.equal((await list(actor)).length, 1);
  assert.deepEqual(await list(actor, { day: DAY2 }), [], "another day has its own");
  assert.equal(store.rows.get(ID).version, 1, "cached");
  assert.equal(api.puts.length, 0, "signed out never calls the api");
});

test("without a day, the list holds the 20 newest days first and says how many there are", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  for (let i = 1; i <= 22; i += 1) {
    const two = String(i).padStart(2, "0");
    const day = "2026-09-" + two;
    actor.send(saved({ id: "01ARZ3NDEKTSV4RRFFQ69G5D" + two, day }));
  }
  const { matrices, total } = await reply(actor, {});
  assert.equal(total, 22);
  assert.equal(matrices.length, 20);
  assert.deepEqual([matrices[0].day, matrices.at(-1).day], ["2026-09-22", "2026-09-03"]);
});

test("a matrix with no task, without a day, or on a day that has one already is not kept", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved({ tasks: [] }));
  actor.send(saved({ day: "today" }));
  assert.equal(changed.length, 0);
  assert.equal(deleted.length, 0, "there was nothing to delete");
  assert.equal(store.rows.size, 0);
  actor.send(saved());
  actor.send(saved({ id: ID2 }));
  assert.equal(changed.length, 1, "one matrix per day");
  assert.deepEqual((await list(actor)).map((m) => m.id), [ID]);
});

test("a copy names the day it came from, and keeps its day and that day for good", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ day: DAY, from: DAY2 }));
  assert.equal(changed.at(-1).from, DAY2);
  actor.send(saved({ day: "2026-10-20", from: "2026-10-01", tasks: [task({ text: "Call the bank today" })] }));
  const last = changed.at(-1);
  assert.deepEqual([last.day, last.from, last.tasks[0].text, last.version], [DAY, DAY2, "Call the bank today", 2]);
  actor.send(saved({ id: ID2, day: "2026-10-15", from: "2026-10-16" }));
  assert.equal(changed.at(-1).from, undefined, "a later day is no day to copy from");
});

test("a save changes the tasks and mints the next version; the same tasks are no change", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ tasks: [task({ place: "do" })] }));
  actor.send(saved({ tasks: [task({ place: "do" })] }));
  assert.equal(changed.length, 2);
  assert.deepEqual([changed.at(-1).tasks[0].place, changed.at(-1).version], ["do", 2]);
  actor.send(saved({ tasks: [task({ id: T2, text: "B" }), task({ place: "do" })] }));
  actor.send(saved({ tasks: [task({ place: "do" }), task({ id: T2, text: "B" })] }));
  assert.equal(changed.length, 4, "the order is a change");
});

test("a save that leaves no task removes the matrix, and its tombstone keeps the tasks", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ tasks: [] }));
  assert.equal(changed.length, 1, "no change is announced, only the deletion");
  assert.deepEqual(deleted, [{ type: "matrix.deleted", id: ID, day: DAY }]);
  assert.deepEqual(await list(actor), []);
  const tomb = store.rows.get(ID);
  assert.deepEqual([tomb.deleted, tomb.tasks, tomb.version], [true, [task()], 2]);
  actor.send(saved());
  assert.equal(changed.length, 1, "a save to a deleted matrix leaves it deleted");
});

test("a stored copy holding what cannot be read keeps only what can", async () => {
  const held = {
    id: ID,
    day: DAY,
    tasks: [task(), { id: "x", text: "no id" }, task({ id: T2, place: "soon", done: "yes", suggested: { place: "do" } }), task({ text: "again" }), 7],
    version: 2,
  };
  const { actor } = start(fakeStore([held]));
  await ready(actor);
  const [matrix] = await list(actor);
  assert.deepEqual(matrix.tasks, [task(), task({ id: T2 })]);
  assert.equal(matrix.createdAt, new Date(Date.parse("2016-07-30T23:54:10.259Z")).toISOString(), "a copy without createdAt has its id's time");
});

test("a gesture or query that lands while the store loads waits for it", async () => {
  let release;
  const store = fakeStore();
  const all = store.all;
  const gate = new Promise((r) => (release = r));
  store.all = () => gate.then(() => all());
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
  const answer = reply(actor);
  await flush();
  assert.deepEqual(await answer, { matrices: [], total: 0 });
  assert.deepEqual(await list(actor), []);
});

// --- Signed in -------------------------------------------------------------------------

test("signed in: a save is pending, waits out the idle window, then is acknowledged", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved({ from: DAY2 }));
  assert.equal(changed.at(-1).pending, true);
  assert.equal(store.outbox.get(ID).baseVersion, null);
  assert.equal(api.puts.length, 0, "not before the window");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual(Object.keys(api.puts[0]).sort(), ["baseVersion", "createdAt", "day", "from", "id", "tasks"]);
  assert.deepEqual([changed.at(-1).pending, changed.at(-1).version], [false, 1]);
  assert.equal(store.outbox.size, 0);
});

test("signed in: edits within the window coalesce into one write", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ tasks: [task({ text: "Call" })] }));
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(saved({ tasks: [task({ text: "Call the bank now" })] }));
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual([api.puts[0].tasks[0].text, api.puts[0].baseVersion], ["Call the bank now", null]);
});

test("signed in: a save with no task is sent as a delete and drains", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  actor.send(saved({ tasks: [] }));
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
  const api = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ matrices: [], cursor: since }) };
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  assert.equal(store.meta.get("userId"), null);
  assert.equal(store.outbox.size, 1, "the change waits for the next sign-in");
});

test("signed in: a pull adopts newer records, announces them and advances the cursor", async () => {
  const store = fakeStore();
  const remote = { id: ID, day: DAY, tasks: [task({ place: "drop" })], createdAt: CREATED, version: 4, deleted: false };
  const api = fakeApi({ pull: () => ({ matrices: [remote], cursor: 7 }) });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual([changed.at(-1).tasks[0].place, changed.at(-1).version, changed.at(-1).pending], ["drop", 4, false]);
  assert.equal(store.meta.get("cursor"), 7);
});

test("a local change not yet sent wins over a pulled one, and is sent", async () => {
  const held = { id: ID, day: DAY, tasks: [task({ text: "Three" })], createdAt: CREATED, version: 1 };
  const remote = { ...held, tasks: [task({ text: "Two" })], version: 2, deleted: false };
  const row = { id: ID, day: DAY, tasks: [task({ text: "Three" })], createdAt: CREATED, baseVersion: 1 };
  const api = fakeApi({ pull: () => ({ matrices: [remote], cursor: 3 }) });
  const { actor } = start(fakeStore([held], [row]), { api, ask: askUser("u1") });
  await ready(actor);
  assert.equal((await list(actor))[0].tasks[0].text, "Three");
  assert.equal(api.puts[0].tasks[0].text, "Three");
});

test("a pulled tombstone takes away a matrix this tab was showing", async () => {
  const held = { id: ID, day: DAY, tasks: [task()], createdAt: CREATED, version: 1 };
  const api = fakeApi({ pull: () => ({ matrices: [{ ...held, version: 2, deleted: true }], cursor: 3 }) });
  const { actor, deleted } = start(fakeStore([held]), { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(deleted, [{ type: "matrix.deleted", id: ID, day: DAY }]);
  assert.deepEqual(await list(actor), []);
});

test("a write onto a tombstone on the server adopts the delete", async () => {
  const api = fakeApi();
  const { actor, clock, deleted } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  api.server.set(ID, { id: ID, day: DAY, tasks: [task()], createdAt: CREATED, version: 3, deleted: true });
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
  actor.send(saved({ tasks: [task({ place: "do" })] }));
  actor.send(saved({ id: ID2, day: DAY2 }));
  actor.send(saved({ id: ID2, day: DAY2, tasks: [] }));
  actor.send(saved({ id: ID3, day: "2026-10-12" }));
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(
    api.puts.map((p) => [p.id, p.baseVersion, Boolean(p.deleted)]),
    [
      [ID, 2, false],
      [ID2, 2, true],
      [ID3, 1, false],
    ],
  );
  assert.equal(api.server.get(ID).version, 3, "the server continues from the version minted signed out");
  assert.equal(changed.find((m) => m.id === ID && m.version === 3)?.tasks[0].place, "do");
  assert.equal(store.outbox.size, 0);
  assert.equal(store.meta.get("userId"), "u1");
});
