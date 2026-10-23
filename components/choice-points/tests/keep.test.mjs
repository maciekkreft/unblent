import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The keep variant of changing who the browser belongs to (12, the clients' path of the
// connected Mac, 3.4): on session.changed with `leaving` and `keep` the fact uploads its
// outbox and keeps its copy, marked `adopt` with the account it came from; after the
// reload as the account, the mark sends the copy on the versions it holds and the pull
// starts again from 0, and the mark is cleared. Plain leaving still empties. The store,
// the api and the asks are fakes of the shapes fact.js builds; every unknown store read
// answers empty.
const LIVE = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", day: "2026-10-01", situation: "S", thoughts: "", away: "", towards: "", version: 3 };
const GONE = { id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", day: "2026-10-01", situation: "Gone", thoughts: "", away: "", towards: "", version: 2, deleted: true };

const flush = async (n = 40) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore(meta0) {
  const meta = new Map(Object.entries(meta0));
  const outbox = new Map();
  const queued = [];
  const log = [];
  const known = {
    all: async () => [LIVE, GONE],
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => {
      queued.push(r);
      outbox.set(r.table ? r.key : r.id, r);
    },
    outboxDelete: async (k) => void outbox.delete(k),
    metaGet: async (key) => meta.get(key),
    metaPut: async (key, value) => void meta.set(key, value),
    empty: async () => {
      log.push("empty");
      outbox.clear();
    },
  };
  const store = new Proxy(known, {
    get: (target, key) =>
      key === "then" ? undefined : target[key] ?? (async () => (String(key).endsWith("All") || key === "all" ? [] : undefined)),
  });
  return { store, meta, queued, log };
}

// Any answer the fact reads is empty: no field that is a list holds anything.
const empty = () => new Proxy({}, { get: (_, key) => (key === "cursor" ? 0 : key === "then" || key === "error" ? undefined : []) });

function fakeApi(answer) {
  const calls = [];
  const api = new Proxy({}, {
    get: (_, name) =>
      name === "then"
        ? undefined
        : async (...args) => {
            calls.push([name, ...args]);
            return answer(name, ...args);
          },
  });
  return { api, calls };
}

// A write is acknowledged with the next version; a pull brings nothing.
const acked = (name, row) => (name === "pull" ? empty() : { ...row, version: (row?.baseVersion ?? 0) + 1, updatedAt: 900 });

function start(meta, userId = "u1", answer = acked) {
  const { store, meta: held, queued, log } = fakeStore(meta);
  const { api, calls } = fakeApi(answer);
  const ask = async (target) => (target === "session" ? { userId, registrationOpen: false } : empty());
  const actor = createActor(machine, { input: { store, api, ask, now: () => 1000, revoke: () => {}, mint: () => "01ARZ3NDEKTSV4RRFFQ69G5FB9" } });
  const emitted = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  return { actor, meta: held, queued, log, calls, emitted };
}

const session = (extra = {}) => ({ type: "session.changed", userId: "u1", registrationOpen: false, ...extra });

test("keep keeps the copy and marks it with the account it came from", async () => {
  const { actor, meta, log } = start({ userId: "u1" });
  await flush();
  actor.send(session({ leaving: true, keep: true }));
  await flush();
  assert.deepEqual(log, [], "nothing is emptied");
  assert.equal(meta.get("adopt"), "u1");
  actor.stop();
});

test("a keep called off clears its mark", async () => {
  const { actor, meta, log } = start({ userId: "u1" });
  await flush();
  actor.send(session({ leaving: true, keep: true }));
  await flush();
  actor.send(session());
  await flush();
  assert.deepEqual(log, []);
  assert.equal(meta.get("adopt"), null);
  actor.stop();
});

test("plain leaving still empties the copy and leaves no mark", async () => {
  const { actor, meta, log } = start({ userId: "u1" });
  await flush();
  actor.send(session({ leaving: true }));
  await flush();
  assert.deepEqual(log, ["empty"]);
  assert.equal(meta.get("adopt"), undefined);
  actor.stop();
});

test("after the reload the mark sends the copy from a cursor of 0, then clears", async () => {
  const { actor, meta, queued, log, calls } = start({ userId: "u0", adopt: "u0", cursor: 7 }, "u1");
  await flush();
  assert.deepEqual(log, [], "the copy is kept, not emptied as another account's");
  const sent = queued.map((r) => r.table ? r.key : r.id);
  assert.ok(sent.includes("01ARZ3NDEKTSV4RRFFQ69G5FAV"), `sent: ${sent}`);
  assert.equal(queued.find((r) => (r.table ? r.key : r.id) === "01ARZ3NDEKTSV4RRFFQ69G5FAV").baseVersion, 3, "on the version it holds");
  assert.ok(!sent.includes("01ARZ3NDEKTSV4RRFFQ69G5FB0"), "a tombstone is not sent");
  assert.equal(meta.get("adopt"), null);
  assert.equal(meta.get("userId"), "u1");
  const pulls = calls.filter(([name]) => name === "pull");
  assert.ok(pulls.length > 0 && pulls.every(([, since]) => since === 0), `pulled from 0: ${JSON.stringify(pulls)}`);
  actor.stop();
});

test("a mark naming the account still signed in is only cleared", async () => {
  const { actor, meta, queued } = start({ userId: "u1", adopt: "u1", cursor: 7 }, "u1");
  await flush();
  assert.equal(meta.get("adopt"), null);
  assert.ok(!queued.some((r) => ["01ARZ3NDEKTSV4RRFFQ69G5FAV"].includes(r.table ? r.key : r.id)), "nothing is sent again");
  actor.stop();
});
