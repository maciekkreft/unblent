import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): experts, real, on the real bus with its real schemas. A stand-in mounted
// with expert-settings' own event schema edits and asks the way that view will, so each
// step is sent by hand.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";

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

const edited = JSON.parse(readFileSync(new URL("../../expert-settings/events/expert.edited.json", import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-expert-settings",
    meta: { kind: "view", emits: ["expert.edited"], asks: ["experts: list"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "expert.changed": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, { events: { "expert.edited": edited } });
  return { actor, list: () => ask(machine, "experts", "list", {}) };
}

test("an edit in the tab reaches experts, and list answers what was kept", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["experts"], { experts: { store } });
  const heard = [];
  const view = standIn(heard);
  try {
    await until(() => actors.experts.getSnapshot().matches("ready"));
    assert.deepEqual(await view.list(), { experts: [] });
    view.actor.send({ type: "go", body: { type: "expert.edited", id: BOOK, prompt: "Stoic", left: true } });
    view.actor.send({ type: "go", body: { type: "expert.edited", id: BOOK, on: true } });
    await until(() => heard.length === 2);
    assert.deepEqual(heard.at(-1).expert, { id: BOOK, prompt: "Stoic", on: true, version: 2 });
    assert.deepEqual(await view.list(), { experts: [{ id: BOOK, prompt: "Stoic", on: true, version: 2 }] });
    assert.equal(store.rows.get(BOOK).on, true);
  } finally {
    unmount(view.actor);
    unwire();
  }
});
