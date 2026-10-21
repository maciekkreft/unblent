import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for (evaluators/machine.js).
const SYNC_IDLE_MS = 2000;

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const BOOK2 = "01ARZ3NDEKTSV4RRFFQ69G5BK2";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5QQ1";
const Q2 = "01ARZ3NDEKTSV4RRFFQ69G5QQ2";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G50P1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G50P2";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/evaluator.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");

const yesno = (id = Q1, text = "Is this a goal?") => ({ id, kind: "yesno", text, yes: "it can be finished", no: "", options: [] });
const pick = (id = Q2, options = [{ id: O1, name: "Goal", description: "" }, { id: O2, name: "Value", description: "" }]) => ({
  id,
  kind: "pick",
  text: "Goal or value?",
  yes: "",
  no: "",
  options,
});
const saved = (over = {}) => ({ type: "evaluator.saved", id: ID, book: BOOK, name: "Goals", questions: [yesno()], ...over });

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
      // A row without a name only moves (5): its place is kept, no version is bumped.
      if (!("name" in row)) {
        if (!held) return { id: row.id, missing: true };
        const moved = { ...held, position: row.position };
        server.set(row.id, moved);
        return moved;
      }
      const { baseVersion, ...rest } = row;
      const r = { ...rest, deleted: Boolean(row.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1 };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => {
      pulls.push(since);
      return pull ? pull(since) : { evaluators: [], cursor: since };
    },
  };
}

function start(store, { api, ask, now } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask, now }, clock });
  const changed = [];
  const deleted = [];
  actor.on("evaluator.changed", (e) => {
    assert.ok(changedSchema.validate({ evaluator: e.evaluator }).valid, JSON.stringify(e));
    changed.push(e.evaluator);
  });
  actor.on("evaluator.deleted", (e) => deleted.push(e));
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

const list = (actor, book = BOOK) =>
  new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: { book }, reply })).then((r) => {
    assert.ok(listReply.validate(r).valid, JSON.stringify(r));
    return r.evaluators;
  });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

test("a change of content is stamped with its time, kept in the cache and the outbox; a mark keeps the stamp", async () => {
  const store = fakeStore([{ id: ID2, book: BOOK, name: "Old", on: true, questions: [], version: 1 }]);
  const api = fakeApi();
  const times = ["2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z"];
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1"), now: () => times.shift() });
  await ready(actor);
  actor.send(saved());
  assert.equal(changed.at(-1).updatedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(store.outbox.get(ID).updatedAt, "2026-03-01T00:00:00.000Z", "sent, so the server keeps the browser's time");
  actor.send({ type: "removal.started", kind: "question", id: Q1 });
  assert.equal(changed.at(-1).updatedAt, "2026-03-01T00:00:00.000Z");
  actor.send(saved({ name: "Renamed" }));
  assert.equal(store.rows.get(ID).updatedAt, "2026-03-02T00:00:00.000Z");
  const listed = await list(actor);
  assert.deepEqual(listed.map((r) => [r.id, r.updatedAt]), [[ID, "2026-03-02T00:00:00.000Z"], [ID2, undefined]], "one kept from before has none");
  await drain(clock);
  assert.equal(api.puts.at(-1).updatedAt, "2026-03-02T00:00:00.000Z");
});

// --- Signed out: minting and announcing without a server ------------------------------

test("signed out: a new evaluator is switched on at version 1, announced and listed with its book", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved());
  assert.equal(changed.length, 1);
  assert.deepEqual(
    { on: changed[0].on, version: changed[0].version, pending: changed[0].pending, book: changed[0].book },
    { on: true, version: 1, pending: false, book: BOOK },
  );
  assert.equal((await list(actor)).length, 1);
  assert.deepEqual(await list(actor, BOOK2), [], "another book has its own list");
  assert.equal(store.rows.get(ID).version, 1, "cached");
  assert.equal(api.puts.length, 0, "signed out never calls the api");
});

