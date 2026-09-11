import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, emit } from "xstate";
import { mount, unmount, ask } from "bus";

// The bus is infrastructure, not a component, so it is tested here rather than
// under components/. Fake machines stand in for real ones: a producer that emits
// on an internal (dot-free) event, a consumer that records what the bus delivers.
// The bus checks event names only; any truthy value serves as a schema.
const SCHEMA = {};

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
  const f = mount(fact("f1"), {});
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
  const f = mount(slow, {});
  const a = asker("a2", ["f2: read"]);
  const both = await Promise.all([ask(a, "f2", "read", { id: 1 }), ask(a, "f2", "read", { id: 2 })]);
  assert.deepEqual(both, [{ value: 1 }, { value: 2 }]);
  assert.equal(cids.length, 2);
  assert.notEqual(cids[0], cids[1]);
  unmount(f);
});

test("an undeclared ask throws", () => {
  const f = mount(fact("f3"), {});
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
  const f = mount(fact("f6"), {});
  const a = asker("a6", ["f6: write"]);
  assert.deepEqual(await ask(a, "f6", "write", {}), { error: "unknown-query" });
  unmount(f);
});

test("the first reply wins; a second call is ignored", async () => {
  const f = mount(fact("f7"), {});
  const a = asker("a7", ["f7: twice"]);
  assert.deepEqual(await ask(a, "f7", "twice"), { first: true });
  unmount(f);
});
