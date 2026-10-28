import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// Starters (5, 8), decided in the actor: the admin's tick is kept as starterFor and
// synced, and on a try page a visitor whose browser holds nothing gets a copy of each of
// the page's starters, kept with the Journal, before anything is listed. The store, the
// server, the session and books are fakes; the clock is simulated.
const SYNC_IDLE_MS = 2000;
const SEED_WAIT_MS = 4000;

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const JOURNAL = "00000000000000000000000JRN";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5QQ1";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G50P1";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/evaluator.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore(initial = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const outbox = new Map();
  const meta = new Map();
  return {
    rows,
    outbox,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

function fakeApi(served = []) {
  const puts = [];
  const asked = [];
  return {
    puts,
    asked,
    put: async (row) => {
      puts.push(row);
      const { baseVersion, ...rest } = row;
      return { ...rest, deleted: Boolean(row.deleted), version: (baseVersion || 0) + 1 };
    },
    pull: async (since) => ({ evaluators: [], cursor: since }),
    starters: async (page) => (asked.push(page), { evaluators: served }),
  };
}

// session: read and books: list, answered as the given user and books; values: read by nobody.
const askAs = (userId, books = [{ id: JOURNAL, title: "Journal", written: true }]) => {
  const asked = [];
  const ask = (target, name) => {
    asked.push(`${target}: ${name}`);
    if (target === "session") return Promise.resolve({ userId, registrationOpen: false });
    // A try page holds no values fact, so the bus replies at once that nobody answers.
    if (target === "values") return Promise.resolve({ error: "no-answerer" });
    return books === null ? new Promise(() => {}) : Promise.resolve({ books });
  };
  ask.asked = asked;
  return ask;
};

let next = 0;
const newId = () => `01ARZ3NDEKTSV4RRFFQ69G${String(next++).padStart(4, "0")}`;

function start(store, { api, ask, tryPage = null }) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask, tryPage, newId, now: () => "2026-10-17T10:00:00.000Z" }, clock });
  const changed = [];
  actor.on("evaluator.changed", (e) => {
    assert.ok(changedSchema.validate({ evaluator: e.evaluator }).valid, JSON.stringify(e));
    changed.push(e.evaluator);
  });
  actor.start();
  return { actor, changed, clock };
}

const list = (actor, payload = {}) =>
  new Promise((reply) => actor.send({ type: "list?", cid: "c", payload, reply })).then((r) => {
    assert.ok(listReply.validate(r).valid, JSON.stringify(r));
    return r.evaluators;
  });

const STARTER = {
  name: "Clear goal",
  description: "Checks a goal is clear",
  questions: [
    { id: Q1, on: true, kind: "pick", text: "Goal or value?", yes: "", no: "", options: [{ id: O1, name: "Goal", description: "", icon: "trophy" }], expect: O1 },
  ],
};

test("a tick is kept as starterFor, announced, and synced; unticking takes it off", async () => {
  const store = fakeStore([{ id: ID, book: BOOK, name: "Goals", on: true, questions: [], version: 1 }]);
  const api = fakeApi();
  const { actor, changed, clock } = start(store, { api, ask: askAs("admin") });
  await flush();
  actor.send({ type: "starter.ticked", evaluator: ID, page: "evaluators", on: true });
  actor.send({ type: "starter.ticked", evaluator: ID, page: "evaluators", on: true });
  assert.deepEqual(changed.at(-1).starterFor, ["evaluators"]);
  assert.equal(changed.length, 1, "the same tick twice is one change");
  clock.increment(SYNC_IDLE_MS);
  await flush();
  assert.deepEqual(api.puts.map((p) => p.starterFor), [["evaluators"]]);
  actor.send({ type: "starter.ticked", evaluator: ID, page: "evaluators", on: false });
  assert.equal("starterFor" in changed.at(-1), false, "a starter for nothing does not carry it");
  clock.increment(SYNC_IDLE_MS);
  await flush();
  assert.deepEqual(api.puts.at(-1).starterFor, [], "unticking is sent as an empty list");
  actor.send({ type: "starter.ticked", evaluator: "01ARZ3NDEKTSV4RRFFQ69G5XXX", page: "evaluators", on: true });
  assert.equal(api.puts.length, 2, "an unknown evaluator is no change");
});

