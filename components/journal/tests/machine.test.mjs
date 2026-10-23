import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, openDay, dateOf, HOUR, tidy, visible, clashOn } from "../machine.js";

// The actor is where the journal's decisions live (3.2): it is driven with a fake store,
// a clock the test sets, and a SimulatedClock for the timer that closes the open day.
// Times are built with the local Date constructor, so the midnight cases hold in any
// time zone.

const HERE = dirname(fileURLToPath(import.meta.url));
// Schemas are read, never imported (11.2); the gestures' schemas live with their emitters.
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "journal.changed.json");
const CONFLICTED = json("events", "journal.conflicted.json");
const SESSION_CHANGED = json("..", "session", "events", "session.changed.json");
const READ = json("queries", "read.json").reply;
const DAY_SAVED = json("..", "journal-entry", "events", "day.saved.json");
const REOPENED = json("..", "journal-entry", "events", "conflict.reopened.json");
const recorded = [];

const D1 = "01K7TEST00000000000000DA01";
const D2 = "01K7TEST00000000000000DA02";
const D9 = "01K7TEST00000000000000DA09";

const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();
const MIN = 60 * 1000;

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore({ days = [], userId, outbox: rows = [] } = {}) {
  const tables = { days: new Map(days.map((r) => [r.id, r])) };
  const meta = new Map(userId === undefined ? [] : [["userId", userId]]);
  const outbox = new Map(rows.map((row) => [row.key, row]));
  const puts = [];
  return {
    tables,
    meta,
    outbox,
    puts,
    all: (t) => Promise.resolve([...tables[t].values()]),
    put: (t, r) => (puts.push([t, r.id]), tables[t].set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (row) => (outbox.set(row.key, row), Promise.resolve()),
    outboxDelete: (key) => (outbox.delete(key), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

async function start({ store = fakeStore(), time = at(12, 10), ask, api } = {}) {
  let now = time;
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, now: () => now, mint: () => D9, ask, api }, clock });
  const emitted = [];
  const conflicted = [];
  actor.on("journal.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.on("journal.conflicted", (e) => {
    conflicted.push(e);
    recorded.push({ value: e, schema: CONFLICTED });
  });
  actor.start();
  await flush();
  const send = (event, schema) => {
    recorded.push({ value: event, schema });
    actor.send(event);
  };
  const read = () => {
    let reply;
    actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
    recorded.push({ value: reply, schema: READ });
    return reply;
  };
  // The wall clock and the timers move together, as they do in a browser.
  const advance = (ms) => {
    now += ms;
    clock.increment(ms);
  };
  const setNow = (t) => (now = t);
  return { actor, store, emitted, conflicted, send, read, advance, setNow };
}

const write = (s, id, text) => s.send({ type: "day.saved", id, text }, DAY_SAVED);

// --- Pure functions -------------------------------------------------------------------

test("a day is open while its date is today, or for an hour after its last edit", () => {
  const day = (d, editedAt) => ({ id: D1, day: d, text: "x", editedAt, version: 1 });
  const lateNight = day("2026-10-11", at(11, 23, 40));
  assert.equal(openDay([lateNight], at(11, 23, 59))?.id, D1, "still its own day");
  assert.equal(openDay([lateNight], at(12, 0, 30))?.id, D1, "just past midnight, edited 50 minutes ago");
  assert.equal(openDay([lateNight], at(12, 0, 39))?.id, D1);
  assert.equal(openDay([lateNight], at(12, 0, 40)), null, "an hour after the last edit, past its date");
  const morning = day("2026-10-12", at(12, 8));
  assert.equal(openDay([morning], at(12, 23, 59))?.id, D1, "an hour gone but its date is today");
  assert.equal(openDay([morning], at(13, 0, 0)), null, "closes at its midnight once the hour is long gone");
  const pastMidnight = day("2026-10-11", at(12, 0, 30));
  assert.equal(openDay([pastMidnight], at(12, 1, 29))?.id, D1, "an edit after midnight keeps it open another hour");
  assert.equal(openDay([pastMidnight], at(12, 1, 30)), null);
  assert.equal(openDay([], at(12, 10)), null);
  assert.equal(dateOf(at(12, 0, 0)), "2026-10-12");
  assert.equal(dateOf(at(11, 23, 59)), "2026-10-11");
});

