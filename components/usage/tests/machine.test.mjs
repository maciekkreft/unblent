import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, dayOf } from "../machine.js";

// The decisions of usage against fakes of the inputs fact.js builds: an in-memory
// store, an api that logs every call, the asks to settings and session, and a
// SimulatedClock for the pause before a drain. Trace records are sent by hand, as the
// trace would announce them (trace.recorded).
const DEVICE = "01ARZ3NDEKTSV4RRFFQ69G5DEV";
const TAB = "tab-own";
const MIN = 60 * 1000;
const T0 = new Date(2026, 10, 3, 10, 0, 0).getTime();
const DAY = dayOf(T0);

const flush = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function memoryStore({ meta = {}, totals = [], outbox = [] } = {}) {
  const t = new Map(totals.map((r) => [r.id, r]));
  const o = new Map(outbox.map((r) => [r.id, r]));
  const m = new Map(Object.entries({ device: DEVICE, ...meta }));
  const log = [];
  return {
    t,
    o,
    m,
    log,
    all: async () => [...t.values()],
    put: async (r) => void t.set(r.id, r),
    outboxAll: async () => [...o.values()],
    outboxPut: async (r) => void o.set(r.id, r),
    outboxDelete: async (id) => void o.delete(id),
    metaGet: async (k) => m.get(k),
    metaPut: async (k, v) => void m.set(k, v),
    empty: async () => {
      log.push("empty");
      t.clear();
      o.clear();
      m.clear();
    },
  };
}

function fakeApi({ offline = false, summary = { days: [], accounts: 1 } } = {}) {
  const calls = [];
  const api = {
    offline,
    put: async (rows) => {
      calls.push(["put", rows.map((r) => ({ ...r }))]);
      if (api.offline) throw new Error("offline");
      return { stored: rows.length };
    },
    summary: async (who) => {
      calls.push(["summary", who]);
      if (api.offline) throw new Error("offline");
      return summary;
    },
  };
  return { api, calls };
}

function start({ store = memoryStore(), apiOptions, user = "u1", counting = true, own = true } = {}) {
  const { api, calls } = fakeApi(apiOptions);
  const clock = new SimulatedClock();
  const ask = async (target) => (target === "session" ? { userId: user } : { usageCounting: counting });
  const actor = createActor(machine, { input: { store, api, ask, now: () => T0, mint: () => "01ARZ3NDEKTSV4RRFFQ69G5NEW" }, clock });
  actor.start();
  // The trace record of this fact's own settings ask, which tells it its tab.
  if (own) actor.send(record({ kind: "query", name: "read", from: "usage", fromKind: "fact", to: ["settings"], outcome: "asked" }));
  return { actor, store, api, calls, clock };
}

let seq = 0;
function record(fields) {
  return {
    type: "trace.recorded",
    seq: seq++,
    at: T0,
    tab: TAB,
    kind: "event",
    name: "note.saved",
    from: "note-editor",
    fromKind: "view",
    to: [],
    ignored: [],
    outcome: "delivered",
    reason: null,
    cid: null,
    payload: {},
    ...fields,
  };
}
const act = (at, fields = {}) => record({ at, ...fields });
const ms = (store, feature, day = DAY) => store.t.get(`${DEVICE}:${day}:${feature}`)?.ms ?? 0;
const puts = (calls) => calls.filter(([kind]) => kind === "put");

test("the time between two actions goes to the first one's feature, and a pause over two minutes is not counted", async () => {
  const { actor, store } = start();
  await flush();
  assert.equal(actor.getSnapshot().context.tab, TAB);
  actor.send(act(T0, { name: "day.saved", from: "journal-entry" }));
  actor.send(act(T0 + MIN, { name: "note.saved", from: "note-editor#stage" }));
  actor.send(act(T0 + 2 * MIN, { name: "note.saved", from: "book-reader" }));
  actor.send(act(T0 + 6 * MIN, { name: "turn.submitted", from: "chat-input" }));
  actor.send(act(T0 + 6.5 * MIN, { name: "never.heard", from: "some-view" }));
  actor.send(act(T0 + 7 * MIN, { name: "day.saved", from: "journal-entry" }));
  await flush();
  assert.equal(ms(store, "journal"), MIN);
  assert.equal(ms(store, "notes"), MIN, "note.saved from the note editor counts as Notes");
  assert.equal(ms(store, "highlights"), 0, "the four minutes after the highlight are a pause");
  assert.equal(ms(store, "chats"), MIN / 2);
  assert.equal(ms(store, "other"), MIN / 2, "an action no one classed counts as Other");
  actor.stop();
});

