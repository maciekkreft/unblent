import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock that is both the
// idle window the network waits for and the device's "today".
const SYNC_IDLE_MS = 2000;
const HOUR = 60 * 60 * 1000;

const A = "01ARZ3NDEKTSV4RRFFQ69G5VA1";
const B = "01ARZ3NDEKTSV4RRFFQ69G5VA2";
const parent = { id: A, name: "Being a present parent", meaning: "" };
const health = { id: B, name: "Health", meaning: "Moving every day" };

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/values.changed.json"), "2020-12");
const readReply = new Validator(schema("../queries/read.json").reply, "2020-12");
const versionsReply = new Validator(schema("../queries/versions.json").reply, "2020-12");

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

// Local noon of a day, so "today" is that day in any time zone the test runs in.
const noon = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
};

function fakeStore(initial = [], outboxRows = [], initialPlaces = []) {
  const rows = new Map(initial.map((r) => [r.day, r]));
  const outbox = new Map(outboxRows.map((r) => [r.day, r]));
  const meta = new Map();
  const places = new Map(initialPlaces.map((p) => [p.day, p]));
  return {
    rows,
    places,
    outbox,
    meta,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.day, r), Promise.resolve()),
    placesAll: () => Promise.resolve([...places.values()]),
    placePut: (p) => (places.set(p.day, p), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.day, r), Promise.resolve()),
    outboxDelete: (day) => (outbox.delete(day), Promise.resolve()),
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
      const held = server.get(row.day);
      const r = { day: row.day, values: row.values, version: held ? held.version + 1 : (row.baseVersion || 0) + 1 };
      server.set(row.day, r);
      return r;
    },
    places: new Map(),
    placeCalls: [],
    async place(row) {
      this.placeCalls.push(row);
      const held = this.places.get(row.day);
      const p = { day: row.day, placed: row.placed, version: held ? held.version + 1 : (row.baseVersion || 0) + 1 };
      this.places.set(row.day, p);
      return p;
    },
    pull: async (since) => {
      pulls.push(since);
      return pull ? pull(since) : { versions: [], cursor: since };
    },
  };
}

function start(store, { api, ask, day = "2026-10-14" } = {}) {
  const clock = new SimulatedClock();
  clock.set(noon(day));
  const actor = createActor(machine, { input: { store, api, ask, now: () => clock.now() }, clock });
  const changed = [];
  actor.on("values.changed", (e) => {
    const { type, ...payload } = e;
    assert.ok(changedSchema.validate(payload).valid, JSON.stringify(e));
    changed.push(payload);
  });
  actor.start();
  return { actor, changed, clock };
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

const read = (actor, payload = {}) =>
  new Promise((reply) => actor.send({ type: "read?", cid: "c", payload, reply })).then((r) => {
    assert.ok(readReply.validate(r).valid, JSON.stringify(r));
    return r;
  });
const versions = (actor) =>
  new Promise((reply) => actor.send({ type: "versions?", cid: "c", payload: {}, reply })).then((r) => {
    assert.ok(versionsReply.validate(r).valid, JSON.stringify(r));
    return r.days;
  });

const saved = (day, values) => ({ type: "values.saved", day, values });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Signed out ------------------------------------------------------------------------

test("with nothing written, read answers no day and no values, and there are no versions", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  assert.deepEqual(await read(actor), { day: null, values: [], changedSince: false });
  assert.deepEqual(await read(actor, { day: "2026-10-01" }), { day: null, values: [], changedSince: false, placed: false });
  assert.deepEqual(await versions(actor), []);
});

test("a save today writes today's version, announced and cached, and signed out never calls the api", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, changed } = start(store, { api });
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  assert.deepEqual(changed, [{ day: "2026-10-14", values: [parent], placed: true }]);
  assert.deepEqual(await read(actor), { day: "2026-10-14", values: [parent], changedSince: false });
  assert.deepEqual(store.rows.get("2026-10-14"), { day: "2026-10-14", values: [parent], version: 1 });
  assert.equal(api.puts.length, 0);
});

test("an edit today replaces today's version, minting the next version, and the same values are no change", async () => {
  const store = fakeStore();
  const { actor, changed } = start(store);
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  actor.send(saved("2026-10-14", [parent, health]));
  actor.send(saved("2026-10-14", [parent, health]));
  assert.equal(changed.length, 2);
  assert.deepEqual(await versions(actor), [], "one version per day, and the current one is not an earlier one");
  assert.equal(store.rows.get("2026-10-14").version, 2);
});

