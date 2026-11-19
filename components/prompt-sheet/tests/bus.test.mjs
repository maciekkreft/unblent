import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): prompt-sheet with prompt-sheets, real machines on the real bus. The user's
// gestures are sent to the view's actor the way its view forwards them, and the store is
// faked; `undo` is not wired, so a step is undone by sending the fact what `undo` sends it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5PS1";
const SET = "01ARZ3NDEKTSV4RRFFQ69G5ST1";
const ANSWERS = [
  { prompt: "What went well today?", answer: "A walk", fits: null },
  { prompt: "Why did it happen?", answer: "", fits: null },
];

const memory = (rows) => {
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

test("Remove from this day makes one step with the notice, and its Undo brings back what was written, also what still waited", async () => {
  const store = memory([{ id: ID, day: DAY, setId: SET, setName: "Three good things", basedOn: "", answers: ANSWERS, createdAt: "2026-10-14T07:00:00.000Z", version: 1 }]);
  const { actors, records, unwire } = await wire(["prompt-sheets", "prompt-sheet"], {
    "prompt-sheets": { store },
    "prompt-sheet": { mint: () => ID, now: () => NOW, throttleMs: 5 },
  });
  try {
    const view = actors["prompt-sheet"];
    const shown = () => view.getSnapshot().context.sheets;
    await until(() => shown().length === 1);
    // The bus holds what supersedes the list until a macrotask after its reply (4.2).
    await new Promise((r) => setTimeout(r, 0));
    view.send({ type: "_open", id: ID });
    view.send({ type: "_edit", id: ID, index: 1, value: "Sun" });
    view.send({ type: "_delete", id: ID });
    assert.deepEqual(view.getSnapshot().context.drafts, []);
    await until(() => shown().length === 0);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.held.get(ID).deleted, true, "the throttle's end does not save it back");
    const removal = records.filter((r) => r.kind === "event" && r.name === "step.recorded").map((r) => r.payload).at(-1);
    assert.equal(removal.notice, true);

    actors["prompt-sheets"].send({ type: "step.undone", id: removal.id, owner: "prompt-sheets", payload: removal.undo });
    await until(() => shown().length === 1);
    assert.deepEqual(shown()[0].answers.map((a) => a.answer), ["A walk", "Sun"]);
  } finally {
    unwire();
  }
});
