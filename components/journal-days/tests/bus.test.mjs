import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): journal-days and choice-points, both real, on the real bus with their
// real schemas. journal and session are not mounted, so journal-days' asks of them are
// answered by hand; a stand-in saves and removes the way choice-point-cards does.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");
const { machine } = await import("../machine.js");

const DAY = "2026-10-12";
const JOURNAL_DAY = { id: "01K7TEST00000000000000DY03", day: DAY, text: "Woke up tired.", editedAt: 0, version: 1, waiting: [], unanswered: [] };
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";

const memory = () => ({
  all: async () => [],
  put: async () => {},
  outboxAll: async () => [],
  outboxPut: async () => {},
  outboxDelete: async () => {},
  metaGet: async () => undefined,
  metaPut: async () => {},
});

const cardsSchema = (name) => JSON.parse(readFileSync(new URL(`../../choice-point-cards/events/${name}.json`, import.meta.url)));

const answers = {
  journal: { days: [JOURNAL_DAY], projects: [], detectors: [], answers: [], open: null, reason: null },
  session: { userId: null, registrationOpen: true },
};

test("a saved choice point is counted on its day, not while it is being removed", async () => {
  const days = { ask: (target, name, payload) => (answers[target] ? Promise.resolve(answers[target]) : ask(machine, target, name, payload)) };
  const { actors, unwire } = await wire(["choice-points", "journal-days"], { "choice-points": { store: memory() }, "journal-days": days });
  const cards = mount(
    setup({}).createMachine({
      id: "test-cards",
      meta: { kind: "view", emits: ["choice-point.saved", "removal.started"], asks: [], attributes: [] },
      on: { go: { actions: emit(({ event }) => event.body) } },
    }),
    { events: { "choice-point.saved": cardsSchema("choice-point.saved"), "removal.started": cardsSchema("removal.started") } },
  );
  const held = () => actors["journal-days"].getSnapshot().context.choicePoints;
  try {
    await until(() => actors["choice-points"].getSnapshot().matches("ready") && actors["journal-days"].getSnapshot().matches("ready"));
    cards.send({ type: "go", body: { type: "choice-point.saved", id: ID, day: DAY, situation: "Meeting ran late", thoughts: "", away: "", towards: "" } });
    await until(() => held()[ID]);
    assert.deepEqual(held()[ID], { day: DAY, version: 1, removing: false });
    cards.send({ type: "go", body: { type: "removal.started", kind: "choice-point", id: ID, name: "Meeting ran late" } });
    await until(() => held()[ID].removing === true);
  } finally {
    unmount(cards);
    unwire();
  }
});