test("a save naming any day but today is ignored, also yesterday's in the hour after midnight", async () => {
  const { actor, changed, clock } = start(fakeStore(), { day: "2026-10-14" });
  await ready(actor);
  actor.send(saved("2026-10-13", [parent]));
  actor.send(saved("2026-10-15", [parent]));
  assert.equal(changed.length, 0);
  // From noon to half past midnight: the journal still lets yesterday's text be edited,
  // and its values stay as they were.
  clock.increment(12.5 * HOUR);
  actor.send(saved("2026-10-14", [parent]));
  assert.equal(changed.length, 0);
  actor.send(saved("2026-10-15", [parent]));
  assert.deepEqual(changed.map((c) => c.day), ["2026-10-15"]);
});

test("a save that leaves the values as they stand writes no version", async () => {
  const yesterday = { day: "2026-10-13", values: [parent], version: 1 };
  const { actor, changed } = start(fakeStore([yesterday]));
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  assert.equal(changed.length, 0, "the version in force already says this");
  actor.send(saved("2026-10-14", []));
  assert.deepEqual(changed, [{ day: "2026-10-14", values: [], placed: true }], "removing every value is a version");
});

test("read answers the latest version on or before a day, and whether the values changed after it", async () => {
  const kept = [
    { day: "2026-10-01", values: [parent], version: 1 },
    { day: "2026-10-05", values: [parent, health], version: 3 },
  ];
  const { actor } = start(fakeStore(kept));
  await ready(actor);
  assert.deepEqual(await read(actor, { day: "2026-09-30" }), { day: null, values: [], changedSince: true, placed: false });
  assert.deepEqual(await read(actor, { day: "2026-10-01" }), { day: "2026-10-01", values: [parent], changedSince: true, placed: true });
  assert.deepEqual(await read(actor, { day: "2026-10-04" }), { day: "2026-10-01", values: [parent], changedSince: true, placed: false });
  assert.deepEqual(await read(actor, { day: "2026-10-05" }), { day: "2026-10-05", values: [parent, health], changedSince: false, placed: true });
  assert.deepEqual(await read(actor), { day: "2026-10-05", values: [parent, health], changedSince: false });
  assert.deepEqual(await versions(actor), ["2026-10-01"]);
});

test("versions leaves out empty days, repeats, and days that read as the current values", async () => {
  const kept = [
    { day: "2026-10-01", values: [], version: 1 },
    { day: "2026-10-02", values: [parent], version: 1 },
    { day: "2026-10-03", values: [{ ...parent, id: B, name: " Being a present parent " }], version: 1 },
    { day: "2026-10-04", values: [health], version: 1 },
    { day: "2026-10-05", values: [], version: 1 },
    { day: "2026-10-06", values: [parent, health], version: 1 },
    { day: "2026-10-14", values: [{ ...health, meaning: "Moving every day " }], version: 1 },
  ];
  const { actor } = start(fakeStore(kept));
  await ready(actor);
  assert.deepEqual(await versions(actor), ["2026-10-02", "2026-10-06"], "the 3rd repeats the 2nd, the 4th reads as today's");
});

test("with only an empty past day and one that reads as today's, there are no earlier versions", async () => {
  const kept = [
    { day: "2026-10-12", values: [], version: 1 },
    { day: "2026-10-13", values: [parent], version: 1 },
    { day: "2026-10-14", values: [parent], version: 1 },
  ];
  const { actor } = start(fakeStore(kept));
  await ready(actor);
  assert.deepEqual(await versions(actor), []);
});

test("changed since is true only when the current values read differently from the shown day's", async () => {
  const kept = [
    { day: "2026-10-10", values: [parent], version: 1 },
    { day: "2026-10-12", values: [health], version: 1 },
    { day: "2026-10-14", values: [{ ...parent, id: B, meaning: " " }], version: 1 },
  ];
  const { actor } = start(fakeStore(kept));
  await ready(actor);
  assert.equal((await read(actor, { day: "2026-10-10" })).changedSince, false, "today reads as the 10th");
  assert.equal((await read(actor, { day: "2026-10-12" })).changedSince, true);
  assert.equal((await read(actor, { day: "2026-10-01" })).changedSince, true, "nothing then, values now");
});

