import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// Changing who the browser belongs to (12): on session.changed with `leaving` the fact
// uploads what its outbox holds and only then empties its local copy, outbox and cache
// together; when nothing can be uploaded (offline) it keeps everything, and news without
// `leaving` ends it. With `keep` it keeps its copy, marked `adopt` with the account it
// came from, and after the reload as the account the mark sends the copy on the versions
// it holds, pulling again from 0. The store, the api and the asks are fakes of the shapes
// fact.js builds.
const KEPT = { day: "2026-10-01", values: [{ id: "01ARZ3NDEKTSV4RRFFQ69G5VA1", name: "Health", meaning: "" }], version: 3 };
const ROW = { day: "2026-10-01", values: KEPT.values, baseVersion: 1 };

const flush = async (n = 40) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore({ rows = [], meta: meta0 = {} } = {}) {
  const outbox = new Map(rows.map((r) => [r.day, r]));
  const meta = new Map(Object.entries(meta0));
  const queued = [];
  const log = [];
  const store = {
    all: async () => [KEPT],
    put: async () => {},
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => {
      queued.push(r);
      outbox.set(r.day, r);
    },
    outboxDelete: async (k) => void outbox.delete(k),
    metaGet: async (key) => meta.get(key),
    metaPut: async (key, value) => void meta.set(key, value),
    empty: async () => {
      log.push("empty");
      outbox.clear();
    },
  };
  return { store, outbox, meta, queued, log };
}

function fakeApi({ offline = false } = {}) {
  const calls = [];
  const api = {
    put: async (row) => {
      calls.push(["put", row]);
      if (offline) throw new Error("offline");
      return { day: row.day, values: row.values, version: (row.baseVersion ?? 0) + 1 };
    },
    pull: async (since) => {
      calls.push(["pull", since]);
      if (offline) throw new Error("offline");
      return { versions: [], cursor: since };
    },
  };
  return { api, calls };
}

function start(storeOptions, apiOptions, userId = "u1") {
  const { store, outbox, meta, queued, log } = fakeStore(storeOptions);
  const { api, calls } = fakeApi(apiOptions);
  const ask = async () => ({ userId, registrationOpen: false });
  const actor = createActor(machine, { input: { store, api, ask, now: () => 1000 } });
  actor.start();
  return { actor, outbox, meta, queued, log, calls };
}

const session = (extra = {}) => ({ type: "session.changed", userId: "u1", registrationOpen: false, ...extra });

test("leaving with nothing to upload empties the local copy at once, without a pull", async () => {
  const { actor, log, calls } = start({ meta: { userId: "u1" } });
  await flush();
  const before = calls.length;
  actor.send(session({ leaving: true }));
  await flush();
  assert.deepEqual(log, ["empty"]);
  assert.ok(!calls.slice(before).some(([name]) => name === "pull"), "no pull while leaving");
  actor.stop();
});

test("leaving uploads the outbox first, then empties", async () => {
  const { actor, log, calls } = start({ rows: [ROW], meta: { userId: "u1" } });
  actor.send(session({ leaving: true }));
  await flush();
  assert.ok(calls.some(([name, row]) => name === "put" && row.day === ROW.day));
  assert.deepEqual(log, ["empty"]);
  actor.stop();
});

test("offline, leaving keeps the outbox and the copy; news without leaving ends it", async () => {
  const { actor, outbox, log } = start({ rows: [ROW], meta: { userId: "u1" } }, { offline: true });
  await flush();
  actor.send(session({ leaving: true }));
  await flush();
  assert.deepEqual(log, [], "nothing is emptied while a row is not uploaded");
  assert.equal(outbox.size, 1);
  actor.send(session());
  await flush();
  assert.equal(actor.getSnapshot().context.leaving, false);
  assert.deepEqual(log, []);
  actor.stop();
});

test("a copy kept for another account is emptied when the fact starts; its own, or one still to upload, is kept", async () => {
  const other = start({ meta: { userId: "u0" } });
  await flush();
  assert.deepEqual(other.log, ["empty"]);
  other.actor.stop();
  for (const options of [{ meta: { userId: "u1" } }, {}, { rows: [ROW], meta: { userId: "u0" } }]) {
    const { actor, log } = start(options, { offline: true });
    await flush();
    assert.deepEqual(log, [], JSON.stringify(options));
    actor.stop();
  }
});

test("keep keeps the copy and marks it; a keep called off clears its mark", async () => {
  const { actor, meta, log } = start({ meta: { userId: "u1" } });
  await flush();
  actor.send(session({ leaving: true, keep: true }));
  await flush();
  assert.deepEqual(log, [], "nothing is emptied");
  assert.equal(meta.get("adopt"), "u1");
  actor.send(session());
  await flush();
  assert.equal(meta.get("adopt"), null);
  actor.stop();
});

test("after the reload the mark sends the copy from a cursor of 0, then clears", async () => {
  const { actor, meta, queued, log, calls } = start({ meta: { userId: "u0", adopt: "u0", cursor: 7 } }, {}, "u1");
  await flush();
  assert.deepEqual(log, [], "the copy is kept, not emptied as another account's");
  assert.deepEqual(queued.map((r) => [r.day, r.baseVersion]), [["2026-10-01", 3]], "on the version it holds");
  assert.equal(meta.get("adopt"), null);
  assert.equal(meta.get("userId"), "u1");
  const pulls = calls.filter(([name]) => name === "pull");
  assert.ok(pulls.length > 0 && pulls.every(([, since]) => since === 0), JSON.stringify(pulls));
  actor.stop();
});