// --- Days -----------------------------------------------------------------------------

test("a new day is dated at its first character; an empty one is not a day yet", async () => {
  const s = await start({ time: at(12, 23, 50) });
  assert.deepEqual([s.read().days, s.read().open], [[], null], "no day open: an empty page for today");
  write(s, D1, "");
  assert.equal(s.emitted.length, 0);
  write(s, D1, "H");
  const [day] = s.read().days;
  assert.deepEqual({ ...day }, { id: D1, day: "2026-10-12", text: "H", editedAt: at(12, 23, 50), version: 1, waiting: [], unanswered: [] });
  assert.equal(s.read().open, D1);
  assert.deepEqual(s.emitted.at(-1), { type: "journal.changed", ...s.read() });
  assert.deepEqual(s.store.tables.days.get(D1).text, "H", "stored");
  s.advance(15 * MIN);
  write(s, D1, "Hello\nPast midnight");
  assert.equal(s.read().days[0].day, "2026-10-12", "the date never changes");
  assert.equal(s.read().days[0].version, 2, "a version minted locally");
  const n = s.emitted.length;
  write(s, D1, "Hello\nPast midnight");
  assert.equal(s.emitted.length, n, "a repeat announces nothing");
});

test("a save to a day that is not open is refused, and a second day cannot start beside the open one", async () => {
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-10", text: "Old", editedAt: at(10, 21), version: 3 }] });
  const s = await start({ store, time: at(12, 9) });
  assert.equal(s.read().open, null);
  write(s, D1, "Old, rewritten");
  assert.equal(s.read().days[0].text, "Old", "a closed day keeps its text");
  assert.equal(s.emitted.length, 0);
  assert.ok(!s.store.puts.some(([t]) => t === "days"), "nothing stored");
  write(s, D2, "Today");
  assert.equal(s.read().open, D2);
  write(s, D1, "Old, again");
  write(s, "01K7TEST00000000000000DA03", "A second today");
  assert.deepEqual(s.read().days.map((d) => [d.id, d.text]), [[D1, "Old"], [D2, "Today"]], "oldest first");
});

test("the open day closes by time alone and the journal says so", async () => {
  const s = await start({ time: at(12, 23, 30) });
  write(s, D1, "Late");
  s.advance(40 * MIN); // 00:10, edited 40 minutes ago
  write(s, D1, "Late\nStill going");
  const n = s.emitted.length;
  s.advance(59 * MIN); // 01:09
  assert.equal(s.emitted.length, n, "still open: nothing to announce");
  assert.equal(s.read().open, D1);
  s.advance(1 * MIN); // 01:10, an hour after the last edit
  assert.equal(s.emitted.length, n + 1);
  assert.equal(s.emitted.at(-1).open, null);
  assert.deepEqual(s.emitted.at(-1), { type: "journal.changed", ...s.read() });
  s.advance(5 * HOUR);
  assert.equal(s.emitted.length, n + 1, "no timer is left running");
  write(s, D1, "Too late");
  assert.equal(s.read().days[0].text, "Late\nStill going");
});

test("a day written in the morning closes at its midnight", async () => {
  const s = await start({ time: at(12, 9) });
  write(s, D1, "Morning");
  const n = s.emitted.length;
  s.advance(at(13, 0) - at(12, 9) - 1);
  assert.equal(s.emitted.length, n);
  s.advance(1);
  assert.equal(s.emitted.length, n + 1);
  assert.equal(s.read().open, null);
});