test("on a try page, a visitor with nothing here gets copies of the starters before the first list", async () => {
  const store = fakeStore();
  const api = fakeApi([STARTER, { name: "Second", questions: [] }]);
  const ask = askAs(null);
  const { actor } = start(store, { api, ask, tryPage: "evaluators" });
  const first = await list(actor, { book: JOURNAL });
  assert.deepEqual(api.asked, ["evaluators"]);
  assert.deepEqual(first.map((e) => [e.name, e.description, e.book, e.on, e.version]), [
    ["Clear goal", "Checks a goal is clear", JOURNAL, true, 1],
    ["Second", "", JOURNAL, true, 1],
  ]);
  const [copy] = first;
  assert.notEqual(copy.questions[0].id, Q1, "the copy's questions have their own ids");
  assert.notEqual(copy.questions[0].options[0].id, O1, "and so have their options");
  assert.equal(copy.questions[0].options[0].name, "Goal");
  assert.equal(copy.questions[0].options[0].icon, "trophy", "and keep their icons");
  assert.equal(copy.questions[0].expect, copy.questions[0].options[0].id, "the expected answer follows its option's new id");
  assert.equal(store.rows.size, 2, "the copies are kept in this browser");
  assert.equal(store.outbox.size, 0, "nothing is sent while there is no account");
});

test("the copies upload with the rest once the guest is made", async () => {
  const store = fakeStore();
  const api = fakeApi([STARTER]);
  const { actor } = start(store, { api, ask: askAs(null), tryPage: "evaluators" });
  await list(actor);
  actor.send({ type: "session.changed", userId: "guest-1" });
  await flush();
  assert.deepEqual(api.puts.map((p) => [p.name, p.book, p.starterFor]), [["Clear goal", JOURNAL, []]]);
});

test("a browser that holds evaluators, a signed-in account, or another page gets no copies", async () => {
  for (const [store, ask, tryPage] of [
    [fakeStore([{ id: ID, book: JOURNAL, name: "Mine", on: true, questions: [], version: 1, deleted: true }]), askAs(null), "evaluators"],
    [fakeStore(), askAs("guest-1"), "evaluators"],
    [fakeStore(), askAs(null), null],
  ]) {
    const api = fakeApi([STARTER]);
    const { actor } = start(store, { api, ask, tryPage });
    const all = await list(actor);
    assert.deepEqual(api.asked, []);
    assert.equal(all.filter((e) => e.name === "Clear goal").length, 0);
  }
});

test("the Journal arriving after the list is waited for; without it the page shows no copies", async () => {
  // books lists no Journal yet; it comes on book.changed.
  {
    const api = fakeApi([STARTER]);
    const { actor } = start(fakeStore(), { api, ask: askAs(null, []), tryPage: "evaluators" });
    await flush();
    const answered = list(actor);
    actor.send({ type: "book.changed", id: JOURNAL, title: "Journal", written: true });
    assert.deepEqual((await answered).map((e) => e.book), [JOURNAL]);
  }
  // Neither comes: after the wait the list is answered, with nothing copied.
  {
    const api = fakeApi([STARTER]);
    const { actor, clock } = start(fakeStore(), { api, ask: askAs(null, null), tryPage: "evaluators" });
    await flush();
    const answered = list(actor);
    clock.increment(SEED_WAIT_MS);
    assert.deepEqual(await answered, []);
  }
});

const TRIAL = "00000000000000000000000RST";

test("Start over, once its window ends, deletes what is here and copies the starters again", async () => {
  const store = fakeStore([{ id: ID, book: JOURNAL, name: "", on: false, questions: [], version: 3 }]);
  const api = fakeApi([STARTER]);
  const { actor, clock } = start(store, { api, ask: askAs("guest-1"), tryPage: "evaluators" });
  await flush();
  assert.deepEqual(api.asked, [], "a browser that holds an evaluator gets no copies at load");
  actor.send({ type: "removal.started", kind: "trial", id: TRIAL, name: "" });
  actor.send({ type: "removal.undone", kind: "trial", id: TRIAL });
  assert.deepEqual((await list(actor)).map((e) => e.id), [ID], "the window and an Undo change nothing");
  actor.send({ type: "removal.settled", kind: "trial", id: TRIAL });
  await flush();
  assert.deepEqual(api.asked, ["evaluators"]);
  assert.deepEqual((await list(actor)).map((e) => [e.name, e.book, e.on]), [["Clear goal", JOURNAL, true]]);
  clock.increment(SYNC_IDLE_MS);
  await flush();
  assert.deepEqual(
    api.puts.map((p) => [p.name, Boolean(p.deleted)]).sort(),
    [["", true], ["Clear goal", false]],
    "the old one is uploaded as deleted and the copy as new",
  );
});

test("Start over means nothing off a try page", async () => {
  const store = fakeStore([{ id: ID, book: BOOK, name: "Mine", on: true, questions: [], version: 1 }]);
  const api = fakeApi([STARTER]);
  const { actor } = start(store, { api, ask: askAs("guest-1") });
  await flush();
  actor.send({ type: "removal.settled", kind: "trial", id: TRIAL });
  await flush();
  assert.deepEqual(api.asked, []);
  assert.deepEqual((await list(actor)).map((e) => e.name), ["Mine"]);
});
