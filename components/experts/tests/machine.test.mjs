import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for. Every announcement and reply is checked against its
// schema.
const SYNC_IDLE_MS = 2000;
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const BOOK2 = "01ARZ3NDEKTSV4RRFFQ69G5BK2";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/expert.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");
const editedSchema = new Validator(schema("../../expert-settings/events/expert.edited.json"), "2020-12");

const edited = (over = {}) => {
  const event = { id: BOOK, ...over };
  assert.ok(editedSchema.validate(event).valid, JSON.stringify(event));
  return { type: "expert.edited", ...event };
};

const flush = async (n = 8) => {
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
  };
}

const askUser = (userId) => () => Promise.resolve({ userId, registrationOpen: false });

// The server as a fake: last write wins, versions assigned here.
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
      const { baseVersion, ...rest } = row;
      const r = { ...rest, version: held ? held.version + 1 : (baseVersion || 0) + 1 };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => {
      pulls.push(since);
      return pull ? pull(since) : { experts: [], cursor: since };
    },
  };
}

function start(store, { api, ask } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask }, clock });
  const experts = [];
  actor.on("expert.changed", (e) => {
    assert.ok(changedSchema.validate({ expert: e.expert }).valid, JSON.stringify(e));
    experts.push(e.expert);
  });
  actor.start();
  return { actor, experts, clock };
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
    return r.experts;
  });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Signed out ------------------------------------------------------------------------

test("with nothing stored, list answers no experts", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  assert.deepEqual(await list(actor), []);
});

test("an edit carries only the fields changed, is kept and announced, and the same fields are no change", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, experts } = start(store, { api });
  await ready(actor);
  actor.send(edited({ prompt: "Speak as Marcus Aurelius." }));
  actor.send(edited({ on: true }));
  assert.deepEqual(experts, [
    { id: BOOK, prompt: "Speak as Marcus Aurelius.", on: false, version: 1 },
    { id: BOOK, prompt: "Speak as Marcus Aurelius.", on: true, version: 2 },
  ]);
  actor.send(edited({ on: true }));
  actor.send(edited({ left: true }));
  assert.equal(experts.length, 2, "nothing changed");
  assert.equal(store.rows.get(BOOK).on, true, "cached");
  assert.deepEqual((await list(actor)).map((e) => e.id), [BOOK]);
  assert.equal(api.puts.length, 0, "signed out never calls the api");
});

test("an expert without a prompt is not switched on; one emptied later keeps its switch", async () => {
  const { actor, experts } = start(fakeStore());
  await ready(actor);
  actor.send(edited({ on: true }));
  actor.send(edited({ prompt: "   ", on: true }));
  assert.deepEqual(experts.map((e) => [e.prompt, e.on]), [["   ", false]]);
  actor.send(edited({ id: BOOK2, prompt: "Stoic", on: true }));
  actor.send(edited({ id: BOOK2, prompt: "" }));
  assert.deepEqual(experts.slice(1).map((e) => [e.prompt, e.on]), [["Stoic", true], ["", true]]);
});

test("an edit or a query that lands while the store loads waits for it", async () => {
  let release;
  const store = fakeStore([{ id: BOOK, prompt: "Kept", on: true, version: 3 }]);
  const all = store.all;
  const gate = new Promise((r) => (release = r));
  store.all = () => gate.then(() => all());
  const { actor, experts } = start(store);
  actor.send(edited({ on: false }));
  const answer = list(actor);
  release();
  await ready(actor);
  assert.deepEqual(experts, [{ id: BOOK, prompt: "Kept", on: false, version: 4 }]);
  assert.equal((await answer)[0].on, false);
});

test("a store that rejects fails the fact: list answers nothing", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no idb"));
  const { actor } = start(store);
  const answer = list(actor);
  await flush();
  assert.deepEqual(await answer, []);
});

// --- Signed in -------------------------------------------------------------------------

test("signed in: an edit waits out the idle window, then is acknowledged with the server's version", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, experts, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ prompt: "One" }));
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(edited({ prompt: "Two" }));
  assert.equal(store.outbox.get(BOOK).baseVersion, null, "a new expert has no base");
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual(api.puts[0], { id: BOOK, prompt: "Two", on: false, baseVersion: null });
  assert.deepEqual([experts.at(-1).prompt, experts.at(-1).version], ["Two", 1]);
  assert.equal(store.outbox.size, 0);
});

test("signed in but offline: the row stays and is sent at the next focus", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const put = api.put;
  let offline = true;
  api.put = (row) => (offline ? Promise.reject(new Error("offline")) : put(row));
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ prompt: "P" }));
  await drain(clock);
  assert.equal(store.outbox.size, 1);
  offline = false;
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(store.outbox.size, 0);
});

test("signed in: a 401 drops the session and keeps the change", async () => {
  const store = fakeStore();
  const api = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ experts: [], cursor: since }) };
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ prompt: "P" }));
  await drain(clock);
  assert.equal(store.meta.get("userId"), null);
  assert.equal(store.outbox.size, 1);
});

test("signed in: a pull adopts newer experts, announces them and advances the cursor", async () => {
  const store = fakeStore([{ id: BOOK2, prompt: "Newer here", on: false, version: 4 }]);
  const remote = { id: BOOK, prompt: "From the phone", on: true, version: 2 };
  const older = { id: BOOK2, prompt: "Older", on: true, version: 3 };
  const api = fakeApi({ pull: () => ({ experts: [remote, older], cursor: 7 }) });
  const { actor, experts } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual(experts, [remote]);
  assert.deepEqual((await list(actor)).map((e) => e.prompt), ["From the phone", "Newer here"]);
  assert.equal(store.meta.get("cursor"), 7);
});

test("a local change not yet sent wins over a pulled one", async () => {
  const store = fakeStore();
  const remote = { id: BOOK, prompt: "Remote", on: true, version: 5 };
  let first = true;
  const api = fakeApi({ pull: (since) => (first ? ((first = false), { experts: [], cursor: since }) : { experts: [remote], cursor: 2 }) });
  api.put = () => Promise.reject(new Error("offline"));
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ prompt: "Local" }));
  await drain(clock);
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await list(actor))[0].prompt, "Local");
});

test("sign-in uploads what was written signed out, with its history", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, experts } = start(store, { api });
  await ready(actor);
  actor.send(edited({ prompt: "One" }));
  actor.send(edited({ prompt: "Two" }));
  actor.send(edited({ id: BOOK2, prompt: "Other" }));
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(api.puts.map((p) => [p.id, p.baseVersion]), [
    [BOOK, 2],
    [BOOK2, 1],
  ]);
  assert.equal(api.server.get(BOOK).version, 3, "the server continues from the version minted signed out");
  assert.equal(experts.at(-1).version, 2);
  assert.equal(store.outbox.size, 0);
  assert.equal(store.meta.get("userId"), "u1");
});
