import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): choice-points, real, on the real bus with its real schemas. A stand-in
// mounted with choice-point-cards' own event schema saves and asks the way that
// view does, so each step is sent by hand.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";

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

const cardsSchema = (name) => JSON.parse(readFileSync(new URL(`../../choice-point-cards/events/${name}.json`, import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-cards",
    meta: { kind: "view", emits: ["choice-point.saved"], asks: ["choice-points: list"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "choice-point.changed": { actions: ({ event }) => heard.push(event) },
      "choice-point.deleted": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, {
    events: { "choice-point.saved": cardsSchema("choice-point.saved") },
  });
  return { actor, list: (payload) => ask(machine, "choice-points", "list", payload) };
}

test("the view's saves reach choice-points, and its list answers what was saved", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["choice-points"], { "choice-points": { store } });
  const heard = [];
  const cards = standIn(heard);
  try {
    await until(() => actors["choice-points"].getSnapshot().matches("ready"));
    const body = { type: "choice-point.saved", id: ID, day: DAY, situation: "Meeting ran late", thoughts: "", away: "", towards: "Paused" };
    cards.actor.send({ type: "go", body });
    await until(() => heard.length === 1);
    assert.equal(heard[0].choicePoint.towards, "Paused");
    const reply = await cards.list({ day: DAY });
    assert.deepEqual(reply.choicePoints.map((c) => c.id), [ID]);
    assert.deepEqual((await cards.list({})).choicePoints.length, 1);

    cards.actor.send({ type: "go", body: { ...body, situation: "", towards: "" } });
    await until(() => heard.at(-1).type === "choice-point.deleted");
    assert.equal(store.rows.get(ID).deleted, true);
  } finally {
    unmount(cards.actor);
    unwire();
  }
});
