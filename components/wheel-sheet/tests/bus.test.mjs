import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The kit (10): wheel-sheet with wheels, real machines on the real bus. The user's gestures
// are sent to the view's actor the way its view forwards them, and the store is faked;
// `undo` is not wired, so a step is undone by sending the fact what `undo` sends it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, send, ask } = await import("bus");
const { setup } = await import("xstate");

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const DAY = "2026-10-14";
const EARLIER = "2026-10-06";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const OLD = "01ARZ3NDEKTSV4RRFFQ69G5CP0";
const NONE = Array(8).fill(null);
const WANTED = [9, 7, 6, 8, 7, 6, 7, 6];
const ACTUAL = [6, 5, 4, 7, 3, 6, 5, 2];

const memory = (rows = []) => {
  const held = new Map(rows.map((r) => [r.id, r]));
  return {
    held,
    all: async () => [...held.values()],
    put: async (r) => void held.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const old = { id: OLD, day: EARLIER, actual: ACTUAL, wanted: WANTED, version: 1 };
const today = { id: ID, day: DAY, actual: ACTUAL, wanted: WANTED, version: 1 };

async function both(rows) {
  const store = memory(rows);
  const wired = await wire(["wheels", "wheel-sheet"], {
    wheels: { store },
    "wheel-sheet": { mint: () => ID, now: () => NOW, throttleMs: 5 },
  });
  const sheet = wired.actors["wheel-sheet"];
  const steps = () => wired.records.filter((r) => r.kind === "event" && r.name === "step.recorded").map((r) => r.payload);
  await until(() => sheet.getSnapshot().matches("ready"));
  // The bus holds what supersedes the list until a macrotask after its reply (4.2).
  await new Promise((r) => setTimeout(r, 0));
  await until(() => wired.actors.wheels.getSnapshot().matches("ready"));
  return { ...wired, store, sheet, steps, ctx: () => sheet.getSnapshot().context };
}

test("a new wheel takes Wanted from the fact's newest earlier one, and one left untouched leaves no trace", async () => {
  const { sheet, store, steps, ctx, unwire } = await both([old]);
  try {
    sheet.send({ type: "add" });
    assert.deepEqual(ctx().draft.wanted, WANTED);
    sheet.send({ type: "_done" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.held.has(ID), false);
    assert.deepEqual(steps(), []);
  } finally {
    unwire();
  }
});

test("rating is one step, the next opening another; Delete is a step with the notice, and its Undo shows the card with what was saved", async () => {
  const { actors, sheet, store, steps, ctx, unwire } = await both([]);
  try {
    sheet.send({ type: "add" });
    sheet.send({ type: "_press", area: 0, value: 6 });
    await until(() => store.held.get(ID)?.actual[0] === 6);
    await new Promise((r) => setTimeout(r, 0));
    sheet.send({ type: "_press", area: 1, value: 5 });
    sheet.send({ type: "_done" });
    await until(() => store.held.get(ID)?.actual[1] === 5);
    assert.deepEqual(ctx().wheels.map((w) => w.id), [ID]);
    const count = steps().length;
    assert.equal(new Set(steps().map((s) => s.id)).size, 1, "one stretch of rating is one step");
    assert.ok(count >= 1);

    sheet.send({ type: "_open", id: ID });
    sheet.send({ type: "_press", area: 2, value: 4 });
    sheet.send({ type: "_delete" });
    await until(() => store.held.get(ID)?.deleted === true);
    assert.deepEqual(ctx().wheels, []);
    assert.equal(ctx().draft, null);
    const removal = steps().at(-1);
    assert.equal(removal.notice, true);
    assert.equal(new Set(steps().map((s) => s.id)).size, 3, "the first rating, the second, and the delete");

    actors.wheels.send({ type: "step.undone", id: removal.id, owner: "wheels", payload: removal.undo });
    await until(() => ctx().wheels.length === 1);
    assert.equal(ctx().wheels[0].id, ID);
    assert.equal(ctx().wheels[0].actual[2], 4, "what was waiting came back too");
    assert.equal(ctx().draft, null, "it comes back folded");
  } finally {
    unwire();
  }
});

test("clearing the last score holds the save, and the fold deletes the kept wheel with the notice", async () => {
  const kept = { ...today, actual: [6, ...NONE.slice(1)], wanted: NONE };
  const { sheet, store, steps, ctx, unwire } = await both([kept]);
  try {
    sheet.send({ type: "_open", id: ID });
    sheet.send({ type: "_press", area: 0, value: 6 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.held.get(ID).deleted, undefined, "nothing is deleted while rating");
    assert.deepEqual(steps(), []);
    sheet.send({ type: "_done" });
    await until(() => store.held.get(ID).deleted === true);
    assert.equal(steps().at(-1).notice, true);
    assert.deepEqual(ctx().wheels, []);
  } finally {
    unwire();
  }
});

test("the add command reaches the sheet through the bus with the schema the view passes at mount, from a sender that declares it", async () => {
  const { machine } = await import("../machine.js");
  const schema = JSON.parse(readFileSync(new URL("../commands/add.json", import.meta.url), "utf8"));
  const saved = JSON.parse(readFileSync(new URL("../events/wheel.saved.json", import.meta.url), "utf8"));
  const { actors, unwire } = await wire(["wheels"], { wheels: { store: memory([old]) } });
  const sheet = mount(machine, {
    input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: () => ID, now: () => NOW },
    events: { "wheel.saved": saved },
    commands: { add: schema },
  });
  const picker = setup({}).createMachine({ id: "test-picker", meta: { kind: "view", emits: [], sends: ["wheel-sheet: add"], attributes: [] } });
  const other = setup({}).createMachine({ id: "test-other", meta: { kind: "view", emits: [], attributes: [] } });
  const senders = [mount(picker, {}), mount(other, {})];
  try {
    await until(() => actors.wheels.getSnapshot().matches("ready") && sheet.getSnapshot().matches("ready"));
    assert.throws(() => send(other, "wheel-sheet", "add", {}), "a sender that does not declare it is refused");
    assert.equal(sheet.getSnapshot().context.draft, null);
    send(picker, "wheel-sheet", "add", {});
    assert.equal(sheet.getSnapshot().context.draft.id, ID);
    assert.deepEqual(sheet.getSnapshot().context.draft.wanted, WANTED);
    assert.equal(sheet.getSnapshot().context.landing, 1);
  } finally {
    senders.forEach(unmount);
    unmount(sheet);
    unwire();
  }
});