test("list answers one book's evaluators, or every book's without a book, each new one first", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ id: ID2, name: "Second" }));
  actor.send(saved({ id: ID, name: "First" }));
  actor.send(saved({ id: "01ARZ3NDEKTSV4RRFFQ69G5EV3", book: BOOK2, name: "Elsewhere" }));
  assert.deepEqual((await list(actor)).map((e) => e.name), ["First", "Second"]);
  const every = await new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }));
  assert.ok(listReply.validate(every).valid, JSON.stringify(every));
  assert.deepEqual(every.evaluators.map((e) => e.name), ["Elsewhere", "First", "Second"]);
});

test("signed out: a save changes name and questions, keeps book and tick, and mints the next version", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send({ type: "evaluator.switched", id: ID, on: false });
  actor.send(saved({ book: BOOK2, name: "Renamed", questions: [yesno(), pick()] }));
  const last = changed.at(-1);
  assert.deepEqual([last.name, last.book, last.on, last.version, last.questions.length], ["Renamed", BOOK, false, 3, 2]);
  actor.send(saved({ book: BOOK2, name: "Renamed", questions: [yesno(), pick()] }));
  assert.equal(changed.length, 3, "the same content is not a change");
});

test("a question's switch is kept and announced: off is a change, and a question without it is on", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  assert.equal(changed.at(-1).questions[0].on, true);
  actor.send(saved({ questions: [{ ...yesno(), on: false }] }));
  assert.deepEqual([changed.at(-1).questions[0].on, changed.at(-1).version], [false, 2]);
  assert.equal((await list(actor))[0].questions[0].on, false);
  actor.send(saved({ questions: [{ ...yesno(), on: true }] }));
  assert.deepEqual([changed.at(-1).questions[0].on, changed.at(-1).version], [true, 3]);
  actor.send(saved({ questions: [yesno()] }));
  assert.equal(changed.length, 3, "a question without the switch is the same as one switched on");
});

test("an option's icon is kept, announced, listed and sent; a save without it takes it away", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  const withHeart = pick(Q2, [{ id: O1, name: "Goal", description: "", icon: "heart" }, { id: O2, name: "Value", description: "" }]);
  actor.send(saved({ questions: [withHeart] }));
  assert.deepEqual(changed.at(-1).questions[0].options.map((o) => o.icon), ["heart", undefined]);
  assert.equal((await list(actor))[0].questions[0].options[0].icon, "heart");
  await drain(clock);
  assert.equal(api.puts[0].questions[0].options[0].icon, "heart");
  actor.send(saved({ questions: [pick()] }));
  assert.equal("icon" in changed.at(-1).questions[0].options[0], false, "No icon is the option without one");
  actor.send(saved({ questions: [pick()] }));
  assert.equal(changed.length, 3, "the same save again is no change");
});

test("a question's expected answer is kept while it names an answer it has, comes back on Undo, and goes when its option settles", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ questions: [{ ...yesno(), expect: "no" }, { ...pick(), expect: O1 }] }));
  assert.deepEqual(changed.at(-1).questions.map((q) => q.expect), ["no", O1]);
  actor.send(saved({ questions: [{ ...yesno(), expect: O1 }, { ...pick(), expect: "01ARZ3NDEKTSV4RRFFQ69G50P9" }] }));
  assert.deepEqual(changed.at(-1).questions.map((q) => q.expect), [undefined, undefined], "an answer the question does not have is none");
  actor.send(saved({ questions: [yesno(), { ...pick(), kind: "yesno", expect: O1 }] }));
  assert.equal(changed.at(-1).questions[1].expect, O1, "switched to yes / no, its options and their expectation are kept");
  actor.send(saved({ questions: [yesno(), { ...pick(), expect: O1 }] }));
  assert.equal(changed.at(-1).questions[1].expect, O1, "and switching back has it again");
  actor.send(saved({ questions: [yesno(), { ...pick(), expect: O1 }] }));
  actor.send({ type: "removal.started", kind: "option", id: O1, name: "Goal" });
  actor.send(saved({ questions: [yesno(), { ...pick(Q2, [{ id: O2, name: "Value", description: "" }]), expect: O1 }] }));
  assert.equal(changed.at(-1).questions[1].expect, O1, "kept while the option waits out its undo window");
  actor.send({ type: "removal.undone", kind: "option", id: O1 });
  assert.equal(changed.at(-1).questions[1].expect, O1);
  actor.send({ type: "removal.started", kind: "option", id: O1, name: "Goal" });
  actor.send({ type: "removal.settled", kind: "option", id: O1 });
  assert.equal("expect" in changed.at(-1).questions[1], false, "the settled option took it away");
});