test("a day loaded while it is still open closes on time", async () => {
  const s = await start({ store: fakeStore({ days: [{ id: D1, day: "2026-10-11", text: "x", editedAt: at(11, 23, 50), version: 1 }] }), time: at(12, 0, 20) });
  assert.equal(s.read().open, D1);
  s.advance(30 * MIN);
  assert.equal(s.read().open, null);
  assert.equal(s.emitted.at(-1).open, null);
});

test("a save or a read that arrives while the store loads is applied once it is ready", async () => {
  let open;
  const store = fakeStore();
  const gate = new Promise((r) => (open = r));
  const all = store.all;
  store.all = async (t) => (await gate, all(t));
  const actor = createActor(machine, { input: { store, now: () => at(12, 10) }, clock: new SimulatedClock() });
  let reply;
  actor.start();
  actor.send({ type: "day.saved", id: D1, text: "Early" });
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  assert.equal(reply, undefined);
  open();
  await flush();
  assert.equal(reply.days[0].text, "Early");
  assert.deepEqual([reply.projects, reply.detectors, reply.answers, reply.reason], [[], [], [], "no-detector"]);
});

// --- Asking Jev -----------------------------------------------------------------------

// --- Sync with the server ------------------------------------------------------------

function fakeServer() {
  const tables = { days: new Map() };
  const puts = [];
  let seq = 0;
  const keyOf = (_table, r) => r.id;
  const out = ({ seq: _, ...r }) => structuredClone(r);
  const held = (table, id) => tables[table].get(id);
  const set = (table, record, version, deleted = false) => {
    const r = { ...structuredClone(record), version, deleted, seq: ++seq };
    tables[table].set(keyOf(table, record), r);
    return out(r);
  };
  const api = {
    async put(row) {
      puts.push(structuredClone(row));
      const was = held(row.table, keyOf(row.table, row.record));
      if (!was) return { record: set(row.table, row.record, (row.baseVersion ?? 0) + 1, Boolean(row.deleted)) };
      if (row.deleted) return { record: was.deleted ? out(was) : set(row.table, row.record, was.version + 1, true) };
      if (was.deleted) return { conflict: true, record: out(was) };
      const { version: _v, deleted: _d, seq: _s, ...content } = was;
      if (same(content, row.record)) return { record: out(was) };
      if (row.baseVersion !== was.version) return { conflict: true, record: out(was) };
      return { record: set(row.table, row.record, was.version + 1) };
    },
    async pull(since) {
      const pulled = Object.fromEntries(
        Object.entries(tables).map(([t, m]) => [t, [...m.values()].filter((r) => r.seq > since).map(out)]),
      );
      return { ...pulled, cursor: seq };
    },
  };
  // Another device's write, straight into the server.
  const other = (table, record) => set(table, record, (held(table, keyOf(table, record))?.version ?? 0) + 1);
  return { api, puts, held, other };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const signedIn = (userId) => async (target, name) =>
  target === "session" && name === "read" ? { userId, registrationOpen: false } : { error: "no-answerer" };
const IDLE = 2000;

test("signed in, a run of saves goes up once typing pauses, as one write", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore({ userId: "u1" }), ask: signedIn("u1"), api: server.api });
  assert.deepEqual(server.puts, [], "nothing changed, so nothing goes up");
  write(s, D1, "One");
  write(s, D1, "One\nTwo");
  s.advance(IDLE - 1);
  await flush();
  assert.deepEqual(server.puts, [], "still inside the pause");
  write(s, D1, "One\nTwo\nThree");
  s.advance(IDLE - 1);
  await flush();
  assert.deepEqual(server.puts, [], "a save restarts the pause");
  s.advance(1);
  await flush();
  assert.deepEqual(server.puts.map((r) => r.key), [`days\n${D1}`]);
  assert.equal(server.puts[0].record.text, "One\nTwo\nThree");
  assert.equal(server.puts[0].baseVersion, null, "a new day");
  assert.equal(s.store.outbox.size, 0, "acknowledged rows are gone");
  assert.equal(s.read().days[0].version, 1, "the server's version");
});

