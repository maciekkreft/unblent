import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): choice-point-cards with choice-points, real machines on the real bus. The
// user's gestures are sent to the view's actor the way its view forwards them, and the
// store is faked; `undo` is not wired, so a step is undone by sending the fact what `undo`
// sends it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const FULL = { situation: "Dinner\nLate", thoughts: "Tired", away: "Left", towards: "Stay" };

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

test("Delete makes one step with the notice, and its Undo brings back all four texts with what was still waiting", async () => {
  const store = memory([{ id: ID, day: DAY, ...FULL, createdAt: "2026-10-14T07:00:00.000Z", version: 1 }]);
  const { actors, records, unwire } = await wire(["choice-points", "choice-point-cards"], {
    "choice-points": { store },
    "choice-point-cards": { mint: () => ID, now: () => NOW, throttleMs: 5 },
  });
  try {
    const cards = actors["choice-point-cards"];
    const shown = () => cards.getSnapshot().context.choicePoints;
    await until(() => shown().length === 1);
    // The bus holds what supersedes the list until a macrotask after its reply (4.2).
    await new Promise((r) => setTimeout(r, 0));
    cards.send({ type: "_open", id: ID });
    cards.send({ type: "_edit", id: ID, field: "towards", value: "Stay and listen" });
    cards.send({ type: "_delete", id: ID });
    assert.deepEqual(shown(), [], "the card is gone with the sheet, before the next draw");
    assert.deepEqual(cards.getSnapshot().context.drafts, []);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.held.get(ID).deleted, true, "the throttle's end does not save it back");
    const steps = records.filter((r) => r.kind === "event" && r.name === "step.recorded").map((r) => r.payload);
    const removal = steps.at(-1);
    assert.equal(removal.notice, true);

    actors["choice-points"].send({ type: "step.undone", id: removal.id, owner: "choice-points", payload: removal.undo });
    await until(() => shown().length === 1);
    const { situation, thoughts, away, towards } = shown()[0];
    assert.deepEqual({ situation, thoughts, away, towards }, { ...FULL, towards: "Stay and listen" });
  } finally {
    unwire();
  }
});
