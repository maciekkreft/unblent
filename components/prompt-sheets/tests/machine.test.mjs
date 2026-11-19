import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for (prompt-sheets/machine.js).
const SYNC_IDLE_MS = 2000;

const DAY = "2026-10-14";
const DAY2 = "2026-10-13";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5PS1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5PS2";
const ID3 = "01ARZ3NDEKTSV4RRFFQ69G5PS3";
const SET = "01ARZ3NDEKTSV4RRFFQ69G5ST1";
const SET2 = "01ARZ3NDEKTSV4RRFFQ69G5ST2";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/prompt-sheet.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");
const readReply = new Validator(schema("../queries/read.json").reply, "2020-12");
const savedSchema = new Validator(schema("../../prompt-sheet/events/prompt-sheet.saved.json"), "2020-12");

const answers = (...texts) => texts.map((answer, i) => ({ prompt: `Prompt ${i + 1}?`, answer }));

const saved = (over = {}) => {
  const event = { type: "prompt-sheet.saved", id: ID, day: DAY, setId: SET, setName: "Evening review", basedOn: "Seneca, On Anger", answers: answers("A walk", ""), ...over };
  const { type, ...payload } = event;
  assert.ok(savedSchema.validate(payload).valid, JSON.stringify(payload));
  return event;
};

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
      return pull ? pull(since) : { sheets: [], cursor: since };
    },
  };
}

function start(store, { api, ask } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask }, clock });
  const changed = [];
  const deleted = [];
  actor.on("prompt-sheet.changed", (e) => {
    assert.ok(changedSchema.validate({ sheet: e.sheet }).valid, JSON.stringify(e));
    changed.push(e.sheet);
  });
  actor.on("prompt-sheet.deleted", (e) => deleted.push(e));
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
    return r;
  });
const read = (actor, id) =>
  new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: { id }, reply })).then((r) => {
    assert.ok(readReply.validate(r).valid, JSON.stringify(r));
    return r.sheet;
  });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Signed out ------------------------------------------------------------------------

test("signed out: a new sheet is version 1, announced whole with its answers not judged, and read by id", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved());
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0], {
    id: ID,
    day: DAY,
    setId: SET,
    setName: "Evening review",
    basedOn: "Seneca, On Anger",
    answers: [
      { prompt: "Prompt 1?", answer: "A walk", fits: null },
      { prompt: "Prompt 2?", answer: "", fits: null },
    ],
    createdAt: "2016-07-30T23:54:10.259Z",
    version: 1,
    pending: false,
  });
  assert.deepEqual(await read(actor, ID), changed[0]);
  assert.equal(await read(actor, ID2), null, "none with that id");
  assert.equal(store.rows.get(ID).version, 1, "cached");
  assert.equal(api.puts.length, 0, "signed out never calls the api");
});

test("list answers one day's, one set's or the newest sheets, newest first, with the total", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ id: ID, answers: answers("First") }));
  actor.send(saved({ id: ID2, setId: SET2, answers: answers("Second") }));
  actor.send(saved({ id: ID3, day: DAY2, answers: answers("Yesterday") }));
  const first = (r) => r.sheets.map((s) => s.answers[0].answer);
  assert.deepEqual(first(await list(actor)), ["Second", "First"]);
  assert.deepEqual(first(await list(actor, {})), ["Second", "First", "Yesterday"]);
  assert.deepEqual(first(await list(actor, { setId: SET })), ["First", "Yesterday"]);
  assert.deepEqual(first(await list(actor, { day: DAY, setId: SET })), ["First"]);
  assert.equal((await list(actor, {})).total, 3);
});

test("list holds at most 20 sheets and says how many match in all", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  for (let i = 0; i < 23; i += 1) actor.send(saved({ id: `01ARZ3NDEKTSV4RRFFQ69G5${String(i).padStart(3, "0")}`, answers: answers(`A${i}`) }));
  const r = await list(actor, {});
  assert.deepEqual([r.sheets.length, r.total], [20, 23]);
  assert.equal(r.sheets[0].answers[0].answer, "A22", "the sheet added last first");
});

test("a new sheet with no answer text, without a day or a set, or deleted, is not kept", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved({ answers: answers("", "") }));
  actor.send(saved({ answers: answers(" ", "\n\n") }));
  actor.send(saved({ answers: [] }));
  actor.send({ ...saved(), day: "today" });
  actor.send({ ...saved(), setId: "none" });
  actor.send(saved({ deleted: true }));
  assert.equal(changed.length, 0);
  actor.send(saved({ answers: answers("", "Breathe") }));
  assert.equal(changed.length, 1);
});

test("a save changes the set's name and the answers, keeps the day, mints the next version, and the same is no change", async () => {
  const { actor, changed } = start(fakeStore());
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ day: DAY2, setName: "Review", answers: answers("A walk", "Less phone") }));
  const last = changed.at(-1);
  assert.deepEqual([last.day, last.setName, last.answers[1].answer, last.version], [DAY, "Review", "Less phone", 2]);
  actor.send(saved({ setName: "Review", answers: answers("A walk", "Less phone") }));
  assert.equal(changed.length, 2);
});