test("note.saved from the reader counts as Highlights; facts, queries, refusals and other tabs do not count", async () => {
  const { actor, store } = start();
  await flush();
  actor.send(act(T0, { name: "note.saved", from: "book-reader" }));
  actor.send(act(T0 + 10_000, { name: "note.changed", from: "notes", fromKind: "fact" }));
  actor.send(act(T0 + 20_000, { tab: "tab-other", name: "day.saved", from: "journal-entry" }));
  actor.send(act(T0 + 30_000, { name: "day.saved", from: "journal-entry", outcome: "refused" }));
  actor.send(act(T0 + 40_000, { kind: "query", name: "list", from: "note-list" }));
  actor.send(act(T0 + 50_000, { name: "day.saved", from: "journal-entry" }));
  await flush();
  assert.equal(ms(store, "highlights"), 50_000);
  assert.equal(ms(store, "journal"), 0);
  actor.stop();
});

test("a stretch across local midnight counts on both days", async () => {
  const { actor, store } = start();
  await flush();
  const late = new Date(2026, 10, 3, 23, 59, 30).getTime();
  actor.send(act(late, { name: "book.progressed", from: "book-reader" }));
  actor.send(act(late + MIN, { name: "book.progressed", from: "book-reader" }));
  await flush();
  assert.equal(ms(store, "reading", "2026-11-03"), 30_000);
  assert.equal(ms(store, "reading", "2026-11-04"), 30_000);
  actor.stop();
});

test("nothing is counted while Share usage statistics is off, and turning it on starts afresh", async () => {
  const { actor, store } = start({ counting: false });
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  assert.equal(store.t.size, 0);
  actor.send({ type: "settings.changed", usageCounting: true });
  actor.send(act(T0 + 20_000));
  actor.send(act(T0 + 30_000));
  actor.send({ type: "settings.changed", usageCounting: false });
  actor.send(act(T0 + 40_000));
  actor.send({ type: "settings.changed", usageCounting: true });
  actor.send(act(T0 + 50_000));
  await flush();
  assert.equal(ms(store, "notes"), 10_000, "only the stretch while it was on, not across the switch");
  actor.stop();
});

test("signed out, nothing is counted or sent", async () => {
  const { actor, store, calls, clock } = start({ user: null });
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  clock.increment(61_000);
  await flush();
  assert.equal(store.t.size, 0);
  assert.deepEqual(calls, []);
  actor.stop();
});

test("an idle tab never contacts the server; a minute after the last action the totals are sent once", async () => {
  const { actor, calls, clock, store } = start();
  await flush();
  actor.send({ type: "_sync" });
  clock.increment(120_000);
  await flush();
  assert.deepEqual(calls, [], "nothing to send, so no call, even on focus");
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  actor.send(act(T0 + 20_000));
  clock.increment(59_000);
  await flush();
  assert.equal(puts(calls).length, 0, "the pause is not over yet");
  clock.increment(2_000);
  await flush();
  assert.equal(puts(calls).length, 1);
  assert.deepEqual(puts(calls)[0][1], [{ id: `${DEVICE}:${DAY}:notes`, device: DEVICE, day: DAY, feature: "notes", ms: 20_000 }]);
  assert.equal(store.o.size, 0, "the acknowledged total leaves the outbox");
  actor.send({ type: "_sync" });
  clock.increment(120_000);
  await flush();
  assert.equal(puts(calls).length, 1, "and with the outbox empty nothing more is sent");
  actor.stop();
});

test("a hidden tab sends at once", async () => {
  const { actor, calls } = start();
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  actor.send({ type: "_sync" });
  await flush();
  assert.equal(puts(calls).length, 1);
  actor.stop();
});

test("offline, time is counted and kept, then sent when the device is back", async () => {
  const { actor, calls, clock, store, api } = start({ apiOptions: { offline: true } });
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  clock.increment(61_000);
  await flush();
  assert.equal(store.o.size, 1, "the total waits in the outbox");
  api.offline = false;
  actor.send({ type: "_sync" });
  await flush();
  assert.equal(puts(calls).length, 2);
  assert.equal(puts(calls)[1][1][0].ms, 10_000);
  assert.equal(store.o.size, 0);
  actor.stop();
});

test("totals left from the last visit are sent on load", async () => {
  const row = { id: `${DEVICE}:${DAY}:notes`, device: DEVICE, day: DAY, feature: "notes", ms: 5000 };
  const { actor, calls } = start({ store: memoryStore({ meta: { userId: "u1" }, totals: [row], outbox: [row] }) });
  await flush();
  assert.deepEqual(puts(calls).map(([, rows]) => rows), [[row]]);
  actor.stop();
});

