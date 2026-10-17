import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// Changing who the browser belongs to (12): on session.changed with `leaving` the
// fact uploads what its outbox holds and only then empties its local copy, outbox and
// cache together; when nothing can be uploaded (offline) it keeps everything, and news
// without `leaving` ends it. The store, the api and the asks are fakes of the shapes
// fact.js builds; every unknown store read answers empty.
const ROW = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", baseVersion: 1 };

const flush = async (n = 30) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore(rows = []) {
  const outbox = new Map(rows.map((r) => [r.key ?? r.id, r]));
  const log = [];
  const known = {
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.key ?? r.id, r),
    outboxDelete: async (k) => void outbox.delete(k),
    metaGet: async () => undefined,
    empty: async () => {
      log.push("empty");
      outbox.clear();
    },
  };
  const store = new Proxy(known, {
    get: (target, key) =>
      key === "then" ? undefined : target[key] ?? (async () => (String(key).endsWith("All") || key === "all" ? [] : undefined)),
  });
  return { store, outbox, log };
}

// Any answer the fact reads is empty: no field that is a list holds anything.
const empty = () => new Proxy({}, { get: (_, key) => (key === "cursor" ? 0 : key === "then" || key === "error" ? undefined : []) });

function fakeApi({ offline = false } = {}) {
  const calls = [];
  const api = new Proxy({}, {
    get: (_, name) =>
      name === "then"
        ? undefined
        : async (...args) => {
            calls.push(name);
            if (offline) throw new Error("offline");
            return name === "pull" ? empty() : { ...args[0], version: 2, updatedAt: 900 };
          },
  });
  return { api, calls };
}

const ask = async (target, name) => (target === "session" ? { userId: "u1", registrationOpen: false } : empty());

function start(rows, apiOptions) {
  const { store, outbox, log } = fakeStore(rows);
  const { api, calls } = fakeApi(apiOptions);
  const actor = createActor(machine, { input: { store, api, ask, now: () => 1000, revoke: () => {} } });
  actor.start();
  return { actor, outbox, log, calls };
}

const session = (extra = {}) => ({ type: "session.changed", userId: "u1", registrationOpen: false, ...extra });

test("leaving with nothing to upload empties the local copy at once, without a pull", async () => {
  const { actor, log, calls } = start([]);
  await flush();
  const before = calls.length;
  actor.send(session({ leaving: true }));
  await flush();
  assert.deepEqual(log, ["empty"]);
  assert.ok(!calls.slice(before).includes("pull"), `no pull while leaving: ${calls.slice(before)}`);
  actor.stop();
});

test("offline, leaving keeps the outbox and the copy; news without leaving ends it", async () => {
  const { actor, outbox, log } = start([ROW], { offline: true });
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
