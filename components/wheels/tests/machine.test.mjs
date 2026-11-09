import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for (wheels/machine.js).
const SYNC_IDLE_MS = 2000;

const DAY = "2026-10-14";
const DAY2 = "2026-10-13";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const ID3 = "01ARZ3NDEKTSV4RRFFQ69G5CP3";

const NONE = Array(8).fill(null);
const first = (score) => [score, null, null, null, null, null, null, null];
const EMPTY = Array(8).fill({});
const NOFOCUS = Array(8).fill(false);
const chose = (...areas) => NOFOCUS.map((_, i) => areas.includes(i));
const said = (answer) => [answer, {}, {}, {}, {}, {}, {}, {}];

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/wheel.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");

const saved = (over = {}) => ({ type: "wheel.saved", id: ID, day: DAY, actual: first(6), wanted: NONE, ...over });

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

// The server as a fake: last write wins, a delete always wins, versions assigned here, and
// a write without answers keeps those held.
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
      const r = { answers: held?.answers, focus: held?.focus, ...rest, deleted: Boolean(row.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1 };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => {
      pulls.push(since);
      return pull ? pull(since) : { wheels: [], cursor: since };
    },
  };
}

function start(store, { api, ask } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask }, clock });
  const changed = [];
  const deleted = [];
  actor.on("wheel.changed", (e) => {
    assert.ok(changedSchema.validate({ wheel: e.wheel }).valid, JSON.stringify(e));
    changed.push(e.wheel);
  });
  actor.on("wheel.deleted", (e) => deleted.push(e));
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
    return r.wheels;
  });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Signed out ------------------------------------------------------------------------

test("signed out: a new wheel is version 1, announced whole, and listed with its day", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved({ wanted: first(9) }));
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0], { id: ID, day: DAY, actual: first(6), wanted: first(9), answers: EMPTY, focus: NOFOCUS, version: 1, pending: false });
  assert.equal((await list(actor)).length, 1);
  assert.deepEqual(await list(actor, { day: DAY2 }), [], "another day has its own list");
  assert.equal(store.rows.get(ID).version, 1, "cached");
  assert.equal(api.puts.length, 0, "signed out never calls the api");
});

test("list answers one day's wheels, or every day's, oldest first", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ id: ID2, actual: first(2) }));
  actor.send(saved({ id: ID, actual: first(1) }));
  actor.send(saved({ id: ID3, day: DAY2, actual: first(3) }));
  assert.deepEqual((await list(actor)).map((w) => w.actual[0]), [1, 2]);
  assert.deepEqual((await list(actor, {})).map((w) => w.actual[0]), [1, 2, 3]);
});

test("a new wheel with no score at all, or without a day, is not kept", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved({ actual: NONE }));
  actor.send(saved({ day: "today" }));
  assert.equal(changed.length, 0);
  assert.equal(deleted.length, 0, "there was nothing to delete");
  assert.equal(store.rows.size, 0);
  actor.send(saved({ actual: NONE, wanted: first(9) }));
  assert.equal(changed.length, 1, "a Wanted score alone is a wheel");
});

test("a save changes the scores, keeps the day, mints the next version, and the same scores are no change", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ day: DAY2, actual: first(7), wanted: first(9) }));
  const last = changed.at(-1);
  assert.deepEqual([last.day, last.actual[0], last.wanted[0], last.version], [DAY, 7, 9, 2]);
  actor.send(saved({ actual: first(7), wanted: first(9) }));
  assert.equal(changed.length, 2);
});

test("a save with no score at all on a kept wheel removes it, and its tombstone keeps the scores", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved({ wanted: first(9) }));
  actor.send(saved({ actual: NONE, wanted: NONE }));
  assert.equal(changed.length, 1, "no change is announced, only the deletion");
  assert.deepEqual(deleted, [{ type: "wheel.deleted", id: ID, day: DAY }]);
  assert.deepEqual(await list(actor), []);
  const tomb = store.rows.get(ID);
  assert.deepEqual([tomb.deleted, tomb.actual, tomb.wanted, tomb.version], [true, first(6), first(9), 2]);
});

test("a save to a deleted wheel leaves it deleted", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ actual: NONE }));
  actor.send(saved({ actual: first(3) }));
  assert.equal(changed.length, 1);
  assert.deepEqual(await list(actor), []);
});

test("a stored copy holding something else than a score reads as no score", async () => {
  const held = { id: ID, day: DAY, actual: [11, "6", 0, 1.5, true, 4], wanted: "none", version: 2 };
  const { actor } = start(fakeStore([held]));
  await ready(actor);
  const [wheel] = await list(actor);
  assert.deepEqual(wheel.actual, [null, null, null, null, null, 4, null, null]);
  assert.deepEqual(wheel.wanted, NONE);
});

// --- Focus -----------------------------------------------------------------------------

