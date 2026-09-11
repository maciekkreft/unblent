import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, emit } from "xstate";
import { mount, unmount, ask, tap } from "bus";

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
  assert.equal(query.outcome, "asked");
  assert.deepEqual(query.to, ["t6"]);
  assert.equal(reply.outcome, "replied");
  assert.equal(reply.from, "t6");
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