test("a tab going to the background drains at once, without waiting for the pause", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore({ userId: "u1" }), ask: signedIn("u1"), api: server.api });
  write(s, D1, "One");
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.equal(server.puts.length, 1);
  assert.equal(s.store.outbox.size, 0);
});

test("a day written on a version another device moved past comes back as a conflict with both copies", async () => {
  const server = fakeServer();
  server.other("days", { id: D1, day: "2026-10-12", text: "Morning", editedAt: at(12, 9) });
  const store = fakeStore({ userId: "u1", days: [{ id: D1, day: "2026-10-12", text: "Morning", editedAt: at(12, 9), version: 1 }] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  server.other("days", { id: D1, day: "2026-10-12", text: "Morning\nFrom the phone", editedAt: at(12, 9, 30) });
  write(s, D1, "Morning\nFrom the laptop");
  s.advance(IDLE);
  await flush();
  assert.equal(server.puts.at(-1).baseVersion, 1);
  assert.deepEqual(s.conflicted.map(({ type, ...e }) => e), [
    {
      id: D1,
      mine: { text: "Morning\nFrom the laptop", baseVersion: 1 },
      theirs: { text: "Morning\nFrom the phone", version: 2, editedAt: at(12, 9, 30) },
    },
  ]);
  assert.equal(s.read().days[0].text, "Morning\nFrom the phone", "the server's copy is kept");
  assert.equal(s.read().days[0].version, 2);
  assert.equal(s.store.outbox.size, 0);
});

test("signing in moves the journal kept in this browser to the account, with its history", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore(), api: server.api });
  write(s, D1, "One");
  write(s, D1, "One\nTwo");
  s.advance(IDLE);
  await flush();
  assert.deepEqual(server.puts, [], "signed out, nothing goes up");
  assert.equal(s.read().days[0].version, 2, "versions numbered in the browser");
  s.send({ type: "session.changed", userId: "u1" }, SESSION_CHANGED);
  await flush();
  assert.deepEqual(server.puts.map((r) => [r.key, r.baseVersion]), [[`days\n${D1}`, 2]], "every day, on the version it holds");
  assert.equal(server.held("days", D1).version, 3, "the server continues the browser's history");
  assert.equal(s.read().days[0].version, 3);
  assert.equal(s.store.meta.get("userId"), "u1");
  s.send({ type: "session.changed", userId: null }, SESSION_CHANGED);
  write(s, D1, "One\nTwo\nThree");
  s.advance(IDLE);
  await flush();
  assert.equal(server.puts.length, 1, "signed out again, the change waits");
  assert.equal(s.store.outbox.size, 1);
  s.send({ type: "session.changed", userId: "u1" }, SESSION_CHANGED);
  await flush();
  assert.equal(server.held("days", D1).text, "One\nTwo\nThree", "and goes up at the next sign-in");
  assert.equal(s.store.outbox.size, 0);
});

test("a browser signed in elsewhere since it last synced adopts its journal at load", async () => {
  const server = fakeServer();
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-12", text: "Kept here", editedAt: at(12, 9), version: 1 }] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  await flush();
  assert.equal(server.held("days", D1).text, "Kept here");
  assert.equal(s.read().days[0].version, 2);
});