test("the areas chosen to focus on are kept, a save without them keeps them, and they count as a change", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ focus: chose(5, 7) }));
  assert.deepEqual(changed.at(-1).focus, chose(5, 7));
  actor.send(saved({ actual: first(7) }));
  assert.deepEqual(changed.at(-1).focus, chose(5, 7), "a save without focus keeps it");
  const before = changed.length;
  actor.send(saved({ actual: first(7), focus: chose(7) }));
  assert.equal(changed.length, before + 1, "a new choice alone is a change");
  assert.deepEqual((await list(actor))[0].focus, chose(7));
});

test("choosing alone keeps no wheel, and a choice that cannot be read counts as none", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ actual: NONE, focus: chose(1) }));
  assert.equal(changed.length, 0, "no score and no answer is not a wheel, whatever is chosen");
  actor.send(saved({ focus: ["yes", 1, null] }));
  assert.deepEqual(changed.at(-1).focus, NOFOCUS);
});

// --- Answers ---------------------------------------------------------------------------

test("a save without answers keeps those stored, and a save with answers replaces them", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ answers: said({ one: "In bed all day", ten: "Runs a marathon" }) }));
  actor.send(saved({ actual: first(7) }));
  assert.deepEqual(changed.at(-1).answers, said({ one: "In bed all day", ten: "Runs a marathon" }));
  assert.equal(changed.at(-1).actual[0], 7);
  actor.send(saved({ actual: first(7), answers: said({ closer: "Walk" }) }));
  assert.deepEqual((await list(actor))[0].answers, said({ closer: "Walk" }));
});

test("an answer takes part in whether a save is a change; an emptied box is no answer", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ answers: said({ one: "a" }) }));
  actor.send(saved({ answers: said({ one: "a" }) }));
  assert.equal(changed.length, 1, "the same answers are no change");
  actor.send(saved({ answers: said({ one: "b" }) }));
  assert.deepEqual([changed.length, changed.at(-1).version], [2, 2]);
  actor.send(saved({ answers: said({ one: "b", ten: "" }) }));
  assert.equal(changed.length, 2, "an empty string is the same as nothing written");
  actor.send(saved({ answers: said({}) }));
  assert.deepEqual([changed.length, changed.at(-1).answers], [3, EMPTY]);
});

test("a wheel holding only answers is kept; with no text left, it goes", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved({ actual: NONE, answers: said({ lower: " \n\n  " }) }));
  assert.equal(store.rows.size, 0, "spaces and blank lines on a new id keep nothing");
  actor.send(saved({ actual: NONE, answers: said({ lower: "Sleep" }) }));
  assert.deepEqual([changed.length, changed[0].actual, changed[0].answers], [1, NONE, said({ lower: "Sleep" })]);
  actor.send(saved({ actual: NONE, answers: said({ lower: "Sleep" }), wanted: first(9) }));
  actor.send(saved({ actual: NONE }));
  assert.deepEqual(deleted, [], "no score, but the answers it keeps still hold text");
  assert.deepEqual((await list(actor))[0].answers, said({ lower: "Sleep" }));
  actor.send(saved({ actual: NONE, answers: said({ lower: " \n" }) }));
  assert.equal(deleted.length, 1, "nothing but spaces left");
  assert.deepEqual(await list(actor), []);
  assert.deepEqual(store.rows.get(ID).answers, said({ lower: "Sleep" }), "its tombstone keeps what it had");
});

test("an old copy has eight empty answers, and answers that cannot be read count as empty", async () => {
  const old = { id: ID, day: DAY, actual: first(1), wanted: NONE, version: 2 };
  const bads = [
    { ...old, id: ID2, answers: "none" },
    { ...old, id: ID3, answers: [7, null, ["x"], { one: 5, ten: "kept", other: "dropped" }] },
  ];
  const { actor } = start(fakeStore([old, ...bads]));
  await ready(actor);
  const wheels = await list(actor);
  assert.deepEqual(wheels[0].answers, EMPTY);
  assert.deepEqual(wheels[1].answers, EMPTY);
  assert.deepEqual(wheels[2].answers, [{}, {}, {}, { ten: "kept" }, {}, {}, {}, {}]);
});

test("signed in: answers are written, coalesced, and acknowledged", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved({ answers: said({ one: "a" }) }));
  actor.send(saved({ answers: said({ one: "ab" }) }));
  assert.deepEqual(store.outbox.get(ID).answers, said({ one: "ab" }));
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual(api.puts[0].answers, said({ one: "ab" }));
  assert.equal(store.outbox.size, 0, "the acknowledged row is drained");
  assert.deepEqual([changed.at(-1).pending, changed.at(-1).answers], [false, said({ one: "ab" })]);
});

