import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with fakes for the bus
// tap, the channel, and the console, the shapes fact.js builds for real. `tap`
// feeds a bus record (no `tab`: the bus does not know it); `recv` feeds a channel
// message from another tab.
const TAB = "01ABCDEFGHJKMNPQRS0001"; // last 4 = 0001

function driver(tab = TAB) {
  let tapCb, subCb;
  const published = [];
  const shared = [];
  const printed = [];
  const emitted = [];
  const actor = createActor(machine, {
    input: {
      tab,
      tap: (cb) => ((tapCb = cb), () => {}),
      subscribe: (cb) => ((subCb = cb), () => {}),
      publish: (r) => published.push(r),
      share: (r) => shared.push(r),
      print: (t) => printed.push(t),
    },
  });
  actor.on("trace.recorded", (e) => emitted.push(e));
  actor.start();
  return {
    actor,
    records: () => actor.getSnapshot().context.records,
    tap: (r) => tapCb(r),
    recv: (m) => subCb(m),
    published,
    shared,
    printed,
    emitted,
  };
}

const rec = (over = {}) => ({
  seq: 1,
  at: 1000,
  kind: "event",
  name: "note.saved",
  from: "note-editor",
  to: ["notes"],
  ignored: [],
  outcome: "delivered",
  reason: null,
  cid: null,
  payload: { id: "x" },
  ...over,
});

test("tags a tapped record with this tab, emits, publishes, and prints it", () => {
  const d = driver();
  d.tap(rec({ seq: 5 }));
  const records = d.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].tab, TAB);
  assert.equal(d.emitted[0].type, "trace.recorded");
  assert.equal(d.emitted[0].tab, TAB);
  assert.equal(d.published[0].tab, TAB);
  assert.equal(d.printed[0], "trace #5 0001 event note.saved note-editor → notes delivered");
});

test("prints an ignored recipient marked with ~ and the reason", () => {
  const d = driver();
  d.tap(rec({ to: ["a", "b"], ignored: ["b"], outcome: "ignored", reason: "no recipient handles it" }));
  assert.equal(d.printed[0], "trace #1 0001 event note.saved note-editor → a, ~b ignored: no recipient handles it");
});

test("prints each recipient's resulting state when the record carries one", () => {
  const d = driver();
  d.tap(rec({ to: ["notes"], states: { notes: '"ready"' } }));
  assert.equal(d.printed[0], 'trace #1 0001 event note.saved note-editor → notes delivered [notes="ready"]');
});

test("skips its own traffic so it never records itself", () => {
  const d = driver();
  d.tap(rec({ from: "trace" }));
  d.tap(rec({ to: ["trace"] }));
  assert.equal(d.records().length, 0);
  assert.equal(d.emitted.length, 0);
  assert.equal(d.published.length, 0);
});

test("caps at 1000, dropping the oldest", () => {
  const d = driver();
  for (let i = 1; i <= 1001; i++) d.tap(rec({ seq: i, at: i }));
  const records = d.records();
  assert.equal(records.length, 1000);
  assert.equal(records[0].at, 2); // at=1 was the oldest and is gone
});

test("merges a foreign record, sorts it in, and dedupes by tab and seq", () => {
  const d = driver();
  d.tap(rec({ seq: 1, at: 1000 })); // own, later
  const foreign = { ...rec({ seq: 3, at: 500 }), tab: "01ZZZZZZZZZZZZZZ9999" }; // earlier
  d.recv({ type: "record", record: foreign });
  d.recv({ type: "record", record: foreign }); // duplicate: ignored
  const records = d.records();
  assert.equal(records.length, 2);
  assert.equal(records[0].tab, foreign.tab); // sorted earliest first
  assert.equal(records[1].tab, TAB);
  // A foreign record is emitted and printed locally but never republished.
  assert.equal(d.published.length, 1); // only the own record
  assert.ok(d.emitted.some((e) => e.tab === foreign.tab));
});

test("a hello shares only its own records", () => {
  const d = driver();
  d.tap(rec({ seq: 1, at: 10 })); // own
  d.recv({ type: "record", record: { ...rec({ seq: 2, at: 20 }), tab: "01ZZZZZZZZZZZZZZ9999" } }); // foreign
  d.recv({ type: "hello" });
  assert.equal(d.shared.length, 1);
  assert.equal(d.shared[0].length, 1);
  assert.equal(d.shared[0][0].tab, TAB);
});

test("folds a buffer in through the foreign path, deduped", () => {
  const d = driver();
  const a = { ...rec({ seq: 1, at: 10 }), tab: "01ZZZZZZZZZZZZZZ9999" };
  const b = { ...rec({ seq: 2, at: 20 }), tab: "01ZZZZZZZZZZZZZZ9999" };
  d.recv({ type: "buffer", records: [a, b, a] });
  assert.equal(d.records().length, 2);
});

test("answers list with the records kept", () => {
  const d = driver();
  d.tap(rec({ seq: 7 }));
  let replied;
  d.actor.send({ type: "list?", cid: "c1", payload: {}, reply: (v) => (replied = v) });
  assert.equal(replied.records.length, 1);
  assert.equal(replied.records[0].seq, 7);
});