test("leaving sends what is left, then empties the local copy; with nothing left it empties without a call", async () => {
  const { actor, calls, store } = start();
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  actor.send({ type: "session.changed", userId: "u1", leaving: true });
  await flush();
  assert.equal(puts(calls).length, 1);
  assert.deepEqual(store.log, ["empty"]);
  actor.send(act(T0 + 20_000));
  await flush();
  assert.equal(store.o.size, 0, "nothing is counted while the browser changes account");
  actor.stop();

  const idle = start();
  await flush();
  idle.actor.send({ type: "session.changed", userId: "u1", leaving: true });
  await flush();
  assert.deepEqual(idle.store.log, ["empty"]);
  assert.deepEqual(idle.calls, []);
  idle.actor.stop();
});

test("offline, leaving keeps everything; news without leaving ends it and counting goes on", async () => {
  const { actor, store } = start({ apiOptions: { offline: true } });
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  actor.send({ type: "session.changed", userId: "u1", leaving: true });
  await flush();
  assert.deepEqual(store.log, []);
  assert.equal(store.o.size, 1);
  actor.send({ type: "session.changed", userId: "u1" });
  actor.send(act(T0 + 20_000));
  actor.send(act(T0 + 30_000));
  await flush();
  assert.equal(ms(store, "notes"), 20_000);
  actor.stop();
});

test("with keep the copy is sent and kept, marked for the account it came from", async () => {
  const { actor, calls, store } = start();
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  actor.send({ type: "session.changed", userId: "u1", leaving: true, keep: true });
  await flush();
  assert.equal(puts(calls).length, 1);
  assert.deepEqual(store.log, []);
  assert.equal(store.m.get("adopt"), "u1");
  assert.equal(ms(store, "notes"), 10_000);
  actor.stop();
});

test("after keep, an account with no usage receives the copy; one with usage starts this device afresh", async () => {
  const row = { id: `${DEVICE}:${DAY}:notes`, device: DEVICE, day: DAY, feature: "notes", ms: 5000 };
  const empty = start({ store: memoryStore({ meta: { userId: "u0", adopt: "u0" }, totals: [row] }) });
  await flush();
  assert.deepEqual(puts(empty.calls).map(([, rows]) => rows), [[row]]);
  assert.equal(empty.store.m.get("adopt"), null);
  empty.actor.stop();

  const held = { days: [{ day: DAY, feature: "chats", ms: 1 }], accounts: 1 };
  const busy = start({ store: memoryStore({ meta: { userId: "u0", adopt: "u0" }, totals: [row] }), apiOptions: { summary: held } });
  await flush();
  assert.deepEqual(busy.store.log, ["empty"]);
  assert.deepEqual(puts(busy.calls), []);
  assert.equal(busy.actor.getSnapshot().context.device, "01ARZ3NDEKTSV4RRFFQ69G5NEW");
  busy.actor.stop();
});

test("a copy counted for another account is emptied when the fact starts", async () => {
  const row = { id: `${DEVICE}:${DAY}:notes`, device: DEVICE, day: DAY, feature: "notes", ms: 5000 };
  const { actor, store, calls } = start({ store: memoryStore({ meta: { userId: "u0" }, totals: [row], outbox: [row] }) });
  await flush();
  assert.deepEqual(store.log, ["empty"]);
  assert.deepEqual(calls, []);
  actor.stop();
});

test("summary sends first, then answers the account's; offline it answers this device's own", async () => {
  const held = { days: [{ day: DAY, feature: "notes", ms: 99 }], accounts: 1 };
  const { actor, calls, api } = start({ apiOptions: { summary: held } });
  await flush();
  actor.send(act(T0));
  actor.send(act(T0 + 10_000));
  const answer = (who) =>
    new Promise((reply) => actor.send({ type: "summary?", cid: "c", payload: { who }, reply }));
  assert.deepEqual(await answer("you"), held);
  assert.deepEqual(calls.map(([kind]) => kind), ["put", "summary"], "the outbox drains before the account is asked");
  api.offline = true;
  actor.send(act(T0 + 20_000));
  assert.deepEqual(await answer("you"), { days: [{ day: DAY, feature: "notes", ms: 20_000 }], accounts: 1 });
  assert.deepEqual(await answer("all"), { error: "unavailable" });
  actor.stop();

  const out = start({ user: null });
  await flush();
  assert.deepEqual(await new Promise((reply) => out.actor.send({ type: "summary?", cid: "c", payload: { who: "you" }, reply })), { error: "signed-out" });
  assert.deepEqual(out.calls, []);
  out.actor.stop();
});

test("a record of another tab's usage, arriving after the probe closed, does not name this tab", async () => {
  const { actor } = start({ own: false });
  await flush();
  actor.send(record({ tab: "tab-other", kind: "query", name: "read", from: "usage", fromKind: "fact", to: ["settings"], outcome: "asked" }));
  await flush();
  assert.equal(actor.getSnapshot().context.tab, null);
  actor.stop();
});
