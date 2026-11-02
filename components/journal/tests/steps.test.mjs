import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// journal as an owner of steps (12, Undo): what it records for a stretch of typing in
// today's page and for keeping one copy of a clashed day, and how it applies an Undo or
// Redo `undo` names to it.

const D1 = "01K7TEST00000000000000DA01";
const D2 = "01K7TEST00000000000000DA02";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const savedSchema = schema("../../journal-entry/events/day.saved.json");

const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore({ days = [], userId } = {}) {
  const tables = { days: new Map(days.map((r) => [r.id, r])) };
  const meta = new Map(userId === undefined ? [] : [["userId", userId]]);
  const outbox = new Map();
  return {
    tables,
    outbox,
    all: (t) => Promise.resolve([...tables[t].values()]),
    put: (t, r) => (tables[t].set(r.id, structuredClone(r)), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (row) => (outbox.set(row.key, row), Promise.resolve()),
    outboxDelete: (key) => (outbox.delete(key), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

// The server's rules for a day (journal/server): a stale base is a conflict, a delete
// always wins, and a restore write names the tombstone's own version.
function fakeServer() {
  const days = new Map();
  const puts = [];
  let seq = 0;
  const out = ({ seq: _, ...r }) => structuredClone(r);
  const set = (record, version, deleted = false) => {
    const r = { ...structuredClone(record), version, deleted, seq: ++seq };
    days.set(record.id, r);
    return out(r);
  };
  const api = {
    async put(row) {
      puts.push(structuredClone(row));
      const was = days.get(row.record.id);
      if (!was) return { record: set(row.record, (row.baseVersion ?? 0) + 1, Boolean(row.deleted)) };
      if (row.deleted) return { record: was.deleted ? out(was) : set(row.record, was.version + 1, true) };
      if (was.deleted) return row.baseVersion === was.version ? { record: set(row.record, was.version + 1) } : { conflict: true, record: out(was) };
      if (was.text === row.record.text && was.editedAt === row.record.editedAt) return { record: out(was) };
      if (row.baseVersion !== was.version) return { conflict: true, record: out(was) };
      return { record: set(row.record, was.version + 1) };
    },
    async pull(since) {
      return { days: [...days.values()].filter((r) => r.seq > since).map(out), cursor: seq };
    },
  };
  const other = (record) => set(record, (days.get(record.id)?.version ?? 0) + 1);
  return { api, puts, days, other };
}

const signedIn = (userId) => async (target, name) =>
  target === "session" && name === "read" ? { userId, registrationOpen: false } : { error: "no-answerer" };

async function start({ store = fakeStore(), time = at(12, 10), ask, api } = {}) {
  let now = time;
  let minted = 0;
  const mintStep = () => `01K7STEP0000000000000000${String(++minted).padStart(2, "0")}`;
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, now: () => now, mint: () => D2, mintStep, ask, api }, clock });
  const steps = [];
  const settled = [];
  const conflicted = [];
  actor.on("step.recorded", ({ type, ...p }) => {
    assert.ok(recordedSchema.validate(p).valid, JSON.stringify(p));
    steps.push(p);
  });
  actor.on("step.settled", ({ type, ...p }) => {
    assert.ok(settledSchema.validate(p).valid, JSON.stringify(p));
    settled.push(p);
  });
  actor.on("journal.conflicted", (e) => conflicted.push(e));
  const changed = [];
  actor.on("journal.changed", (e) => changed.push(e));
  actor.start();
  await flush();
  const write = (id, text, left) => {
    const event = { type: "day.saved", id, text, ...(left ? { left: true } : {}) };
    const { type, ...payload } = event;
    assert.ok(savedSchema.validate(payload).valid);
    actor.send(event);
  };
  const read = () => {
    let reply;
    actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
    return reply;
  };
  const text = (id = D1) => read().days.find((d) => d.id === id)?.text;
  const advance = (ms) => {
    now += ms;
    clock.increment(ms);
  };
  return { actor, store, steps, settled, conflicted, changed, write, read, text, advance };
}

const undo = (step) => ({ type: "step.undone", id: step.id, owner: "journal", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "journal", payload: step.redo });
const record = (id, day, text, editedAt) => ({ id, day, text, editedAt, version: 1 });
const shown = (s, day, writable = false) => s.actor.send({ type: "day.shown", day, writable });

test("a stretch of typing in today's page is one step, closed when the user leaves the box", async () => {
  const s = await start();
  s.write(D1, "Mo");
  s.write(D1, "Morning");
  s.write(D1, "Morning", true);
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 1);
  assert.equal(s.steps.at(-1).label, "edit the journal page");
  assert.equal(s.steps.at(-1).notice, undefined);
  s.write(D1, "Morning\nAfter lunch", true);
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2, "the next stretch is a step of its own");
});

test("Undo and Redo put the text back and make it again, also two stretches in a row, and record nothing", async () => {
  const s = await start();
  s.write(D1, "First", true);
  s.write(D1, "First\nSecond", true);
  const [one, two] = [s.steps[0], s.steps.at(-1)];
  const count = s.steps.length;
  s.actor.send(undo(two));
  assert.equal(s.text(), "First");
  s.actor.send(undo(one));
  assert.equal(s.text(), "", "undoing the first stretch of a new page empties it");
  assert.deepEqual(s.settled.map((x) => x.outcome), ["applied", "applied"]);
  s.actor.send(redo(one));
  s.actor.send(redo(two));
  assert.equal(s.text(), "First\nSecond");
  assert.deepEqual(s.settled.map((x) => x.outcome), ["applied", "applied", "applied", "applied"]);
  assert.equal(s.steps.length, count, "applying records nothing");
});