test("a journal flag left from Show in journal is neither kept, announced nor sent", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ journal: true }));
  assert.equal("journal" in changed.at(-1), false);
  actor.send(saved({ journal: false }));
  assert.equal(changed.at(-1).version, 1, "the flag alone is no change");
  assert.equal("journal" in (await list(actor))[0], false);
});

test("switching keeps the tick, and the same tick or an unknown id is no change", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send({ type: "evaluator.switched", id: ID, on: false });
  assert.equal(changed.at(-1).on, false);
  actor.send({ type: "evaluator.switched", id: ID, on: false });
  actor.send({ type: "evaluator.switched", id: ID2, on: true });
  assert.equal(changed.length, 2);
  assert.equal((await list(actor))[0].on, false);
});

// --- Removal ---------------------------------------------------------------------------

test("an evaluator's removal marks it, Undo unmarks it, and settling makes it a tombstone", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved());
  actor.send({ type: "removal.started", kind: "evaluator", id: ID, name: "Goals" });
  assert.deepEqual([changed.at(-1).removing, changed.at(-1).version], [true, 1], "a mark is not a new version");
  actor.send({ type: "removal.undone", kind: "evaluator", id: ID });
  assert.equal(changed.at(-1).removing, false);
  actor.send({ type: "removal.settled", kind: "evaluator", id: ID });
  assert.deepEqual(deleted, [], "an undone removal does not settle");
  actor.send({ type: "removal.started", kind: "evaluator", id: ID, name: "Goals" });
  actor.send({ type: "removal.settled", kind: "evaluator", id: ID });
  assert.deepEqual(deleted, [{ type: "evaluator.deleted", id: ID, book: BOOK }]);
  assert.deepEqual(await list(actor), []);
  assert.deepEqual([store.rows.get(ID).deleted, store.rows.get(ID).version], [true, 2], "kept as a tombstone");
  actor.send(saved({ name: "Back?" }));
  assert.deepEqual(await list(actor), [], "a deleted id stays deleted");
});

test("a question or an option is marked, kept through a save that leaves it out, and dropped on settle", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ questions: [yesno(), pick()] }));
  actor.send({ type: "removal.started", kind: "option", id: O1, name: "Goal" });
  actor.send({ type: "removal.started", kind: "question", id: Q1, name: "" });
  // The editor saves without what it shows as removed; the marked items stay.
  actor.send(saved({ name: "Goals 2", questions: [pick(Q2, [{ id: O2, name: "Value", description: "" }])] }));
  let now = changed.at(-1);
  assert.deepEqual(now.questions.map((q) => [q.id, q.removing]), [[Q1, true], [Q2, false]]);
  assert.deepEqual(now.questions[1].options.map((o) => [o.id, o.removing]), [[O1, true], [O2, false]]);
  actor.send({ type: "removal.undone", kind: "question", id: Q1 });
  actor.send({ type: "removal.settled", kind: "option", id: O1 });
  now = changed.at(-1);
  assert.deepEqual(now.questions.map((q) => [q.id, q.removing]), [[Q1, false], [Q2, false]]);
  assert.deepEqual(now.questions[1].options.map((o) => o.id), [O2]);
  const count = changed.length;
  actor.send({ type: "removal.settled", kind: "question", id: Q1 });
  assert.equal(changed.length, count, "an undone question does not settle");
});

test("a removal of another fact's id passes by", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send({ type: "removal.started", kind: "option", id: O1, name: "" });
  actor.send({ type: "removal.started", kind: "case", id: ID, name: "" });
  assert.equal(changed.length, 1);
});

