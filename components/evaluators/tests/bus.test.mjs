import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): evaluators and notice-stack, both real, on the real bus with their real
// schemas. No component emits removal.started yet (the evaluator editor will), so a
// stand-in that declares it, with the shape removal.undone has plus the thing's name,
// starts the removal the way the editor will.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";

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

function standIn() {
  const undone = JSON.parse(readFileSync(new URL("../../notice-stack/events/removal.undone.json", import.meta.url)));
  const started = { ...undone, properties: { ...undone.properties, name: { type: "string" } }, required: [...undone.required, "name"] };
  const machine = setup({}).createMachine({
    id: "test-remover",
    meta: { kind: "view", emits: ["removal.started"], attributes: [] },
    on: { go: { actions: emit(({ event }) => ({ type: "removal.started", ...event.body })) } },
  });
  return mount(machine, { events: { "removal.started": started } });
}

test("an evaluator's removal waits in notice-stack: Undo brings it back, the window running out deletes it", async () => {
  const store = memory();
  store.rows.set(ID, { id: ID, book: BOOK, name: "Goals", on: true, questions: [], version: 1 });
  const { actors, unwire } = await wire(["evaluators", "notice-stack"], {
    evaluators: { store },
    "notice-stack": { fadeMs: 60 },
  });
  const remover = standIn();
  const removing = () => store.rows.get(ID).removing;
  try {
    const stack = actors["notice-stack"];
    await until(() => actors.evaluators.getSnapshot().matches("ready"));
    remover.send({ type: "go", body: { kind: "evaluator", id: ID, name: "Goals" } });
    await until(() => removing() === true);
    stack.send({ type: "_act", key: `removal:evaluator:${ID}`, index: 0 });
    await until(() => removing() === false);
    assert.ok(!store.rows.get(ID).deleted);

    remover.send({ type: "go", body: { kind: "evaluator", id: ID, name: "Goals" } });
    await until(() => store.rows.get(ID).deleted === true);
    assert.equal(store.rows.get(ID).version, 2);
  } finally {
    unmount(remover);
    unwire();
  }
});
