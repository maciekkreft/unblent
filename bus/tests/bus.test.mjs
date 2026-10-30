import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, emit, setup, fromPromise } from "xstate";
import { mount, unmount, ask, send, tap, answers } from "bus";
import { compile } from "../validate.js";

// The bus is infrastructure, not a component, so it is tested here rather than
// under components/. Fake machines stand in for real ones: a producer that emits
// on an internal (dot-free) event, a consumer that records what the bus delivers.
// The bus checks event names only; any truthy value serves as an event schema.
// A query schema is registered by shape, so it must carry payload and reply (7.2).
const SCHEMA = {};
const QSCHEMA = { payload: {}, reply: {} };

function producer(id, emits = ["thing.happened"]) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits, owns: "a test fact" },
    on: {
      go: { actions: emit(({ event }) => ({ type: "thing.happened", value: event.value })) },
      surprise: { actions: emit({ type: "surprise.happened" }) },
    },
  });
}

function consumer(id, received, on = "thing.happened") {
  return createMachine({
    id,
    meta: { kind: "view", emits: [], attributes: [] },
    on: { [on]: { actions: ({ event }) => received.push(event) } },
  });
}

test("delivers an emitted event to a subscriber, payload intact", () => {
  const received = [];
  const p = mount(producer("p1"), { events: { "thing.happened": SCHEMA } });
  const c = mount(consumer("c1", received), {});
  p.send({ type: "go", value: 42 });
  assert.deepEqual(received, [{ type: "thing.happened", value: 42 }]);
  unmount(p);
  unmount(c);
});

test("a subscriber mounted before the producer still receives", () => {
  const received = [];
  const c = mount(consumer("c2", received), {});
  const p = mount(producer("p2"), { events: { "thing.happened": SCHEMA } });
  p.send({ type: "go", value: 7 });
  assert.deepEqual(received, [{ type: "thing.happened", value: 7 }]);
  unmount(p);
  unmount(c);
});

test("no delivery after unmount", () => {
  const received = [];
  const c = mount(consumer("c3", received), {});
  const p = mount(producer("p3"), { events: { "thing.happened": SCHEMA } });
  unmount(c);
  p.send({ type: "go", value: 1 });
  assert.deepEqual(received, []);
  unmount(p);
});

test("a second mount of the same id throws", () => {
  const a = mount(producer("dup"), { events: { "thing.happened": SCHEMA } });
  assert.throws(
    () => mount(producer("dup"), { events: { "thing.happened": SCHEMA } }),
    /already mounted/,
  );
  unmount(a);
});

test("mount refuses a declared emit with no schema", () => {
  assert.throws(() => mount(producer("noschema"), {}), /no schema/);
});

test("mount refuses an answered query with no schema", () => {
  assert.throws(() => mount(fact("noq"), {}), /answered query "read"/);
});

test("mount accepts an answered query given its { payload, reply } schema", () => {
  const f = mount(fact("okq"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  assert.ok(f);
  unmount(f);
});

// An emit the machine never declared is refused inside the emitter's `on("*")`
// listener, which XState rethrows asynchronously; hence uncaughtException. The
// registry's "unknown event" branch cannot be reached from here — mount registers
// every declared emit's schema, so anything in meta.emits is in the registry.
test("an undeclared emit is refused and reaches no subscriber", async () => {
  const received = [];
  const c = mount(consumer("c6", received, "surprise.happened"), {});
  const p = mount(producer("p6"), { events: { "thing.happened": SCHEMA } });
  // XState's reportUnhandledError rethrows in a macrotask; take over
  // uncaughtException for the moment so node:test does not attribute the
  // deliberate throw to this test, then restore its handlers.
  const saved = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const caught = new Promise((resolve) => process.once("uncaughtException", resolve));
  p.send({ type: "surprise" });
  const err = await caught;
  for (const listener of saved) process.on("uncaughtException", listener);
  assert.match(err.message, /undeclared emit/);
  assert.deepEqual(received, []);
  unmount(p);
  unmount(c);
});

// Queries (4.2): a fake fact that doubles what it is asked, and an asker that
// declares the ask. `ask` is called directly, as a view's controller would.
function fact(id) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits: [], owns: "doubles" },
    on: {
      "read?": { actions: ({ event }) => event.reply({ value: event.payload.id * 2 }) },
      "twice?": {
        actions: ({ event }) => {
          event.reply({ first: true });
          event.reply({ second: true });
        },
      },
    },
  });
}

function asker(id, asks) {
  return createMachine({ id, meta: { kind: "view", emits: [], attributes: [], asks } });
}