test("a save that empties every answer, or says deleted, removes a kept sheet; its tombstone keeps the answers", async () => {
  const store = fakeStore();
  const { actor, changed, deleted } = start(store);
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ answers: answers("  ", "\n") }));
  assert.equal(changed.length, 1, "no change is announced, only the deletion");
  assert.deepEqual(deleted, [{ type: "prompt-sheet.deleted", id: ID, day: DAY }]);
  assert.deepEqual((await list(actor)).sheets, []);
  assert.equal(await read(actor, ID), null);
  const tomb = store.rows.get(ID);
  assert.deepEqual([tomb.deleted, tomb.answers[0].answer, tomb.version], [true, "A walk", 2]);
  actor.send(saved({ id: ID2 }));
  actor.send(saved({ id: ID2, deleted: true }));
  assert.equal(deleted.length, 2, "deleted removes it whatever it holds");
  actor.send(saved({ id: ID2, answers: answers("Back?") }));
  assert.equal(await read(actor, ID2), null, "a deleted id stays deleted");
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
  const one = read(actor, ID);
  release();
  await ready(actor);
  assert.equal(changed.length, 1);
  assert.equal((await answer).sheets.length, 1);
  assert.equal((await one).id, ID);
});

test("a store that rejects fails the fact, and the queries are answered empty", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no idb"));
  const { actor } = start(store);
  const answer = list(actor);
  await flush();
  assert.deepEqual(await answer, { sheets: [], total: 0 });
  assert.equal(await read(actor, ID), null);
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
  assert.deepEqual(Object.keys(api.puts[0]).sort(), ["answers", "baseVersion", "basedOn", "day", "id", "setId", "setName"]);
  assert.deepEqual(api.puts[0].answers[0], { prompt: "Prompt 1?", answer: "A walk", fits: null }, "fits rides the write");
  assert.deepEqual([changed.at(-1).pending, changed.at(-1).version], [false, 1]);
  assert.equal(store.outbox.size, 0);
});

test("signed in: edits within the window coalesce into one write", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ answers: answers("Two") }));
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(saved({ answers: answers("Three") }));
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual([api.puts[0].answers[0].answer, api.puts[0].baseVersion], ["Three", null]);
});

test("signed in but offline: the row stays and is sent at the next focus; a 401 drops the session", async () => {
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

  const gone = fakeStore();
  const refused = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ sheets: [], cursor: since }) };
  const other = start(gone, { api: refused, ask: askUser("u1") });
  await ready(other.actor);
  other.actor.send(saved());
  await drain(other.clock);
  assert.equal(gone.meta.get("userId"), null);
  assert.equal(gone.outbox.size, 1, "the change waits for the next sign-in");
});

test("signed in: a pull adopts newer records, a tombstone takes one away, and the cursor advances", async () => {
  const held = { id: ID2, day: DAY, setId: SET, setName: "Kept", basedOn: "", answers: answers("Kept"), version: 1 };
  const remote = { id: ID, day: DAY, setId: SET, setName: "From the phone", basedOn: "", answers: [{ prompt: "P?", answer: "Yes", fits: true }], version: 4, deleted: false };
  const api = fakeApi({ pull: () => ({ sheets: [remote, { ...held, version: 2, deleted: true }], cursor: 7 }) });
  const store = fakeStore([held]);
  const { actor, changed, deleted } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual([changed.at(-1).setName, changed.at(-1).version, changed.at(-1).answers[0].fits], ["From the phone", 4, true]);
  assert.deepEqual(deleted, [{ type: "prompt-sheet.deleted", id: ID2, day: DAY }]);
  assert.equal(store.meta.get("cursor"), 7);
});

test("sign-in uploads what was made signed out, with its history, tombstones included", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved());
  actor.send(saved({ answers: answers("A run") }));
  actor.send(saved({ id: ID2 }));
  actor.send(saved({ id: ID2, deleted: true }));
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
  assert.equal(store.meta.get("userId"), "u1");
});

test("leaving (12): what is left is uploaded, then the copy is emptied, or with keep marked to be added", async () => {
  for (const keep of [false, true]) {
    const store = fakeStore();
    let emptied = false;
    store.empty = () => ((emptied = true), Promise.resolve());
    const api = fakeApi();
    const { actor } = start(store, { api, ask: askUser("u1") });
    await ready(actor);
    actor.send(saved());
    actor.send({ type: "session.changed", userId: "u1", leaving: true, ...(keep ? { keep: true } : {}) });
    await flush();
    assert.equal(api.puts.length, 1, "uploaded at once");
    assert.equal(emptied, !keep);
    assert.equal(store.meta.get("adopt"), keep ? "u1" : undefined);
  }
});

test("keep (12): an account that holds no sheet receives this copy; one that holds a sheet replaces it", async () => {
  const mine = { id: ID, day: DAY, setId: SET, setName: "Mine", basedOn: "", answers: answers("Mine"), version: 2 };
  const empty = fakeStore([mine]);
  empty.meta.set("adopt", "mac");
  empty.meta.set("userId", "mac");
  const api = fakeApi();
  const { actor } = start(empty, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.puts.map((p) => [p.id, p.baseVersion]), [[ID, 2]], "sent on the version it holds");
  assert.equal(empty.meta.get("adopt"), null);

  const theirs = { ...mine, id: ID2, setName: "Theirs", version: 1, deleted: false };
  const full = fakeStore([mine]);
  full.meta.set("adopt", "mac");
  full.meta.set("userId", "mac");
  let emptied = false;
  full.empty = () => ((emptied = true), full.rows.clear(), Promise.resolve());
  const held = fakeApi({ pull: () => ({ sheets: [theirs], cursor: 1 }) });
  const other = start(full, { api: held, ask: askUser("u1") });
  await ready(other.actor);
  assert.ok(emptied);
  assert.deepEqual((await list(other.actor, {})).sheets.map((s) => s.setName), ["Theirs"]);
});