test("an earlier day's version never changes when today's is written", async () => {
  const store = fakeStore([{ day: "2026-10-13", values: [parent, health], version: 2 }]);
  const { actor } = start(store);
  await ready(actor);
  actor.send(saved("2026-10-14", [health]));
  assert.deepEqual((await read(actor, { day: "2026-10-13" })).values, [parent, health]);
  assert.deepEqual((await read(actor)).values, [health]);
  assert.equal(store.rows.get("2026-10-13").version, 2);
});

test("a gesture or query that lands while the store loads waits for it", async () => {
  let release;
  const store = fakeStore();
  const all = store.all;
  const gate = new Promise((r) => (release = r));
  store.all = () => gate.then(() => all());
  const { actor, changed } = start(store);
  actor.send(saved("2026-10-14", [parent]));
  const answer = read(actor);
  release();
  await ready(actor);
  assert.equal(changed.length, 1);
  assert.deepEqual((await answer).values, [parent]);
});

test("a store that rejects fails the fact, and both queries are answered empty", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no idb"));
  const { actor } = start(store);
  const answer = read(actor);
  await flush();
  assert.deepEqual(await answer, { day: null, values: [], changedSince: false });
  assert.deepEqual(await versions(actor), []);
});

// --- Signed in -------------------------------------------------------------------------

test("signed in: a save waits out the idle window, then is acknowledged and drained", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  assert.equal(store.outbox.get("2026-10-14").baseVersion, null);
  assert.equal(api.puts.length, 0, "not before the window");
  await drain(clock);
  assert.deepEqual(api.puts, [{ day: "2026-10-14", values: [parent], baseVersion: null }]);
  assert.equal(store.outbox.size, 0);
  assert.equal(store.rows.get("2026-10-14").version, 1);
});

test("signed in: edits within the window coalesce into one write", async () => {
  const api = fakeApi();
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(saved("2026-10-14", [parent, health]));
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.deepEqual(api.puts.map((p) => p.values.length), [2]);
});

test("signed in but offline: the row stays and is sent at the next focus", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const put = api.put;
  let offline = true;
  api.put = (row) => (offline ? Promise.reject(new Error("offline")) : put(row));
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  await drain(clock);
  assert.equal(store.outbox.size, 1);
  offline = false;
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(store.outbox.size, 0);
});

test("signed in: a 401 drops the session and the change waits", async () => {
  const store = fakeStore();
  const api = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ versions: [], cursor: since }) };
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  await drain(clock);
  assert.equal(store.meta.get("userId"), null);
  assert.equal(store.outbox.size, 1);
});

test("signed in: a pull adopts newer versions from another device, announces them and advances the cursor", async () => {
  const store = fakeStore([{ day: "2026-10-13", values: [parent], version: 1 }]);
  const remote = [
    { day: "2026-10-13", values: [parent, health], version: 2 },
    { day: "2026-10-12", values: [health], version: 1 },
  ];
  const api = fakeApi({ pull: () => ({ versions: remote, cursor: 9 }) });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual(changed.map((c) => [c.day, c.values.length]), [["2026-10-13", 2], ["2026-10-12", 1]]);
  assert.deepEqual(await versions(actor), ["2026-10-12"]);
  assert.equal(store.meta.get("cursor"), 9);
});

test("signed in: today's change not yet sent wins over a pulled one", async () => {
  const api = fakeApi({ pull: (since) => ({ versions: since === 0 ? [] : [{ day: "2026-10-14", values: [health], version: 5 }], cursor: 2 }) });
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  api.put = () => Promise.reject(new Error("offline"));
  actor.send(saved("2026-10-14", [parent]));
  await drain(clock);
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.deepEqual((await read(actor)).values, [parent], "the later local write wins");
});

test("sign-in uploads every version written signed out, with its history", async () => {
  const store = fakeStore([{ day: "2026-10-10", values: [health], version: 1 }]);
  const api = fakeApi();
  const { actor } = start(store, { api });
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  actor.send(saved("2026-10-14", [parent, health]));
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(api.puts.map((p) => [p.day, p.baseVersion]), [["2026-10-10", 1], ["2026-10-14", 2]]);
  assert.equal(api.server.get("2026-10-14").version, 3, "the server continues from the version minted signed out");
  assert.equal(store.outbox.size, 0);
  assert.equal(store.meta.get("userId"), "u1");
});

// --- Whether a day shows Your values -----------------------------------------------------

const placed = (day, on) => ({ type: "values.placed", day, placed: on });