test("an outbox row that is not a day is dropped at load, so the days behind it go up", async () => {
  const server = fakeServer();
  const old = { key: "answers\nx", table: "answers", record: {}, baseVersion: null };
  const day = { key: `days\n${D1}`, table: "days", record: { id: D1, day: "2026-10-12", text: "Kept", editedAt: at(12, 9) }, baseVersion: null };
  const store = fakeStore({ userId: "u1", days: [{ ...day.record, version: 1 }], outbox: [old, day] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  await flush();
  assert.deepEqual(server.puts.map((r) => r.key), [`days\n${D1}`]);
  assert.equal(server.held("days", D1).text, "Kept");
  assert.equal(s.store.outbox.size, 0);
});

// --- Two records of one date ----------------------------------------------------------

const D3 = "01K7TEST00000000000000DA03";
const DAY_SHOWN = json("..", "journal-entry", "events", "day.shown.json");
const record = (id, day, text, editedAt, extra = {}) => ({ id, day, text, editedAt, version: 1, ...extra });
const shown = (s, day, writable = false) => s.send({ type: "day.shown", day, writable }, DAY_SHOWN);

test("two written records of one date show as one day, the newest, and are a clash", () => {
  const older = record(D1, "2026-10-11", "From the Mac", at(11, 9));
  const newer = record(D2, "2026-10-11", "From the phone", at(11, 20));
  const days = [older, newer, record(D3, "2026-10-10", "Saturday", at(10, 9))];
  assert.deepEqual(visible(days).map((d) => d.id).sort(), [D2, D3]);
  assert.deepEqual(clashOn(days, "2026-10-11"), { kept: newer, other: older });
  assert.equal(clashOn(days, "2026-10-10"), null);
  assert.equal(openDay([older, newer], at(11, 21))?.id, D2, "the open day is the one shown");
});

test("a second record that is empty or the same text is deleted, the written or newest kept", () => {
  const empty = record(D1, "2026-10-11", "", at(11, 22));
  const written = record(D2, "2026-10-11", "Words", at(11, 9));
  assert.deepEqual(tidy([empty, written]).map((d) => [d.id, Boolean(d.deleted)]), [[D1, true], [D2, false]]);
  const copy = record(D3, "2026-10-11", "Words", at(11, 10));
  assert.deepEqual(tidy([written, copy]).map((d) => [d.id, Boolean(d.deleted)]), [[D2, true], [D3, false]]);
  assert.equal(clashOn([empty, written], "2026-10-11"), null, "nothing to choose between");
  const alone = [written];
  assert.equal(tidy(alone), alone, "one record per date is left as it is");
});

test("the page showing a clashed date is told both copies, and keeping the older deletes the newer record", async () => {
  const store = fakeStore({ days: [record(D1, "2026-10-11", "From the Mac", at(11, 9)), record(D2, "2026-10-11", "From the phone", at(11, 20))] });
  const s = await start({ store, time: at(12, 10) });
  assert.deepEqual(s.read().days.map((d) => d.id), [D2]);
  assert.equal(s.conflicted.length, 0, "nobody shows that date yet");
  shown(s, "2026-10-11");
  assert.deepEqual(s.conflicted.map(({ type, ...e }) => e), [
    { id: D2, mine: { text: "From the Mac", baseVersion: 1, editedAt: at(11, 9) }, theirs: { text: "From the phone", version: 1, editedAt: at(11, 20) } },
  ]);
  write(s, D2, "From the Mac");
  const [day] = s.read().days;
  assert.deepEqual([day.id, day.text, day.editedAt], [D2, "From the Mac", at(11, 20)], "kept on its closed day, its time of last edit unchanged");
  assert.equal(store.tables.days.get(D1).deleted, true, "the other record is a tombstone");
  assert.equal(store.tables.days.get(D1).text, "From the Mac", "and keeps its text");
  shown(s, "2026-10-11");
  assert.equal(s.conflicted.length, 1, "settled: nothing more to tell");
});

test("keeping the copy the day shows deletes the other record and changes no text", async () => {
  const store = fakeStore({ days: [record(D1, "2026-10-11", "From the Mac", at(11, 9)), record(D2, "2026-10-11", "From the phone", at(11, 20))] });
  const s = await start({ store, time: at(12, 10) });
  shown(s, "2026-10-11");
  write(s, D2, "From the phone");
  assert.equal(store.tables.days.get(D1).deleted, true);
  assert.deepEqual(s.read().days.map((d) => [d.id, d.text]), [[D2, "From the phone"]]);
});

test("only a save of a copy's exact text, not one made on leaving the box, settles a clash", async () => {
  const today = "2026-10-12";
  const store = fakeStore({ days: [record(D1, today, "Laptop", at(12, 8)), record(D2, today, "Phone", at(12, 9))] });
  const s = await start({ store, time: at(12, 10) });
  shown(s, today, true);
  s.send({ type: "day.saved", id: D2, text: "Phone", left: true }, DAY_SAVED);
  write(s, D2, "Phone, more");
  assert.equal(store.tables.days.get(D1).deleted, undefined, "typing is not a choice");
  assert.equal(s.read().days[0].text, "Phone, more");
  assert.equal(s.conflicted.length, 2, "a changed copy is told again");
  write(s, D2, "Laptop");
  assert.equal(store.tables.days.get(D1).deleted, true);
  assert.equal(s.read().days[0].editedAt, at(12, 10), "the open day takes the time of the save");
});

test("signed in, a clash pulled from the account is told, and a choice sends the tombstone up", async () => {
  const server = fakeServer();
  server.other("days", record(D1, "2026-10-12", "Written on the Mac", at(12, 8)));
  const store = fakeStore({ userId: "u1", days: [record(D2, "2026-10-12", "Written here", at(12, 9))] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  shown(s, "2026-10-12", true);
  // The page showed the date before the pull landed: the clash is told when it arrives.
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(s.conflicted.at(-1).id, D2);
  assert.equal(s.conflicted.at(-1).mine.text, "Written on the Mac");
  write(s, D2, "Written on the Mac");
  s.advance(IDLE);
  await flush();
  assert.equal(server.held("days", D1).deleted, true, "the other record is deleted on the account");
  assert.equal(server.held("days", D2).text, "Written on the Mac");
});

test("signed in, an empty second record pulled from the account is deleted without asking", async () => {
  const server = fakeServer();
  server.other("days", record(D1, "2026-10-12", "", at(12, 9, 30)));
  const store = fakeStore({ userId: "u1", days: [record(D2, "2026-10-12", "Written here", at(12, 9))] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  shown(s, "2026-10-12", true);
  await flush();
  s.advance(IDLE);
  await flush();
  assert.equal(s.conflicted.length, 0);
  assert.deepEqual(s.read().days.map((d) => d.id), [D2]);
  assert.equal(server.held("days", D1).deleted, true);
});

test("a day saved on two devices can keep the user's copy after it has closed", async () => {
  const server = fakeServer();
  server.other("days", record(D1, "2026-10-11", "Evening", at(11, 20)));
  const store = fakeStore({ userId: "u1", days: [record(D1, "2026-10-11", "Evening", at(11, 20))] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api, time: at(11, 21) });
  server.other("days", record(D1, "2026-10-11", "Evening, phone", at(11, 21)));
  write(s, D1, "Evening, laptop");
  s.advance(IDLE);
  await flush();
  assert.equal(s.conflicted.length, 1);
  // The day closes before the user chooses.
  s.setNow(at(12, 10));
  write(s, D1, "Something else");
  assert.equal(s.read().days[0].text, "Evening, phone", "an ordinary save to a closed day is still refused");
  write(s, D1, "Evening, laptop");
  assert.equal(s.read().days[0].text, "Evening, laptop");
  s.advance(IDLE);
  await flush();
  assert.equal(server.held("days", D1).text, "Evening, laptop");
});

const reopen = (s, id, mine, theirs) => s.send({ type: "conflict.reopened", id, mine, theirs }, REOPENED);

test("Undo after keeping the older copy of a date gives back both copies and the clash", async () => {
  const store = fakeStore({ days: [record(D1, "2026-10-11", "From the Mac", at(11, 9)), record(D2, "2026-10-11", "From the phone", at(11, 20))] });
  const s = await start({ store, time: at(12, 10) });
  shown(s, "2026-10-11");
  write(s, D2, "From the Mac");
  reopen(s, D2, "From the Mac", "From the phone");
  const [day] = s.read().days;
  assert.deepEqual([day.id, day.text, day.editedAt], [D2, "From the phone", at(11, 20)], "the shown day as it was");
  const back = store.tables.days.get(D9);
  assert.deepEqual([back.day, back.text, back.editedAt, back.deleted], ["2026-10-11", "From the Mac", at(11, 9), undefined], "the other copy, as a new record");
  assert.equal(store.tables.days.get(D1).deleted, true, "the deleted record stays a tombstone (5)");
  assert.deepEqual(s.conflicted.at(-1), {
    type: "journal.conflicted",
    id: D2,
    mine: { text: "From the Mac", baseVersion: day.version, editedAt: at(11, 9) },
    theirs: { text: "From the phone", version: day.version, editedAt: at(11, 20) },
  });
  reopen(s, D2, "From the Mac", "From the phone");
  assert.equal(s.conflicted.length, 2, "one Undo per choice");
  write(s, D2, "From the phone");
  assert.equal(store.tables.days.get(D9).deleted, true, "the clash can be settled again");
});

test("signed in, Undo after keeping the shown copy sends the other copy up as a new record", async () => {
  const server = fakeServer();
  server.other("days", record(D1, "2026-10-12", "Written on the Mac", at(12, 8)));
  const store = fakeStore({ userId: "u1", days: [record(D2, "2026-10-12", "Written here", at(12, 9))] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  shown(s, "2026-10-12", true);
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  write(s, D2, "Written here");
  s.advance(IDLE);
  await flush();
  assert.equal(server.held("days", D1).deleted, true);
  reopen(s, D2, "Written on the Mac", "Written here");
  s.advance(IDLE);
  await flush();
  assert.equal(server.held("days", D9).text, "Written on the Mac");
  assert.equal(server.held("days", D9).deleted, false);
  assert.equal(s.conflicted.at(-1).mine.text, "Written on the Mac");
  assert.equal(store.outbox.size, 0);
});

test("Undo after keeping your copy of a day saved on two devices puts back theirs and the conflict", async () => {
  const server = fakeServer();
  server.other("days", record(D1, "2026-10-11", "Evening", at(11, 20)));
  const store = fakeStore({ userId: "u1", days: [record(D1, "2026-10-11", "Evening", at(11, 20))] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api, time: at(11, 21) });
  server.other("days", record(D1, "2026-10-11", "Evening, phone", at(11, 21)));
  write(s, D1, "Evening, laptop");
  s.advance(IDLE);
  await flush();
  const told = s.conflicted.at(-1);
  write(s, D1, "Evening, laptop");
  s.advance(IDLE);
  await flush();
  assert.equal(server.held("days", D1).text, "Evening, laptop");
  reopen(s, D1, "Evening, laptop", "Evening, phone");
  assert.equal(s.read().days[0].text, "Evening, phone");
  assert.deepEqual(s.conflicted.at(-1), told, "the same conflict, told again");
  s.advance(IDLE);
  await flush();
  assert.equal(server.held("days", D1).text, "Evening, phone");
  write(s, D1, "Evening, laptop");
  assert.equal(s.read().days[0].text, "Evening, laptop", "and it can be settled again");
});

test("Undo is refused once the day has changed since the choice", async () => {
  const today = "2026-10-12";
  const store = fakeStore({ days: [record(D1, today, "Laptop", at(12, 8)), record(D2, today, "Phone", at(12, 9))] });
  const s = await start({ store, time: at(12, 10) });
  shown(s, today, true);
  write(s, D2, "Laptop");
  write(s, D2, "Laptop, more");
  reopen(s, D2, "Laptop", "Phone");
  assert.deepEqual(s.read().days.map((d) => [d.id, d.text]), [[D2, "Laptop, more"]]);
  assert.equal(store.tables.days.has(D9), false);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
