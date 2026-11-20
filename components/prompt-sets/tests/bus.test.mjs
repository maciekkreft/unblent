import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): prompt-sets, real, on the real bus with its real schemas. A stand-in
// mounted with prompt-settings' own event schema saves and asks the way that view will,
// so each step is sent by hand.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";

const memory = () => {
  const rows = new Map();
  return {
    rows,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    putAll: async (sets) => void sets.forEach((r) => rows.set(r.id, r)),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const settingsSchema = (name) => JSON.parse(readFileSync(new URL(`../../prompt-settings/events/${name}.json`, import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-prompt-settings",
    meta: { kind: "view", emits: ["prompt-set.saved"], asks: ["prompt-sets: list"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "prompt-set.changed": { actions: ({ event }) => heard.push(event) },
      "prompt-set.deleted": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, { events: { "prompt-set.saved": settingsSchema("prompt-set.saved") } });
  return { actor, list: () => ask(machine, "prompt-sets", "list", {}) };
}

test("the view's saves reach prompt-sets, and its list answers the starters and what was saved", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["prompt-sets"], { "prompt-sets": { store } });
  const heard = [];
  const view = standIn(heard);
  try {
    await until(() => actors["prompt-sets"].getSnapshot().matches("ready"));
    assert.equal((await view.list()).sets.length, 10, "the starter sets");
    const body = { type: "prompt-set.saved", id: ID, name: "Mine", occasion: "", basedOn: "", prompts: ["How was today?"], position: "1" };
    view.actor.send({ type: "go", body });
    await until(() => heard.some((e) => e.set?.id === ID));
    assert.deepEqual((await view.list()).sets[0].prompts, ["How was today?"]);

    view.actor.send({ type: "go", body: { ...body, deleted: true } });
    await until(() => heard.at(-1).type === "prompt-set.deleted");
    assert.equal(store.rows.get(ID).deleted, true);
    assert.equal((await view.list()).sets.length, 10);
  } finally {
    unmount(view.actor);
    unwire();
  }
});