test("signed in: a change to answers alone is sent", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  actor.send(saved({ answers: said({ higher: "Time" }) }));
  await drain(clock);
  assert.deepEqual(api.puts.at(-1).answers, said({ higher: "Time" }));
  assert.equal(api.puts.at(-1).baseVersion, 1);
});

test("a pull brings answers, and bad ones count as empty", async () => {
  const remote = { id: ID, day: DAY, actual: first(4), wanted: NONE, answers: said({ ten: "Far" }), version: 4, deleted: false };
  const bad = { ...remote, id: ID2, answers: { one: "not a list" } };
  const api = fakeApi({ pull: () => ({ wheels: [remote, bad], cursor: 7 }) });
  const { actor } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  const wheels = await list(actor);
  assert.deepEqual(wheels[0].answers, said({ ten: "Far" }));
  assert.deepEqual(wheels[1].answers, EMPTY);
});

test("an outbox row from before answers drains once, and takes the answers the server kept", async () => {
  const held = { id: ID, day: DAY, actual: first(3), wanted: NONE, version: 1 };
  const row = { id: ID, day: DAY, actual: first(3), wanted: NONE, baseVersion: 1 };
  const api = fakeApi();
  api.server.set(ID, { ...held, answers: said({ one: "Elsewhere" }), deleted: false });
  const store = fakeStore([held], [row]);
  const { actor } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.equal(api.puts.length, 1);
  assert.equal(store.outbox.size, 0, "it does not come back as unsent");
  assert.deepEqual((await list(actor))[0].answers, said({ one: "Elsewhere" }));
});

test("sign-in uploads answers made signed out", async () => {
  const api = fakeApi();
  const { actor } = start(fakeStore(), { api });
  await ready(actor);
  actor.send(saved({ actual: NONE, answers: said({ one: "Alone" }) }));
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(api.puts[0].answers, said({ one: "Alone" }));
  assert.deepEqual(api.server.get(ID).answers, said({ one: "Alone" }));
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
  assert.deepEqual(Object.keys(api.puts[0]).sort(), ["actual", "answers", "baseVersion", "day", "focus", "id", "wanted"]);
  assert.deepEqual([changed.at(-1).pending, changed.at(-1).version], [false, 1]);
  assert.equal(store.outbox.size, 0);
});

test("signed in: edits within the window coalesce into one write", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ actual: first(7) }));
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(saved({ actual: first(8) }));
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual([api.puts[0].actual[0], api.puts[0].baseVersion], [8, null]);
});

test("signed in: a save with no score is sent as a delete and drains", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  actor.send(saved({ actual: NONE }));
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
  const api = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ wheels: [], cursor: since }) };
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  assert.equal(store.meta.get("userId"), null);
  assert.equal(store.outbox.size, 1, "the change waits for the next sign-in");
});

test("signed in: a pull adopts newer records, announces them and advances the cursor", async () => {
  const store = fakeStore();
  const remote = { id: ID, day: DAY, actual: first(4), wanted: NONE, version: 4, deleted: false };
  const api = fakeApi({ pull: () => ({ wheels: [remote], cursor: 7 }) });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual([changed.at(-1).actual[0], changed.at(-1).version, changed.at(-1).pending], [4, 4, false]);
  assert.equal(store.meta.get("cursor"), 7);
});

test("a local change not yet sent wins over a pulled one, and is sent", async () => {
  const held = { id: ID, day: DAY, actual: first(1), wanted: NONE, version: 1 };
  const remote = { ...held, actual: first(2), version: 2, deleted: false };
  const row = { id: ID, day: DAY, actual: first(3), wanted: NONE, baseVersion: 1 };
  const api = fakeApi({ pull: () => ({ wheels: [remote], cursor: 3 }) });
  const { actor } = start(fakeStore([{ ...held, actual: first(3) }], [row]), { api, ask: askUser("u1") });
  await ready(actor);
  assert.equal((await list(actor))[0].actual[0], 3);
  assert.equal(api.puts[0].actual[0], 3);
});

test("a pulled tombstone takes away a wheel this tab was showing", async () => {
  const held = { id: ID, day: DAY, actual: first(1), wanted: NONE, version: 1 };
  const api = fakeApi({ pull: () => ({ wheels: [{ ...held, version: 2, deleted: true }], cursor: 3 }) });
  const { actor, deleted } = start(fakeStore([held]), { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(deleted, [{ type: "wheel.deleted", id: ID, day: DAY }]);
  assert.deepEqual(await list(actor), []);
});

test("a write onto a tombstone on the server adopts the delete", async () => {
  const api = fakeApi();
  const { actor, clock, deleted } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  api.server.set(ID, { id: ID, day: DAY, actual: first(1), wanted: NONE, version: 3, deleted: true });
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
  actor.send(saved({ actual: first(7) }));
  actor.send(saved({ id: ID2, actual: first(1) }));
  actor.send(saved({ id: ID2, actual: NONE }));
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
