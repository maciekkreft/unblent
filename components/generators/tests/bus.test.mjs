import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): generators, real, on the real bus with its real schemas. A stand-in
// mounted with generator-settings' own event schema edits and asks the way that view
// will, so each step is sent by hand.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

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

const settingsSchema = (name) => JSON.parse(readFileSync(new URL(`../../generator-settings/events/${name}.json`, import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-generator-settings",
    meta: { kind: "view", emits: ["generator.edited"], asks: ["generators: list", "generators: results"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "generator.changed": { actions: ({ event }) => heard.push(event) },
      "generation.changed": { actions: () => {} },
    },
  });
  const actor = mount(machine, { events: { "generator.edited": settingsSchema("generator.edited") } });
  return {
    actor,
    list: () => ask(machine, "generators", "list", {}),
    results: (generator) => ask(machine, "generators", "results", { generator }),
  };
}

test("an edit in the tab reaches generators, and list answers what was kept", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["generators"], { generators: { store } });
  const heard = [];
  const view = standIn(heard);
  try {
    await until(() => actors.generators.getSnapshot().matches("ready"));
    assert.equal((await view.list()).generators.length, 2);
    view.actor.send({ type: "go", body: { type: "generator.edited", id: "journal-summary", on: false } });
    await until(() => heard.length === 1);
    assert.deepEqual([heard[0].generator.id, heard[0].generator.on], ["journal-summary", false]);
    assert.equal((await view.list()).generators[1].on, false);
    assert.equal(store.rows.get("journal-summary").on, false);
    assert.deepEqual(await view.results("chat-title"), { results: [] });
  } finally {
    unmount(view.actor);
    unwire();
  }
});