test("a step can be undone after a reload", async () => {
  const store = fakeStore();
  const s = await start({ store });
  s.write(D1, "Before", true);
  s.write(D1, "Before\nAfter", true);
  const step = s.steps.at(-1);
  s.actor.stop();
  const again = await start({ store });
  again.actor.send(undo(step));
  assert.deepEqual(again.settled.at(-1), { id: step.id, owner: "journal", outcome: "applied" });
  assert.equal(again.text(), "Before");
});

test("a step whose day was written since by another device is refused as changed", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore({ userId: "u1" }), ask: signedIn("u1"), api: server.api });
  s.write(D1, "Mine", true);
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(server.days.get(D1).text, "Mine");
  const step = s.steps.at(-1);
  server.other({ ...server.days.get(D1), text: "From the phone" });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(s.text(), "From the phone");
  s.actor.send(undo(step));
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "journal", outcome: "refused", reason: "changed" });
  assert.equal(s.text(), "From the phone");
});

test("signed in, a step survives its own write reaching the account", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore({ userId: "u1" }), ask: signedIn("u1"), api: server.api });
  s.write(D1, "One", true);
  s.write(D1, "One\nTwo", true);
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  s.actor.send(undo(s.steps.at(-1)));
  assert.equal(s.settled.at(-1).outcome, "applied");
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(server.days.get(D1).text, "One");
});

test("text of a day that closed at 2:00 cannot be undone: refused as closed", async () => {
  const s = await start({ time: at(12, 23) });
  s.write(D1, "Late", true);
  const step = s.steps.at(-1);
  s.advance(3 * 60 * 60 * 1000);
  s.actor.send(undo(step));
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "journal", outcome: "refused", reason: "closed" });
  assert.equal(s.text(), "Late");
});

test("keeping one copy is one step with the notice; Undo brings both copies back, Redo keeps it again", async () => {
  const store = fakeStore({ days: [record(D1, "2026-10-11", "From the Mac", at(11, 9)), record(D2, "2026-10-11", "From the phone", at(11, 20))] });
  const s = await start({ store, time: at(12, 10) });
  shown(s, "2026-10-11");
  assert.equal(s.conflicted.length, 1);
  s.write(D2, "From the Mac");
  const step = s.steps.at(-1);
  assert.deepEqual([step.label, step.notice], ["keep one copy of the day", true]);
  assert.equal(s.changed.at(-1).settled, D2, "the change names the day it settled");
  assert.equal(store.tables.days.get(D1).deleted, true);
  s.actor.send(undo(step));
  assert.equal(s.settled.at(-1).outcome, "applied", "a closed day's choice can be taken back");
  assert.equal(s.changed.at(-1).settled, undefined, "an Undo settles nothing");
  assert.equal(store.tables.days.get(D1).deleted, undefined, "the other record is back under its own id");
  assert.equal(s.text(D2), "From the phone");
  assert.equal(s.conflicted.length, 2, "both copies are put to the page again");
  s.actor.send(redo(step));
  assert.equal(s.settled.at(-1).outcome, "applied");
  assert.equal(s.changed.at(-1).settled, D2, "a Redo settles the conflict again, so the page hides the copies");
  assert.equal(store.tables.days.get(D1).deleted, true);
  assert.deepEqual(s.read().days.map((d) => [d.id, d.text]), [[D2, "From the Mac"]]);
});

test("signed in, Undo of a kept copy brings the deleted record back with a restore write", async () => {
  const server = fakeServer();
  server.other(record(D1, "2026-10-12", "Written on the Mac", at(12, 8)));
  const store = fakeStore({ userId: "u1", days: [record(D2, "2026-10-12", "Written here", at(12, 9))] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  shown(s, "2026-10-12", true);
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  s.write(D2, "Written here");
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.equal(server.days.get(D1).deleted, true);
  const tombstone = server.days.get(D1).version;
  s.actor.send(undo(s.steps.at(-1)));
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  const restore = server.puts.at(-1);
  assert.deepEqual([restore.record.id, restore.baseVersion, Boolean(restore.deleted)], [D1, tombstone, false]);
  assert.equal(server.days.get(D1).deleted, false, "the account has both copies again");
});

test("Undo of a copy kept after a conflict with another device puts that conflict to the page again", async () => {
  const server = fakeServer();
  server.other({ id: D1, day: "2026-10-12", text: "Morning", editedAt: at(12, 9) });
  const store = fakeStore({ userId: "u1", days: [{ id: D1, day: "2026-10-12", text: "Morning", editedAt: at(12, 9), version: 1 }] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  server.other({ id: D1, day: "2026-10-12", text: "Morning\nPhone", editedAt: at(12, 9, 30) });
  s.write(D1, "Morning\nLaptop", true);
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.equal(s.conflicted.length, 1);
  s.write(D1, "Morning\nLaptop");
  const step = s.steps.at(-1);
  assert.equal(step.label, "keep one copy of the day");
  assert.equal(s.text(), "Morning\nLaptop");
  s.actor.send(undo(step));
  assert.equal(s.text(), "Morning\nPhone");
  assert.equal(s.conflicted.length, 2);
  assert.deepEqual(s.conflicted.at(-1).mine.text, "Morning\nLaptop");
  s.actor.send(redo(step));
  assert.equal(s.changed.at(-1).settled, D1, "a Redo settles the conflict again");
});
