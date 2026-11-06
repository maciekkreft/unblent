import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): wheels, real, on the real bus with its real schemas. A stand-in mounted
// with wheel-sheet's own event schema saves and asks the way that view does, so each step
// is sent by hand.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const NONE = Array(8).fill(null);
const ACTUAL = [6, null, null, null, null, null, null, null];
const ANSWERS = [{ one: "In bed all day", closer: "Walk" }, {}, {}, {}, {}, {}, {}, {}];
const EMPTY = Array(8).fill({});

const memory = () => {
  const rows = new Map();
  return {
    rows,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const savedSchema = JSON.parse(readFileSync(new URL("../../wheel-sheet/events/wheel.saved.json", import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-sheet",
    meta: { kind: "view", emits: ["wheel.saved"], asks: ["wheels: list"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "wheel.changed": { actions: ({ event }) => heard.push(event) },
      "wheel.deleted": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, { events: { "wheel.saved": savedSchema } });
  return { actor, list: (payload) => ask(machine, "wheels", "list", payload) };
}

test("the view's saves reach wheels, and its list answers what was saved", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["wheels"], { wheels: { store } });
  const heard = [];
  const sheet = standIn(heard);
  try {
    await until(() => actors.wheels.getSnapshot().matches("ready"));
    const body = { type: "wheel.saved", id: ID, day: DAY, actual: ACTUAL, wanted: NONE, finished: true };
    sheet.actor.send({ type: "go", body });
    await until(() => heard.length === 1);
    assert.deepEqual(heard[0].wheel.actual, ACTUAL);
    const reply = await sheet.list({ day: DAY });
    assert.deepEqual(reply.wheels.map((w) => w.id), [ID]);
    assert.equal((await sheet.list({})).wheels.length, 1);

    sheet.actor.send({ type: "go", body: { ...body, actual: NONE } });
    await until(() => heard.at(-1).type === "wheel.deleted");
    assert.equal(store.rows.get(ID).deleted, true);
  } finally {
    unmount(sheet.actor);
    unwire();
  }
});

test("answers pass every schema on the bus, and a wheel saved without them lists eight empty ones", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["wheels"], { wheels: { store } });
  const heard = [];
  const sheet = standIn(heard);
  try {
    await until(() => actors.wheels.getSnapshot().matches("ready"));
    const body = { type: "wheel.saved", id: ID, day: DAY, actual: ACTUAL, wanted: NONE };
    sheet.actor.send({ type: "go", body });
    await until(() => heard.length === 1);
    assert.deepEqual(heard[0].wheel.answers, EMPTY);
    assert.deepEqual((await sheet.list({ day: DAY })).wheels[0].answers, EMPTY);

    sheet.actor.send({ type: "go", body: { ...body, answers: ANSWERS, finished: true } });
    await until(() => heard.length === 2);
    assert.deepEqual(heard[1].wheel.answers, ANSWERS);
    assert.deepEqual((await sheet.list({})).wheels[0].answers, ANSWERS);
  } finally {
    unmount(sheet.actor);
    unwire();
  }
});