test("placing today adds Your values to the day, announced and cached; taking it off is the same", async () => {
  const store = fakeStore();
  const { actor, changed } = start(store);
  await ready(actor);
  assert.deepEqual(await read(actor, { day: "2026-10-14" }), { day: null, values: [], changedSince: false, placed: false });
  actor.send(placed("2026-10-14", true));
  assert.deepEqual(changed, [{ day: "2026-10-14", values: [], placed: true }]);
  assert.equal((await read(actor, { day: "2026-10-14" })).placed, true);
  assert.deepEqual(store.places.get("2026-10-14"), { day: "2026-10-14", placed: true, version: 1 });
  actor.send(placed("2026-10-14", true));
  assert.equal(changed.length, 1, "placing a day that shows it is no change");
  actor.send(placed("2026-10-14", false));
  assert.deepEqual(changed.at(-1), { day: "2026-10-14", values: [], placed: false });
  assert.equal(store.places.get("2026-10-14").version, 2);
  assert.equal("placed" in (await read(actor)), false, "the current values name no day");
});

test("placing any day but today is ignored", async () => {
  const { actor, changed, clock } = start(fakeStore());
  await ready(actor);
  actor.send(placed("2026-10-13", true));
  clock.set(noon("2026-10-15") - 11.5 * HOUR);
  actor.send(placed("2026-10-14", true));
  assert.deepEqual(changed, []);
});

test("a day with a version shows Your values until taken off; a day without one does not", async () => {
  const store = fakeStore([{ day: "2026-10-10", values: [health], version: 1 }]);
  const { actor, changed } = start(store);
  await ready(actor);
  assert.equal((await read(actor, { day: "2026-10-10" })).placed, true);
  assert.equal((await read(actor, { day: "2026-10-12" })).placed, false);
  actor.send(saved("2026-10-14", [parent]));
  assert.deepEqual(changed, [{ day: "2026-10-14", values: [parent], placed: true }]);
  actor.send(placed("2026-10-14", false));
  assert.deepEqual(changed.at(-1), { day: "2026-10-14", values: [parent], placed: false });
  actor.send(saved("2026-10-14", [parent, health]));
  assert.equal(changed.at(-1).placed, false, "a save does not put back what was taken off");
});

test("signed in: a placement waits out the window, is sent under its own key and drained", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(saved("2026-10-14", [parent]));
  actor.send(placed("2026-10-14", false));
  assert.deepEqual([...store.outbox.keys()].sort(), ["2026-10-14", "placed 2026-10-14"]);
  await drain(clock);
  assert.deepEqual(api.placeCalls, [{ day: "2026-10-14", placed: false, baseVersion: null }]);
  assert.equal(api.puts.length, 1);
  assert.equal(store.outbox.size, 0);
  assert.deepEqual(store.places.get("2026-10-14"), { day: "2026-10-14", placed: false, version: 1 });
});

test("signed in: a pulled placement is adopted and announced, unless a later version exists", async () => {
  const store = fakeStore([
    { day: "2026-10-12", values: [health], version: 1 },
    { day: "2026-10-13", values: [parent], version: 1 },
  ]);
  const days = [
    { day: "2026-10-14", placed: true, version: 1 },
    { day: "2026-10-12", placed: false, version: 2 },
  ];
  const api = fakeApi({ pull: () => ({ versions: [], days, cursor: 4 }) });
  const { actor, changed } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(changed, [{ day: "2026-10-14", values: [parent], placed: true }]);
  assert.equal((await read(actor, { day: "2026-10-12" })).placed, false, "adopted, though not announced");
  assert.equal(store.places.size, 2);
  assert.equal(store.meta.get("cursor"), 4);
});

test("signed in: a placement not yet sent wins over a pulled one", async () => {
  const api = fakeApi({ pull: (since) => ({ versions: [], days: since === 0 ? [] : [{ day: "2026-10-14", placed: false, version: 5 }], cursor: 2 }) });
  const { actor, clock } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  api.place = () => Promise.reject(new Error("offline"));
  actor.send(placed("2026-10-14", true));
  await drain(clock);
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await read(actor, { day: "2026-10-14" })).placed, true);
});

test("sign-in uploads every placement made signed out, with its history", async () => {
  const store = fakeStore([], [], [{ day: "2026-10-11", placed: true, version: 2 }]);
  const api = fakeApi();
  const { actor } = start(store, { api });
  await ready(actor);
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(api.placeCalls, [{ day: "2026-10-11", placed: true, baseVersion: 2 }]);
  assert.equal(api.places.get("2026-10-11").version, 3);
  assert.equal(store.outbox.size, 0);
});
