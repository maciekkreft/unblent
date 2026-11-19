import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The kit (10): matrix-sheet with matrices, real machines on the real bus. The user's gestures
// are sent to the view's actor the way its view forwards them, and the store is faked; `undo`
// is not wired, so a step is undone by sending the fact what `undo` sends it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask, send } = await import("bus");

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const DAY = "2026-10-14";
const EARLIER = "2026-10-12";
const OLD = "01ARZ3NDEKTSV4RRFFQ69G5CP0";
const T1 = "01ARZ3NDEKTSV4RRFFQ69G5TA1";
const T2 = "01ARZ3NDEKTSV4RRFFQ69G5TA2";

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

const json = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

const old = {
  id: OLD,
  day: EARLIER,
  tasks: [
    { id: T1, text: "Renew the passport", place: "schedule", done: false, suggested: { place: "schedule", sure: true } },
    { id: T2, text: "Pay the bill", place: "do", done: true },
  ],
  createdAt: "2026-10-12T08:00:00.000Z",
  version: 1,
};

async function both(rows) {
  const store = memory(rows);
  const wired = await wire(["matrices"], { matrices: { store, now: () => NOW } });
  const { machine } = await import("../machine.js");
  let n = 0;
  const sheet = mount(machine, {
    input: {
      ask: (target, name, payload) => ask(machine, target, name, payload),
      send: (target, name, payload) => send(machine, target, name, payload),
      mint: () => `01ARZ3NDEKTSV4RRFFQ69G5N${String(++n).padStart(2, "0")}`,
      now: () => NOW,
    },
    events: { "matrix.saved": json("matrix-sheet/events/matrix.saved.json") },
    commands: { add: json("matrix-sheet/commands/add.json") },
  });
  const steps = () => wired.records.filter((r) => r.kind === "event" && r.name === "step.recorded").map((r) => r.payload);
  await until(() => sheet.getSnapshot().matches("ready") && wired.actors.matrices.getSnapshot().matches("ready"));
  await new Promise((r) => setTimeout(r, 0));
  const finish = () => {
    unmount(sheet);
    wired.unwire();
  };
  return { ...wired, store, sheet, steps, finish, ctx: () => sheet.getSnapshot().context };
}

test("a new day's matrix is a copy without the ticked tasks, kept at once with its suggestion as one step whose Undo takes it away", async () => {
  const { actors, sheet, store, steps, ctx, finish } = await both([old]);
  try {
    sheet.send({ type: "add" });
    await until(() => ctx().matrices.some((m) => m.day === DAY));
    assert.equal(ctx().fresh, null, "what the fact keeps replaces the copy");
    const kept = ctx().matrices.find((m) => m.day === DAY);
    const { id } = kept;
    assert.ok(store.held.has(id));
    assert.equal(kept.from, EARLIER);
    assert.deepEqual(kept.tasks, [{ id: T1, text: "Renew the passport", place: "schedule", done: false, suggested: { place: "schedule", sure: true } }]);
    const [add] = steps();
    assert.equal(add.label, "add Eisenhower Matrix");
    actors.matrices.send({ type: "step.undone", id: add.id, owner: "matrices", payload: add.undo });
    await until(() => !ctx().matrices.some((m) => m.id === id));
    assert.equal(ctx().open, false, "the sheet of a matrix taken away closes");
  } finally {
    finish();
  }
});

test("deleting the last task keeps the matrix until the whole sheet is explicitly removed", async () => {
  const { sheet, steps, ctx, finish } = await both([]);
  try {
    sheet.send({ type: "add" });
    sheet.send({ type: "_add", text: "One\nTwo" });
    await until(() => ctx().matrices.length === 1);
    const [first, second] = ctx().matrices[0].tasks;
    sheet.send({ type: "_tick", id: first.id });
    sheet.send({ type: "_delete", id: first.id });
    assert.deepEqual([steps().at(-1).label, steps().at(-1).notice], ["delete task", true]);
    assert.equal(steps().at(-2).notice, undefined, "a tick asks for none");
    sheet.send({ type: "_delete", id: second.id });
    await until(() => ctx().matrices[0]?.tasks.length === 0);
    assert.equal(ctx().open, true);
    assert.deepEqual([steps().at(-1).label, steps().at(-1).notice], ["delete task", true]);
    sheet.send({ type: "_discard" });
    await until(() => ctx().matrices.length === 0);
    assert.deepEqual([steps().at(-1).label, steps().at(-1).notice], ["delete Eisenhower Matrix", true]);
  } finally {
    finish();
  }
});