test("a mark left by a closed tab settles at the next load", async () => {
  const marked = {
    id: ID,
    book: BOOK,
    name: "Goals",
    on: true,
    version: 2,
    removing: false,
    questions: [{ ...pick(), removing: false, options: [{ id: O1, name: "Goal", description: "", removing: true }] }],
  };
  const gone = { id: ID2, book: BOOK, name: "Old", on: true, version: 1, removing: true, questions: [] };
  const store = fakeStore([marked, gone]);
  const { actor } = start(store);
  await ready(actor);
  const evaluators = await list(actor);
  assert.deepEqual(evaluators.map((e) => e.id), [ID]);
  assert.deepEqual(evaluators[0].questions[0].options, [], "the option went");
  assert.equal(evaluators[0].version, 3);
  assert.equal(store.rows.get(ID2).deleted, true);
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

// --- Signed in: outbox and sync --------------------------------------------------------

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
  assert.deepEqual(Object.keys(api.puts[0]).sort(), ["baseVersion", "book", "id", "name", "on", "position", "questions", "starterFor", "updatedAt"]);
  assert.deepEqual([changed.at(-1).pending, changed.at(-1).version], [false, 1]);
  assert.equal(store.outbox.size, 0);
});

test("signed in: edits within the window coalesce into one write, with no mark sent", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved({ questions: [pick()] }));
  actor.send({ type: "removal.started", kind: "option", id: O1, name: "" });
  actor.send(saved({ name: "Two", questions: [pick()] }));
  actor.send({ type: "evaluator.switched", id: ID, on: false });
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(saved({ name: "Three", questions: [pick()] }));
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual([api.puts[0].name, api.puts[0].on, api.puts[0].baseVersion], ["Three", false, null]);
  assert.ok(!JSON.stringify(api.puts[0]).includes("removing"), "marks belong to this tab");
  assert.equal(api.puts[0].questions[0].options.length, 2, "the marked option is sent until it settles");
});

test("signed in: a settled removal is sent as a delete and drains", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  actor.send({ type: "removal.started", kind: "evaluator", id: ID, name: "" });
  await drain(clock);
  assert.equal(api.puts.length, 1, "a mark is not a write");
  actor.send({ type: "removal.settled", kind: "evaluator", id: ID });
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
  const api = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ evaluators: [], cursor: since }) };
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  await drain(clock);
  assert.equal(store.meta.get("userId"), null);
  assert.equal(store.outbox.size, 1, "the change waits for the next sign-in");
});

test("signed in: a pull adopts newer records, announces them and advances the cursor", async () => {
  const store = fakeStore();
  const remote = { id: ID, book: BOOK, name: "From the phone", on: false, questions: [yesno()], version: 4, deleted: false };
  const api = fakeApi({ pull: () => ({ evaluators: [remote], cursor: 7 }) });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual([changed.at(-1).name, changed.at(-1).version, changed.at(-1).pending], ["From the phone", 4, false]);
  assert.equal(store.meta.get("cursor"), 7);
  assert.equal((await list(actor))[0].on, false);
});

test("a pulled tombstone takes away an evaluator this tab was showing", async () => {
  const held = { id: ID, book: BOOK, name: "Goals", on: true, questions: [], version: 1 };
  const api = fakeApi({ pull: () => ({ evaluators: [{ ...held, version: 2, deleted: true }], cursor: 3 }) });
  const { actor, deleted } = start(fakeStore([held]), { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(deleted, [{ type: "evaluator.deleted", id: ID, book: BOOK }]);
  assert.deepEqual(await list(actor), []);
});

test("a write onto a tombstone on the server adopts the delete", async () => {
  const api = fakeApi();
  const { actor, clock, deleted } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  api.server.set(ID, { id: ID, book: BOOK, name: "Goals", on: true, questions: [], version: 3, deleted: true });
  actor.send(saved());
  await drain(clock);
  assert.equal(deleted.length, 1);
  assert.deepEqual(await list(actor), []);
});

// --- Signing in ------------------------------------------------------------------------

test("sign-in uploads what was made signed out, with its history, tombstones included", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ name: "Goals 2" }));
  actor.send(saved({ id: ID2, name: "Gone" }));
  actor.send({ type: "removal.started", kind: "evaluator", id: ID2, name: "Gone" });
  actor.send({ type: "removal.settled", kind: "evaluator", id: ID2 });
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

