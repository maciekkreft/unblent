import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): values, real, on the real bus with its real schemas. A stand-in mounted
// with values-sheet's own event schema saves and asks the way that view does, so each
// step is sent by hand and every payload and reply is checked against its contract.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const pad = (n) => String(n).padStart(2, "0");
const d = new Date();
const TODAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parent = { id: "01ARZ3NDEKTSV4RRFFQ69G5VA1", name: "Being a present parent", meaning: "" };

const memory = () => {
  const rows = new Map();
  return {
    rows,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.day, r),
    placesAll: async () => [],
    placePut: async () => {},
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const sheetSchema = (name) => JSON.parse(readFileSync(new URL(`../../values-sheet/events/${name}.json`, import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-sheet",
    meta: { kind: "view", emits: ["values.saved", "values.placed"], asks: ["values: read", "values: versions"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "values.changed": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, { events: { "values.saved": sheetSchema("values.saved"), "values.placed": sheetSchema("values.placed") } });
  return { actor, read: (payload) => ask(machine, "values", "read", payload), versions: () => ask(machine, "values", "versions", {}) };
}

test("the sheet's save reaches values, and read and versions answer what was saved", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["values"], { values: { store, now: () => Date.now() } });
  const heard = [];
  const sheet = standIn(heard);
  try {
    await until(() => actors.values.getSnapshot().matches("ready"));
    sheet.actor.send({ type: "go", body: { type: "values.saved", day: TODAY, values: [parent] } });
    await until(() => heard.length === 1);
    assert.deepEqual(heard[0].values, [parent]);
    assert.deepEqual(await sheet.read({}), { day: TODAY, values: [parent], changedSince: false });
    assert.deepEqual(await sheet.read({ day: "2000-01-01" }), { day: null, values: [], changedSince: true, placed: false });
    assert.deepEqual(await sheet.versions(), { days: [] }, "today's is the current version, not an earlier one");
  } finally {
    unmount(sheet.actor);
    unwire();
  }
});

test("the sheet's placement reaches values, which announces it and answers it for the day", async () => {
  const { actors, unwire } = await wire(["values"], { values: { store: memory(), now: () => Date.now() } });
  const heard = [];
  const sheet = standIn(heard);
  try {
    await until(() => actors.values.getSnapshot().matches("ready"));
    sheet.actor.send({ type: "go", body: { type: "values.placed", day: TODAY, placed: true } });
    await until(() => heard.length === 1);
    assert.deepEqual({ ...heard[0], type: undefined }, { type: undefined, day: TODAY, values: [], placed: true });
    assert.equal((await sheet.read({ day: TODAY })).placed, true);
    sheet.actor.send({ type: "go", body: { type: "values.placed", day: TODAY, placed: false } });
    await until(() => heard.length === 2);
    assert.equal((await sheet.read({ day: TODAY })).placed, false);
  } finally {
    unmount(sheet.actor);
    unwire();
  }
});