test("a query is answered with its payload", async () => {
  const f = mount(fact("f1"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  const a = asker("a1", ["f1: read"]);
  assert.deepEqual(await ask(a, "f1", "read", { id: 21 }), { value: 42 });
  unmount(f);
});

test("two concurrent asks each get their own reply, with distinct cids", async () => {
  const cids = [];
  const slow = createMachine({
    id: "f2",
    meta: { kind: "fact", shape: "local-only", emits: [], owns: "slow" },
    on: {
      "read?": {
        actions: ({ event }) => {
          cids.push(event.cid);
          setTimeout(() => event.reply({ value: event.payload.id }), 0);
        },
      },
    },
  });
  const f = mount(slow, { queries: { read: QSCHEMA } });
  const a = asker("a2", ["f2: read"]);
  const both = await Promise.all([ask(a, "f2", "read", { id: 1 }), ask(a, "f2", "read", { id: 2 })]);
  assert.deepEqual(both, [{ value: 1 }, { value: 2 }]);
  assert.equal(cids.length, 2);
  assert.notEqual(cids[0], cids[1]);
  unmount(f);
});

test("an undeclared ask throws", () => {
  const f = mount(fact("f3"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  const a = asker("a3", []);
  assert.throws(() => ask(a, "f3", "read", { id: 1 }), /undeclared ask/);
  unmount(f);
});

test("an ask aimed at a view throws", () => {
  const v = mount(consumer("v4", []), {});
  const a = asker("a4", ["v4: read"]);
  assert.throws(() => ask(a, "v4", "read", { id: 1 }), /only a fact component answers/);
  unmount(v);
});

test("an unmounted target replies no-answerer", async () => {
  const a = asker("a5", ["nobody: read"]);
  assert.deepEqual(await ask(a, "nobody", "read", { id: 1 }), { error: "no-answerer" });
});

test("a query the target does not handle replies unknown-query", async () => {
  const f = mount(fact("f6"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  const a = asker("a6", ["f6: write"]);
  assert.deepEqual(await ask(a, "f6", "write", {}), { error: "unknown-query" });
  unmount(f);
});

test("the first reply wins; a second call is ignored", async () => {
  const f = mount(fact("f7"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  const a = asker("a7", ["f7: twice"]);
  assert.deepEqual(await ask(a, "f7", "twice"), { first: true });
  unmount(f);
});

// The tap (section 3.3, 10): every routing decision reaches a listener with its
// outcome. `records` collects them; `sub` is dropped in each test's cleanup so one
// test's tap never sees another's traffic.
function collect() {
  const records = [];
  const sub = tap((r) => records.push(r));
  return { records, sub };
}

// A consumer that only handles the event in one state, so the bus can see a
// recipient whose current state ignores it (4, fourth rule).
function gatedConsumer(id) {
  return createMachine({
    id,
    meta: { kind: "view", emits: [], attributes: [] },
    initial: "closed",
    states: { closed: {}, open: { on: { "thing.happened": { actions: () => {} } } } },
  });
}

test("tap records a delivered event with its recipients", () => {
  const { records, sub } = collect();
  const p = mount(producer("t1"), { events: { "thing.happened": SCHEMA } });
  const c = mount(consumer("t1c", []), {});
  p.send({ type: "go", value: 5 });
  const r = records.at(-1);
  assert.equal(r.kind, "event");
  assert.equal(r.name, "thing.happened");
  assert.equal(r.from, "t1");
  assert.equal(r.fromKind, "fact", "the emitter is a fact"); // a producer owns a fact
  assert.deepEqual(r.to, ["t1c"]);
  assert.deepEqual(r.ignored, []);
  assert.equal(r.outcome, "delivered");
  assert.equal(r.payload.value, 5);
  assert.equal(typeof r.seq, "number");
  assert.equal(typeof r.at, "number");
  sub();
  unmount(p);
  unmount(c);
});

test("tap records seq rising and unsubscribe stopping delivery", () => {
  const { records, sub } = collect();
  const p = mount(producer("t2"), { events: { "thing.happened": SCHEMA } });
  const c = mount(consumer("t2c", []), {});
  p.send({ type: "go", value: 1 });
  p.send({ type: "go", value: 2 });
  const [a, b] = records.slice(-2);
  assert.equal(b.seq, a.seq + 1);
  sub();
  p.send({ type: "go", value: 3 });
  assert.equal(records.length, 2);
  unmount(p);
  unmount(c);
});

test("tap records a dropped event when nobody subscribes", () => {
  const { records, sub } = collect();
  const p = mount(producer("t3"), { events: { "thing.happened": SCHEMA } });
  p.send({ type: "go", value: 1 });
  const r = records.at(-1);
  assert.equal(r.outcome, "dropped");
  assert.deepEqual(r.to, []);
  assert.equal(r.reason, "no subscriber");
  sub();
  unmount(p);
});

test("tap records an ignored event when every recipient's state passes on it", () => {
  const { records, sub } = collect();
  const p = mount(producer("t4"), { events: { "thing.happened": SCHEMA } });
  const c = mount(gatedConsumer("t4c"), {}); // starts closed, does not handle it
  p.send({ type: "go", value: 1 });
  const r = records.at(-1);
  assert.equal(r.outcome, "ignored");
  assert.deepEqual(r.to, ["t4c"]);
  assert.deepEqual(r.ignored, ["t4c"]);
  sub();
  unmount(p);
  unmount(c);
});

test("tap records each recipient's state after delivery", () => {
  const { records, sub } = collect();
  // A recipient that transitions on the event, so the record must show the state it
  // reached, not the one it left (section 10).
  const moving = createMachine({
    id: "t4b-c",
    meta: { kind: "view", emits: [], attributes: [] },
    initial: "before",
    states: { before: { on: { "thing.happened": { target: "after" } } }, after: {} },
  });
  const p = mount(producer("t4b"), { events: { "thing.happened": SCHEMA } });
  const c = mount(moving, {});
  p.send({ type: "go", value: 1 });
  const r = records.at(-1);
  assert.equal(r.outcome, "delivered");
  assert.deepEqual(r.states, { "t4b-c": JSON.stringify("after") });
  sub();
  unmount(p);
  unmount(c);
});

// A recipient that emits while handling: the consequence completes inside the
// cause's delivery, yet the transcript must read cause first (section 10).
function reactor(id) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits: ["thing.followed"], owns: "a reaction" },
    on: { "thing.happened": { actions: emit({ type: "thing.followed" }) } },
  });
}

test("tap records a cause before the event a recipient emitted while handling it", () => {
  const { records, sub } = collect();
  const p = mount(producer("t4c"), { events: { "thing.happened": SCHEMA } });
  const r = mount(reactor("t4d"), { events: { "thing.followed": SCHEMA } });
  const received = [];
  const c = mount(consumer("t4e", received, "thing.followed"), {});
  p.send({ type: "go", value: 1 });
  const [cause, effect] = records.slice(-2);
  assert.equal(cause.name, "thing.happened");
  assert.equal(effect.name, "thing.followed");
  assert.ok(effect.seq > cause.seq && effect.at >= cause.at);
  assert.equal(received.length, 1, "delivery itself is unchanged");
  sub();
  unmount(p);
  unmount(r);
  unmount(c);
});

test("tap listener sees a refused record before the throw", async () => {
  const { records, sub } = collect();
  const p = mount(producer("t5"), { events: { "thing.happened": SCHEMA } });
  const saved = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const caught = new Promise((resolve) => process.once("uncaughtException", resolve));
  p.send({ type: "surprise" }); // surprise.happened is undeclared
  const err = await caught;
  for (const listener of saved) process.on("uncaughtException", listener);
  assert.match(err.message, /undeclared emit/);
  const r = records.at(-1);
  assert.equal(r.outcome, "refused");
  assert.equal(r.reason, "undeclared emit");
  assert.equal(r.name, "surprise.happened");
  sub();
  unmount(p);
});

test("tap records asked then replied for an answered query", async () => {
  const { records, sub } = collect();
  const f = mount(fact("t6"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  const a = asker("t6a", ["t6: read"]);
  await ask(a, "t6", "read", { id: 3 });
  const query = records.find((r) => r.kind === "query");
  const reply = records.find((r) => r.kind === "reply");
  assert.ok(records.indexOf(query) < records.indexOf(reply), "the question is recorded before its reply");
  assert.ok(query.seq < reply.seq);
  assert.equal(query.outcome, "asked");
  assert.equal(query.fromKind, "view", "the asker is a view"); // a4/t6a asker is a view
  assert.deepEqual(query.to, ["t6"]);
  assert.equal(reply.outcome, "replied");
  assert.equal(reply.from, "t6");
  assert.equal(reply.fromKind, "fact", "the answerer is always a fact");
  assert.deepEqual(reply.to, ["t6a"]);
  assert.equal(reply.cid, query.cid);
  assert.deepEqual(reply.payload, { value: 6 });
  sub();
  unmount(f);
});

test("tap records no-answerer for an unmounted target", async () => {
  const { records, sub } = collect();
  const a = asker("t7a", ["nobody: read"]);
  await ask(a, "nobody", "read", { id: 1 });
  assert.equal(records.at(-1).outcome, "no-answerer");
  sub();
});

test("tap records unknown-query for a query the target does not handle", async () => {
  const { records, sub } = collect();
  const f = mount(fact("t8"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  const a = asker("t8a", ["t8: write"]);
  await ask(a, "t8", "write", {});
  assert.equal(records.at(-1).outcome, "unknown-query");
  sub();
  unmount(f);
});

test("tap records refused for an undeclared ask, before the throw", () => {
  const { records, sub } = collect();
  const f = mount(fact("t9"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  const a = asker("t9a", []);
  assert.throws(() => ask(a, "t9", "read", { id: 1 }), /undeclared ask/);
  const r = records.at(-1);
  assert.equal(r.outcome, "refused");
  assert.equal(r.reason, "undeclared ask");
  sub();
  unmount(f);
});

test("tap records refused for a query aimed at a view, before the throw", () => {
  const { records, sub } = collect();
  const v = mount(consumer("t10", []), {});
  const a = asker("t10a", ["t10: read"]);
  assert.throws(() => ask(a, "t10", "read", { id: 1 }), /only a fact component answers/);
  const r = records.at(-1);
  assert.equal(r.outcome, "refused");
  assert.equal(r.reason, "query to a view");
  sub();
  unmount(v);
});

test("tap records ignored for a query the answerer's state passes on", () => {
  const { records, sub } = collect();
  const gated = createMachine({
    id: "t11",
    meta: { kind: "fact", shape: "local-only", emits: [], owns: "gated" },
    initial: "closed",
    states: { closed: {}, open: { on: { "read?": { actions: ({ event }) => event.reply({ ok: true }) } } } },
  });
  const f = mount(gated, { queries: { read: QSCHEMA } });
  const a = asker("t11a", ["t11: read"]);
  ask(a, "t11", "read", { id: 1 }); // closed: the query is never answered
  const r = records.at(-1);
  assert.equal(r.kind, "query");
  assert.equal(r.outcome, "ignored");
  assert.deepEqual(r.ignored, ["t11"]);
  sub();
  unmount(f);
});

test("tap records unanswered after the timeout, then replied on a late reply", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { records, sub } = collect();
  const box = {};
  const held = createMachine({
    id: "t12",
    meta: { kind: "fact", shape: "local-only", emits: [], owns: "holds the reply" },
    on: { "read?": { actions: ({ event }) => { box.reply = event.reply; } } },
  });
  const f = mount(held, { queries: { read: QSCHEMA } });
  const a = asker("t12a", ["t12: read"]);
  const pending = ask(a, "t12", "read", { id: 1 });
  t.mock.timers.tick(5000);
  const unanswered = records.find((r) => r.kind === "reply");
  assert.equal(unanswered.outcome, "unanswered");
  assert.equal(unanswered.payload, null);
  box.reply({ value: 9 });
  assert.deepEqual(await pending, { value: 9 });
  const late = records.filter((r) => r.kind === "reply").at(-1);
  assert.equal(late.outcome, "replied");
  assert.equal(late.reason, "late");
  sub();
  unmount(f);
});

// Held replies (4.2): a query's schema names the events that supersede its answer;
// the bus holds those for the asker while the ask is open and releases them, in
// order, after the reply. `holdFact` parks its reply so a test controls when the
// answer lands, and emits `thing.changed` (superseding) or `other.changed` (not) on
// internal bumps. `holdAsker` declares the ask and records what the bus delivers.
const HSCHEMA = { payload: {}, reply: {}, supersededBy: ["thing.changed"] };
const settle = () => new Promise((r) => setTimeout(r, 0));
const TRACE_KEYS = new Set([
  "at", "cid", "from", "fromKind", "ignored", "kind", "name", "outcome", "payload", "reason", "seq", "states", "tab", "to",
]);

function holdFact(id, box) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits: ["thing.changed", "other.changed"], owns: "a held fact" },
    on: {
      "read?": {
        actions: ({ event }) => {
          (box.replies ??= []).push(event.reply);
        },
      },
      bump: { actions: emit(({ event }) => ({ type: "thing.changed", value: event.value })) },
      bumpOther: { actions: emit({ type: "other.changed" }) },
    },
  });
}

function holdAsker(id, received, asks) {
  return createMachine({
    id,
    meta: { kind: "view", emits: [], attributes: [], asks },
    on: {
      "thing.changed": { actions: ({ event }) => received.push(event) },
      "other.changed": { actions: ({ event }) => received.push(event) },
    },
  });
}

// An XState asker as a real view (4.3, fourth rule): initial `loading`, an invoke
// asking the fact, `thing.changed` handled only in the named state, `onDone` moving
// to `ready`. It is what the hold protects — before it, an event landing during
// `loading` was ignored.
function xstateAsker(id, target, received, handledIn) {
  const handler = { "thing.changed": { actions: ({ event }) => received.push(event) } };
  return setup({ actors: { q: fromPromise(({ input }) => input.ask(target, "read", {})) } }).createMachine({
    id,
    meta: { kind: "view", emits: [], attributes: [], asks: [`${target}: read`] },
    context: ({ input }) => ({ ask: input.ask }),
    initial: "loading",
    states: {
      loading: {
        invoke: { src: "q", input: ({ context }) => ({ ask: context.ask }), onDone: "ready", onError: "ready" },
        on: handledIn === "loading" ? handler : {},
      },
      ready: { on: handledIn === "ready" ? handler : {} },
    },
  });
}

test("mount refuses a supersededBy naming an event the fact does not emit", () => {
  assert.throws(
    () => mount(holdFact("hbad", {}), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: { payload: {}, reply: {}, supersededBy: ["nope.changed"] } } }),
    /not in meta\.emits/,
  );
});

test("mount accepts declared supersededBy names and an absent key", () => {
  const f = mount(holdFact("hok", {}), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  unmount(f);
  const g = mount(holdFact("hok2", {}), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: { payload: {}, reply: {} } } });
  unmount(g);
});

test("a superseding event is held until after the reply; other subscribers get it at once", async () => {
  const box = {};
  const received = [];
  const other = [];
  const f = mount(holdFact("hf", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha", received, ["hf: read"]);
  const a = mount(am, {});
  const o = mount(consumer("ho", other, "thing.changed"), {});
  const pending = ask(am, "hf", "read", {});
  f.send({ type: "bump", value: 1 });
  assert.equal(other.length, 1); // not an asker: delivered now
  assert.equal(received.length, 0); // held
  box.replies[0]({ ok: true });
  await pending;
  await settle();
  assert.equal(received.length, 1);
  unmount(f);
  unmount(a);
  unmount(o);
});

test("an event not in supersededBy reaches the asker during the ask", async () => {
  const box = {};
  const received = [];
  const f = mount(holdFact("hf2", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha2", received, ["hf2: read"]);
  const a = mount(am, {});
  ask(am, "hf2", "read", {});
  f.send({ type: "bumpOther" });
  assert.equal(received.length, 1); // other.changed does not supersede read
  box.replies[0]({});
  await settle();
  unmount(f);
  unmount(a);
});

test("held events release in their original order", async () => {
  const box = {};
  const received = [];
  const f = mount(holdFact("hf3", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha3", received, ["hf3: read"]);
  const a = mount(am, {});
  ask(am, "hf3", "read", {});
  f.send({ type: "bump", value: 1 });
  f.send({ type: "bump", value: 2 });
  assert.equal(received.length, 0);
  box.replies[0]({});
  await settle();
  assert.deepEqual(received.map((e) => e.value), [1, 2]);
  unmount(f);
  unmount(a);
});

test("an event emitted between the reply and the release is held too", async () => {
  const box = {};
  const received = [];
  const f = mount(holdFact("hf4", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha4", received, ["hf4: read"]);
  const a = mount(am, {});
  ask(am, "hf4", "read", {});
  box.replies[0]({}); // schedules release as a macrotask
  f.send({ type: "bump", value: 9 }); // still inside the window, synchronously
  assert.equal(received.length, 0);
  await settle();
  assert.deepEqual(received.map((e) => e.value), [9]);
  unmount(f);
  unmount(a);
});

test("two open asks naming the event release it on the last reply", async () => {
  const box = {};
  const received = [];
  const f = mount(holdFact("hf5", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha5", received, ["hf5: read"]);
  const a = mount(am, {});
  ask(am, "hf5", "read", {});
  ask(am, "hf5", "read", {});
  f.send({ type: "bump", value: 1 });
  box.replies[0]({});
  await settle();
  assert.equal(received.length, 0); // second ask still holds it
  box.replies[1]({});
  await settle();
  assert.equal(received.length, 1);
  unmount(f);
  unmount(a);
});

test("an unanswered query releases at once and a late reply holds nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const box = {};
  const received = [];
  const f = mount(holdFact("hf6", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha6", received, ["hf6: read"]);
  const a = mount(am, {});
  ask(am, "hf6", "read", {});
  t.mock.timers.tick(5000); // unanswered → release now
  f.send({ type: "bump", value: 1 });
  assert.equal(received.length, 1); // no hold remains
  box.replies[0]({}); // late reply, holds nothing
  f.send({ type: "bump", value: 2 });
  assert.equal(received.length, 2);
  unmount(f);
  unmount(a);
});

test("an unknown query holds nothing", async () => {
  const box = {};
  const received = [];
  const f = mount(holdFact("hf7", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha7", received, ["hf7: missing"]);
  const a = mount(am, {});
  const reply = await ask(am, "hf7", "missing", {});
  assert.deepEqual(reply, { error: "unknown-query" });
  f.send({ type: "bump", value: 1 });
  assert.equal(received.length, 1); // delivered at once
  unmount(f);
  unmount(a);
});

test("unmount while holding drops the queued events and records it", async () => {
  const box = {};
  const received = [];
  const { records, sub } = collect();
  const f = mount(holdFact("hf8", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha8", received, ["hf8: read"]);
  const a = mount(am, {});
  ask(am, "hf8", "read", {});
  f.send({ type: "bump", value: 1 });
  unmount(a);
  const dropped = records.find((r) => r.outcome === "dropped");
  assert.equal(dropped.name, "thing.changed");
  assert.equal(dropped.reason, "asker unmounted while held");
  assert.deepEqual(dropped.to, ["ha8"]);
  assert.equal(received.length, 0);
  sub();
  unmount(f);
});

test("the tap records the held emission and the release with the exact reasons", async () => {
  const box = {};
  const received = [];
  const { records, sub } = collect();
  const f = mount(holdFact("hf9", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const am = holdAsker("ha9", received, ["hf9: read"]);
  const a = mount(am, {});
  ask(am, "hf9", "read", {});
  const cid = records.find((r) => r.kind === "query" && r.name === "read").cid;
  f.send({ type: "bump", value: 1 });
  const emitRec = records.find((r) => r.kind === "event" && r.name === "thing.changed");
  assert.equal(emitRec.reason, `held for ha9 until reply ${cid}`);
  assert.deepEqual(emitRec.to, ["ha9"]); // recipient kept in `to`
  box.replies[0]({});
  await settle();
  const releaseRec = records.filter((r) => r.kind === "event" && r.name === "thing.changed").at(-1);
  assert.equal(releaseRec.reason, `released after reply ${cid}`);
  assert.deepEqual(releaseRec.to, ["ha9"]);
  assert.equal(releaseRec.outcome, "delivered");
  for (const r of records) for (const k of Object.keys(r)) assert.ok(TRACE_KEYS.has(k), `record key ${k} is in trace.recorded`);
  sub();
  unmount(f);
  unmount(a);
});

test("a released event the asker's state passes on is recorded ignored", async () => {
  const received = [];
  const box = {};
  const { records, sub } = collect();
  const f = mount(holdFact("hf10", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  // Handles thing.changed only in `loading`; by release time it is in `ready`.
  const m = xstateAsker("ha10", "hf10", received, "loading");
  const a = mount(m, { input: { ask: (target, name, payload) => ask(m, target, name, payload) } });
  f.send({ type: "bump", value: 1 });
  await settle(); // let the invoke's ask run and open its hold
  f.send({ type: "bump", value: 2 });
  box.replies.at(-1)({}); // reply → onDone → ready
  await settle();
  const rel = records.filter((r) => r.kind === "event" && r.reason?.startsWith("released")).at(-1);
  assert.equal(rel.outcome, "ignored");
  assert.deepEqual(rel.ignored, ["ha10"]);
  sub();
  unmount(f);
  unmount(a);
});

test("an XState asker sees a superseding event after the reply, in ready not ignored in loading", async () => {
  const received = [];
  const box = {};
  const { records, sub } = collect();
  const f = mount(holdFact("hf11", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const m = xstateAsker("ha11", "hf11", received, "ready");
  const a = mount(m, { input: { ask: (target, name, payload) => ask(m, target, name, payload) } });
  await settle(); // invoke asks, hold opens
  f.send({ type: "bump", value: 5 }); // lands during loading — would be ignored before the hold
  assert.equal(received.length, 0);
  box.replies.at(-1)({}); // reply → ready
  await settle();
  assert.deepEqual(received.map((e) => e.value), [5]); // delivered in ready
  const noIgnore = records.some((r) => r.kind === "event" && r.outcome === "ignored" && r.to.includes("ha11"));
  assert.equal(noIgnore, false);
  sub();
  unmount(f);
  unmount(a);
});

// ── Payload validation (this session) ───────────────────────────────────────
// The bus checks every event, query payload and reply against its schema and refuses a
// wrong one (architecture.md 3.3, 7.2). Strict schemas here so a mismatch is real; a
// sentinel value proves the value never reaches the trace or the console (7.2).
const STRICT_EVENT = {
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false,
};
const STRICT_Q = {
  payload: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
  reply: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false },
};

// A fact that answers `read` by doubling and `ping` with a constant, both to a strict
// reply schema. `read` can be told to answer with a wrong-shaped value, so an invalid
// reply can be provoked while `ping` proves the actor is still running afterwards.
function strictFact(id, readReply) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits: [], owns: "strict" },
    on: {
      "read?": { actions: ({ event }) => event.reply(readReply ?? { value: event.payload.id * 2 }) },
      "ping?": { actions: ({ event }) => event.reply({ value: 1 }) },
    },
  });
}

test("a valid event, query and reply pass and are recorded as before", async () => {
  const { records, sub } = collect();
  const p = mount(producer("v-p"), { events: { "thing.happened": STRICT_EVENT } });
  const c = mount(consumer("v-c", []), {});
  p.send({ type: "go", value: 3 });
  const ev = records.at(-1);
  assert.equal(ev.outcome, "delivered");
  assert.equal(ev.reason, null);
  const f = mount(strictFact("v-f"), { queries: { read: STRICT_Q, ping: STRICT_Q } });
  const a = asker("v-a", ["v-f: read"]);
  assert.deepEqual(await ask(a, "v-f", "read", { id: 5 }), { value: 10 });
  assert.equal(records.filter((r) => r.kind === "query").at(-1).outcome, "asked");
  assert.equal(records.filter((r) => r.kind === "reply").at(-1).outcome, "replied");
  sub();
  unmount(p);
  unmount(c);
  unmount(f);
});

test("an invalid event is refused, recorded, and reaches no subscriber", async () => {
  const { records, sub } = collect();
  const received = [];
  const c = mount(consumer("ie-c", received), {});
  const p = mount(producer("ie-p"), { events: { "thing.happened": STRICT_EVENT } });
  // As with an undeclared emit, XState rethrows the refusal in a macrotask; take over
  // uncaughtException for the moment so node:test does not attribute it to this test.
  const saved = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const caught = new Promise((resolve) => process.once("uncaughtException", resolve));
  p.send({ type: "go", value: "SENSITIVE-9k" }); // value must be an integer
  const err = await caught;
  for (const listener of saved) process.on("uncaughtException", listener);
  assert.match(err.message, /invalid payload/);
  assert.ok(!err.message.includes("SENSITIVE-9k"), "the throw names no value");
  assert.deepEqual(received, []);
  const ref = records.filter((r) => r.kind === "event" && r.name === "thing.happened").at(-1);
  assert.equal(ref.outcome, "refused");
  assert.match(ref.reason, /^invalid payload:/);
  assert.equal(ref.payload, null);
  assert.ok(!JSON.stringify(records).includes("SENSITIVE-9k"), "no record carries the value");
  sub();
  unmount(p);
  unmount(c);
});

test("an invalid query payload is not delivered; the asker gets invalid-payload", async () => {
  const { records, sub } = collect();
  const original = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(" "));
  let handled = false;
  const f = mount(
    createMachine({
      id: "iqp-f",
      meta: { kind: "fact", shape: "local-only", emits: [], owns: "strict" },
      on: { "read?": { actions: ({ event }) => { handled = true; event.reply({ value: 1 }); } } },
    }),
    { queries: { read: STRICT_Q } },
  );
  const a = asker("iqp-a", ["iqp-f: read"]);
  let reply;
  try {
    reply = await ask(a, "iqp-f", "read", { id: "SENSITIVE-x" }); // id must be an integer
  } finally {
    console.error = original;
  }
  assert.deepEqual(reply, { error: "invalid-payload" });
  assert.equal(handled, false, "the fact never saw it");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^bus: invalid query read/);
  assert.ok(!errs[0].includes("SENSITIVE-x"), "the printed line names no value");
  const ref = records.filter((r) => r.kind === "query").at(-1);
  assert.equal(ref.outcome, "refused");
  assert.equal(ref.payload, null);
  assert.ok(!JSON.stringify(records).includes("SENSITIVE-x"), "no record carries the value");
  sub();
  unmount(f);
});

test("an invalid reply is refused; the asker gets invalid-reply and the fact keeps running", async () => {
  const { records, sub } = collect();
  const original = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(" "));
  const f = mount(strictFact("irp-f", { value: "SENSITIVE-r" }), { queries: { read: STRICT_Q, ping: STRICT_Q } });
  const a = asker("irp-a", ["irp-f: read", "irp-f: ping"]);
  let reply;
  try {
    reply = await ask(a, "irp-f", "read", { id: 2 });
  } finally {
    console.error = original;
  }
  assert.deepEqual(reply, { error: "invalid-reply" });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^bus: invalid reply read/);
  assert.ok(!errs[0].includes("SENSITIVE-r"), "the printed line names no value");
  assert.deepEqual(await ask(a, "irp-f", "ping", { id: 0 }), { value: 1 }, "the actor is still running");
  const ref = records.filter((r) => r.kind === "reply" && r.name === "read").at(-1);
  assert.equal(ref.outcome, "refused");
  assert.equal(ref.payload, null);
  assert.ok(!JSON.stringify(records).includes("SENSITIVE-r"), "no record carries the value");
  sub();
  unmount(f);
});

test("record keys stay within the trace's key set for refused-shape records", async () => {
  const { records, sub } = collect();
  const original = console.error;
  console.error = () => {};
  const f = mount(strictFact("rk-f", { value: "x" }), { queries: { read: STRICT_Q, ping: STRICT_Q } });
  const a = asker("rk-a", ["rk-f: read"]);
  try {
    await ask(a, "rk-f", "read", { id: 1 }); // invalid reply
    await ask(a, "rk-f", "read", { id: "no" }); // invalid payload
  } finally {
    console.error = original;
  }
  for (const r of records) for (const k of Object.keys(r)) assert.ok(TRACE_KEYS.has(k), `record key ${k} is in trace.recorded`);
  sub();
  unmount(f);
});

test("compile ignores unknown keywords (x-secret, contentMediaType, description)", () => {
  for (const extra of [{ "x-secret": true }, { contentMediaType: "text/html" }, { description: "for the model" }]) {
    const check = compile({ type: "object", properties: { k: { type: "string", ...extra } }, required: ["k"], additionalProperties: false });
    assert.equal(check({ k: "ok" }), null, `${Object.keys(extra)[0]} does not break a valid value`);
    assert.ok(check({ k: 5 }) !== null, `${Object.keys(extra)[0]} does not stop the known keyword rejecting a wrong value`);
  }
});

// Section 7.2, 3.3: a field a schema marks `"x-secret": true` (an API key) reaches its
// receiver but never a tap, so the trace, the console and other tabs do not carry it.
const SECRET_EVENT = {
  type: "object",
  properties: { key: { type: "string", "x-secret": true }, provider: { type: "string" } },
  required: ["key"],
  additionalProperties: false,
};
const SECRET_Q = {
  payload: { type: "object", properties: { token: { type: "string", "x-secret": true } }, required: ["token"], additionalProperties: false },
  reply: { type: "object", properties: { key: { type: "string", "x-secret": true }, provider: { type: "string" } }, required: ["key"], additionalProperties: false },
};

function secretProducer(id) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits: ["secret.changed"], owns: "a secret fact" },
    on: { go: { actions: emit(({ event }) => ({ type: "secret.changed", key: event.key, provider: "anthropic" })) } },
  });
}

function secretFact(id, seen) {
  return createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", emits: [], owns: "secret" },
    on: {
      "read?": {
        actions: ({ event }) => {
          seen.push(event.payload);
          event.reply({ key: "SENSITIVE-REPLY", provider: "anthropic" });
        },
      },
    },
  });
}

test("a secret event field reaches the receiver but the trace hides it (7.2)", () => {
  const { records, sub } = collect();
  const received = [];
  const p = mount(secretProducer("sec-p"), { events: { "secret.changed": SECRET_EVENT } });
  const c = mount(consumer("sec-c", received, "secret.changed"), {});
  p.send({ type: "go", key: "SENSITIVE-KEY" });
  assert.equal(received[0].key, "SENSITIVE-KEY", "the receiver still gets the real value");
  const rec = records.find((r) => r.kind === "event" && r.name === "secret.changed");
  assert.equal(rec.payload.key, "[secret]", "the trace record hides the secret");
  assert.equal(rec.payload.provider, "anthropic", "a non-secret field is untouched");
  assert.ok(!JSON.stringify(records).includes("SENSITIVE-KEY"), "no record carries the value");
  for (const r of records) for (const k of Object.keys(r)) assert.ok(TRACE_KEYS.has(k), `record key ${k} is in trace.recorded`);
  sub();
  unmount(p);
  unmount(c);
});

test("a secret query payload and reply reach the fact and asker but the trace hides them (7.2)", async () => {
  const { records, sub } = collect();
  const seen = [];
  const f = mount(secretFact("secr-f", seen), { queries: { read: SECRET_Q } });
  const a = asker("secr-a", ["secr-f: read"]);
  const reply = await ask(a, "secr-f", "read", { token: "SENSITIVE-TOKEN" });
  assert.equal(seen[0].token, "SENSITIVE-TOKEN", "the fact still gets the real payload");
  assert.equal(reply.key, "SENSITIVE-REPLY", "the asker still gets the real reply");
  const q = records.find((r) => r.kind === "query" && r.name === "read");
  const rep = records.find((r) => r.kind === "reply" && r.name === "read");
  assert.equal(q.payload.token, "[secret]", "the query record hides the secret payload");
  assert.equal(rep.payload.key, "[secret]", "the reply record hides the secret reply");
  assert.equal(rep.payload.provider, "anthropic", "a non-secret field is untouched");
  assert.ok(!JSON.stringify(records).includes("SENSITIVE-TOKEN"), "no record carries the payload value");
  assert.ok(!JSON.stringify(records).includes("SENSITIVE-REPLY"), "no record carries the reply value");
  sub();
  unmount(f);
});

test("a secret event held for an asker and released is hidden from the trace too (4.2, 7.2)", async () => {
  const { records, sub } = collect();
  // A fact that answers `read` and also emits `secret.changed`, an event a slow asker
  // declares its answer superseded by, so the event is held until the reply lands (4.2).
  const secretHoldFact = createMachine({
    id: "sh-f",
    meta: { kind: "fact", shape: "local-only", emits: ["secret.changed"], owns: "held secret" },
    on: {
      "read?": { actions: ({ event }) => setTimeout(() => event.reply({ ok: true }), 0) },
      leak: { actions: emit(({ event }) => ({ type: "secret.changed", key: event.key, provider: "anthropic" })) },
    },
  });
  const handler = { "secret.changed": { actions: () => {} } };
  const slowAsker = setup({ actors: { q: fromPromise(({ input }) => input.ask("sh-f", "read", {})) } }).createMachine({
    id: "sh-a",
    meta: { kind: "view", emits: [], attributes: [], asks: ["sh-f: read"] },
    context: ({ input }) => ({ ask: input.ask }),
    initial: "loading",
    states: {
      loading: {
        invoke: { src: "q", input: ({ context }) => ({ ask: context.ask }), onDone: "ready", onError: "ready" },
        on: handler,
      },
      ready: { on: handler },
    },
  });
  const f = mount(secretHoldFact, {
    events: { "secret.changed": SECRET_EVENT },
    queries: { read: { payload: {}, reply: {}, supersededBy: ["secret.changed"] } },
  });
  const a = mount(slowAsker, { input: { ask: (t, n, p) => ask(slowAsker, t, n, p) } });
  f.send({ type: "leak", key: "SENSITIVE-HELD" }); // emitted while the asker's read is open → held
  // The reply is deferred, then the release runs a macrotask after it (4.2); poll for it
  // rather than a fixed wait, so a loaded host does not fail the test on timing alone.
  const released = (r) => r.kind === "event" && r.name === "secret.changed" && /released/.test(r.reason ?? "");
  for (let i = 0; i < 40 && !records.some(released); i++) await new Promise((r) => setTimeout(r, 5));
  const rel = records.find(released);
  assert.equal(rel.payload.key, "[secret]", "a released held event hides its secret");
  assert.ok(!JSON.stringify(records).includes("SENSITIVE-HELD"), "no record carries the held value");
  sub();
  unmount(f);
  unmount(a);
});

test("a schema is compiled once per mount: 2000 events validate well within budget", () => {
  const p = mount(producer("perf-p"), { events: { "thing.happened": STRICT_EVENT } });
  const c = mount(consumer("perf-c", []), {});
  const start = performance.now();
  for (let i = 0; i < 2000; i++) p.send({ type: "go", value: i });
  const ms = performance.now() - start;
  assert.ok(ms < 2000, `2000 validated events took ${ms.toFixed(0)}ms — a per-message compile would be far slower`);
  unmount(p);
  unmount(c);
});

// --- Tool asks: the wildcard `*: tool` (architecture.md 7.7) ---------------------
// A query whose schema carries a `tool` entry may be asked by anyone holding the
// wildcard, without declaring the exact key. queryRegistry stores each schema whole,
// so the marker is readable at ask time.
const TOOL_Q = {
  payload: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
  reply: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false },
  tool: { description: "doubles a number", label: "Doubling" },
};

test("a wildcard tool ask reaches a tool-marked query", async () => {
  const f = mount(strictFact("wt-f"), { queries: { read: TOOL_Q, ping: STRICT_Q } });
  const a = asker("wt-a", ["*: tool"]); // no exact "wt-f: read" declared
  assert.deepEqual(await ask(a, "wt-f", "read", { id: 5 }), { value: 10 });
  unmount(f);
});

test("a wildcard tool ask to a query with no tool entry throws", () => {
  const f = mount(strictFact("wt-f2"), { queries: { read: STRICT_Q, ping: STRICT_Q } });
  const a = asker("wt-a2", ["*: tool"]);
  assert.throws(() => ask(a, "wt-f2", "read", { id: 1 }), /undeclared ask/);
  unmount(f);
});

test("a wildcard tool ask to an unmounted target replies no-answerer", async () => {
  const a = asker("wt-a3", ["*: tool"]);
  assert.deepEqual(await ask(a, "nobody", "read", { id: 1 }), { error: "no-answerer" });
});

test("a wildcard tool ask aimed at a view throws", () => {
  const v = mount(consumer("wt-v", []), {});
  const a = asker("wt-a4", ["*: tool"]);
  assert.throws(() => ask(a, "wt-v", "read", { id: 1 }), /undeclared ask/);
  unmount(v);
});

test("an invalid payload on a wildcard tool ask is refused quietly (no console.error)", async () => {
  const { records, sub } = collect();
  const original = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.join(" "));
  let handled = false;
  const f = mount(
    createMachine({
      id: "wt-f5",
      meta: { kind: "fact", shape: "local-only", emits: [], owns: "strict" },
      on: { "read?": { actions: ({ event }) => { handled = true; event.reply({ value: 1 }); } } },
    }),
    { queries: { read: TOOL_Q } },
  );
  const a = asker("wt-a5", ["*: tool"]);
  let reply;
  try {
    reply = await ask(a, "wt-f5", "read", { id: "not-an-int" }); // id must be an integer
  } finally {
    console.error = original;
  }
  assert.deepEqual(reply, { error: "invalid-payload" });
  assert.equal(handled, false, "the fact never saw it");
  assert.equal(errs.length, 0, "a model's wrong tool input is expected traffic, not a defect to shout about");
  const ref = records.filter((r) => r.kind === "query").at(-1);
  assert.equal(ref.outcome, "refused");
  sub();
  unmount(f);
});

// Named instances (4.1): a page may hold more than one instance of a view, told
// apart by an id after `#`. The bus keys the mailbox, the emits and the holds by
// the address, so two instances of one view do not share them. A view emits and
// asks with its instance; a fact has one owner (4.3) and cannot be instanced.

// A view that emits, for the emit-from-instance record test.
function viewProducer(id) {
  return createMachine({
    id,
    meta: { kind: "view", emits: ["thing.happened"], attributes: [] },
    on: { go: { actions: emit(({ event }) => ({ type: "thing.happened", value: event.value })) } },
  });
}

test("two instances of one view each get their own mailbox and are named in the record", () => {
  const ra = [];
  const rb = [];
  const { records, sub } = collect();
  const a = mount(consumer("c", ra), { instance: "a" });
  const b = mount(consumer("c", rb), { instance: "b" });
  const p = mount(producer("cp"), { events: { "thing.happened": SCHEMA } });
  p.send({ type: "go", value: 5 });
  assert.deepEqual(ra, [{ type: "thing.happened", value: 5 }]);
  assert.deepEqual(rb, [{ type: "thing.happened", value: 5 }]);
  const rec = records.find((r) => r.kind === "event" && r.name === "thing.happened" && r.from === "cp");
  assert.deepEqual(rec.to.sort(), ["c#a", "c#b"]);
  sub();
  unmount(a);
  unmount(b);
  unmount(p);
});

test("the same address twice throws; an instance beside the plain name is allowed", () => {
  const a = mount(consumer("c", []), { instance: "a" });
  assert.throws(() => mount(consumer("c", []), { instance: "a" }), /already mounted: c#a/);
  const plain = mount(consumer("c", []), {});
  assert.ok(plain);
  unmount(a);
  unmount(plain);
});

test("a fact cannot be instanced; a bad instance string is refused", () => {
  assert.throws(
    () => mount(producer("fp"), { events: { "thing.happened": SCHEMA }, instance: "x" }),
    /a fact has one owner/,
  );
  assert.throws(() => mount(consumer("c", []), { instance: "1bad" }), /bad instance "1bad"/);
  assert.throws(() => mount(consumer("c", []), { instance: "a b" }), /bad instance "a b"/);
});

test("an emit from an instance records the instance address as `from`", () => {
  const { records, sub } = collect();
  const p = mount(viewProducer("vp"), { instance: "x", events: { "thing.happened": SCHEMA } });
  p.send({ type: "go", value: 1 });
  const rec = records.find((r) => r.kind === "event" && r.name === "thing.happened");
  assert.equal(rec.from, "vp#x");
  sub();
  unmount(p);
});

test("a hold is per instance: a superseding event waits for the instance that asked, not its sibling", async () => {
  const box = {};
  const recA = [];
  const recB = [];
  const f = mount(holdFact("hf-i", box), { events: { "thing.changed": SCHEMA, "other.changed": SCHEMA }, queries: { read: HSCHEMA } });
  const ma = holdAsker("hi", recA, ["hf-i: read"]);
  const mb = holdAsker("hi", recB, ["hf-i: read"]);
  const a = mount(ma, { instance: "a" });
  const b = mount(mb, { instance: "b" });
  const pending = ask(ma, "hf-i", "read", {}, "a"); // only #a has an open ask
  f.send({ type: "bump", value: 1 });
  assert.equal(recB.length, 1); // #b is not asking: delivered now
  assert.equal(recA.length, 0); // #a is asking: held until its reply
  box.replies[0]({ ok: true });
  await pending;
  await settle();
  assert.equal(recA.length, 1); // released after #a's reply
  unmount(f);
  unmount(a);
  unmount(b);
});

// Commands (4.4): a sender names one address and a command it declared in
// `meta.sends`; the acceptor passed the command's schema at mount. No reply comes, so
// every way a command fails to arrive is a record on the tap.
const LOAD = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

function acceptor(id, received) {
  return createMachine({
    id,
    meta: { kind: "view", emits: [], attributes: [] },
    on: { load: { actions: ({ event }) => received.push(event) } },
  });
}

function sender(id, sends = ["ed: load"]) {
  return createMachine({ id, meta: { kind: "view", emits: [], attributes: [], sends } });
}

test("a command reaches only the addressed instance, as { type, ...payload }", () => {
  const ra = [];
  const rb = [];
  const a = mount(acceptor("ed", ra), { commands: { load: LOAD }, instance: "stage" });
  const b = mount(acceptor("ed", rb), { commands: { load: LOAD }, instance: "side" });
  const { records, sub } = collect();
  send(sender("st"), "ed#stage", "load", { id: "n1" }, "main");
  sub();
  assert.deepEqual(ra, [{ id: "n1", type: "load" }]);
  assert.deepEqual(rb, []);
  const r = records.find((x) => x.kind === "command");
  assert.equal(r.outcome, "delivered");
  assert.equal(r.from, "st#main");
  assert.deepEqual(r.to, ["ed#stage"]);
  assert.deepEqual(r.payload, { id: "n1" });
  unmount(a);
  unmount(b);
});

test("an undeclared send is refused on the tap and throws", () => {
  const received = [];
  const a = mount(acceptor("ed", received), { commands: { load: LOAD } });
  const { records, sub } = collect();
  assert.throws(() => send(sender("st", []), "ed", "load", { id: "n1" }), /undeclared send/);
  sub();
  assert.deepEqual(received, []);
  assert.equal(records[0].outcome, "refused");
  assert.equal(records[0].reason, "undeclared send");
  unmount(a);
});

test("a command whose payload fails its schema is not delivered", (t) => {
  t.mock.method(console, "error", () => {});
  const received = [];
  const a = mount(acceptor("ed", received), { commands: { load: LOAD } });
  const { records, sub } = collect();
  send(sender("st"), "ed", "load", { id: 7 });
  sub();
  assert.deepEqual(received, []);
  assert.equal(records[0].outcome, "refused");
  assert.match(records[0].reason, /^invalid payload/);
  assert.equal(records[0].payload, null);
  unmount(a);
});

test("a command to an address nobody mounted is dropped", () => {
  const { records, sub } = collect();
  send(sender("st"), "ed#nowhere", "load", { id: "n1" });
  sub();
  assert.equal(records[0].kind, "command");
  assert.equal(records[0].outcome, "dropped");
  assert.equal(records[0].reason, "nobody mounted at this address");
});

test("a command the target does not accept is dropped", () => {
  const a = mount(acceptor("ed", []), { commands: { load: LOAD } });
  const { records, sub } = collect();
  send(sender("st", ["ed: focus"]), "ed", "focus");
  sub();
  assert.equal(records[0].outcome, "dropped");
  assert.equal(records[0].reason, "the target does not accept it");
  unmount(a);
});

test("a command whose schema the target did not pass at mount is dropped", () => {
  const received = [];
  // A fresh name: the bus keeps a component's schemas after unmount, as it does events'.
  const a = mount(acceptor("bare", received), {});
  const { records, sub } = collect();
  send(sender("st", ["bare: load"]), "bare", "load", { id: "n1" });
  sub();
  assert.deepEqual(received, []);
  assert.equal(records[0].outcome, "dropped");
  assert.equal(records[0].reason, "no schema passed for it at mount");
  unmount(a);
});

test("mount refuses a command schema for a command the machine does not accept", () => {
  assert.throws(() => mount(acceptor("ed", []), { commands: { open: LOAD } }), /does not accept/);
});

test("a command the target's state passes on is recorded as ignored", () => {
  const m = createMachine({
    id: "gate",
    meta: { kind: "view", emits: [], attributes: [] },
    initial: "closed",
    states: { closed: {}, open: { on: { load: { actions: () => {} } } } },
  });
  const a = mount(m, { commands: { load: LOAD } });
  const { records, sub } = collect();
  send(sender("st", ["gate: load"]), "gate", "load", { id: "n1" });
  sub();
  assert.equal(records[0].outcome, "ignored");
  assert.deepEqual(records[0].ignored, ["gate"]);
  unmount(a);
});

test("answers says whether a mounted fact answers a query on this page (7.7)", () => {
  assert.equal(answers("ansq", "read"), false, "nobody mounted");
  const f = mount(fact("ansq"), { queries: { read: QSCHEMA, twice: QSCHEMA } });
  assert.equal(answers("ansq", "read"), true);
  assert.equal(answers("ansq", "other"), false, "a query the fact does not answer");
  unmount(f);
  assert.equal(answers("ansq", "read"), false, "unmounted");
});