// --- Places in the list (5, an item's place is last write wins) ----------------------

const ID3 = "01ARZ3NDEKTSV4RRFFQ69G5EV3";
const old = (id, name) => ({ id, book: BOOK, name, on: true, questions: [yesno()], version: 2 });

test("evaluators from before places keep their order, oldest first; a new one goes first and an edit moves none", async () => {
  const { actor, changed } = start(fakeStore([old(ID2, "Second"), old(ID, "First")]));
  await ready(actor);
  assert.deepEqual((await list(actor)).map((e) => e.name), ["First", "Second"]);
  actor.send(saved({ id: ID3, name: "New" }));
  assert.deepEqual((await list(actor)).map((e) => e.name), ["New", "First", "Second"]);
  actor.send(saved({ id: ID2, name: "Second, edited" }));
  assert.deepEqual((await list(actor)).map((e) => e.name), ["New", "First", "Second, edited"]);
  assert.ok(changed.every((e) => typeof e.position === "string"), "every announcement carries the place");
});

test("a move puts an evaluator between its neighbours, changes no version, and is kept in the cache", async () => {
  const store = fakeStore([old(ID, "First"), old(ID2, "Second"), old(ID3, "Third")]);
  const { actor, changed } = start(store);
  await ready(actor);
  actor.send({ type: "evaluator.moved", id: ID3, after: null, before: ID });
  assert.deepEqual((await list(actor)).map((e) => e.name), ["Third", "First", "Second"]);
  actor.send({ type: "evaluator.moved", id: ID, after: ID2, before: null });
  assert.deepEqual((await list(actor)).map((e) => e.name), ["Third", "Second", "First"]);
  actor.send({ type: "evaluator.moved", id: ID2, after: ID3, before: ID });
  assert.deepEqual((await list(actor)).map((e) => e.name), ["Third", "Second", "First"], "already there");
  assert.equal(changed.at(-1).version, 2, "a move is no new version");
  assert.equal(store.rows.get(ID).position, changed.find((e) => e.id === ID).position);
  actor.send({ type: "evaluator.moved", id: "01ARZ3NDEKTSV4RRFFQ69G5EV9", after: null, before: null });
  assert.equal((await list(actor)).length, 3, "an unknown id moves nothing");
});

test("signed in: a move is sent alone and drains; a pulled move from elsewhere is taken", async () => {
  const api = fakeApi();
  const remote = [];
  api.pull = async (since) => (api.pulls.push(since), { evaluators: remote.splice(0), cursor: since + 1 });
  for (const r of [old(ID, "First"), old(ID2, "Second")]) api.server.set(r.id, { ...r, deleted: false });
  const store = fakeStore([old(ID, "First"), old(ID2, "Second")]);
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send({ type: "evaluator.moved", id: ID2, after: null, before: ID });
  assert.deepEqual(Object.keys(store.outbox.get(ID2)).sort(), ["id", "position"]);
  await drain(clock);
  assert.deepEqual(Object.keys(api.puts.at(-1)).sort(), ["id", "position"], "only the place is sent");
  assert.equal(store.outbox.size, 0, "drained");
  assert.equal(api.server.get(ID2).version, 2);
  // Another device moved First to the top.
  remote.push({ ...api.server.get(ID), position: "1", deleted: false });
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.deepEqual((await list(actor)).map((e) => e.name), ["First", "Second"]);
});

test("signed in: an edit after a move sends both, and an edit alone never carries a place", async () => {
  const api = fakeApi();
  for (const r of [old(ID, "First"), old(ID2, "Second")]) api.server.set(r.id, { ...r, deleted: false });
  const { actor, clock } = start(fakeStore([old(ID, "First"), old(ID2, "Second")]), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved({ id: ID, name: "First, edited" }));
  await drain(clock);
  assert.equal("position" in api.puts.at(-1), false, "an edit alone keeps the place the server holds");
  actor.send({ type: "evaluator.moved", id: ID, after: ID2, before: null });
  actor.send(saved({ id: ID, name: "First, again" }));
  await drain(clock);
  assert.equal(api.puts.at(-1).name, "First, again");
  assert.equal(typeof api.puts.at(-1).position, "string");
});
