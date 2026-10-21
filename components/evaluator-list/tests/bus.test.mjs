import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): evaluator-list and evaluators, both real, on the real bus with their real
// schemas. What each decides alone is in its own machine test; here is what they do
// together without a browser (9): a delete whose countdown ran out on the row reaches
// `evaluators` as evaluator.discarded, which tombstones it, with no corner notice. The
// store is faked, and `subject` is faked in the list's ask so the list shows one book.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { ask } = await import("bus");
const { machine: listMachine } = await import("../machine.js");

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const ONE = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const TWO = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const DRAFT = "01ARZ3NDEKTSV4RRFFQ69G5ND1";

const memory = (rows) => {
  const kept = new Map(rows.map((r) => [r.id, r]));
  return {
    rows: kept,
    all: async () => [...kept.values()],
    put: async (r) => void kept.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const kept = (id, name, position) => ({ id, book: BOOK, name, on: true, questions: [], version: 1, position });

// A row's countdown running out while the keyboard stays in the list (12, Vim keys) is
// the delete itself: evaluators makes a tombstone and the row goes, no notice is asked.
test("a row's countdown running out deletes the evaluator, with no corner notice", async () => {
  const store = memory([kept(ONE, "Goals", "a"), kept(TWO, "Values", "b")]);
  const { actors, records, unwire } = await wire(["evaluators", "evaluator-list"], {
    evaluators: { store },
    "evaluator-list": {
      mint: () => DRAFT,
      undoMs: 20,
      following: true,
      ask: (target, name, payload) =>
        target === "subject"
          ? Promise.resolve({ subject: { kind: "book", id: BOOK, title: "A book", view: "book-stage" } })
          : ask(listMachine, target, name, payload),
    },
  });
  const list = actors["evaluator-list"];
  const shown = () => list.getSnapshot().context.evaluators.map((e) => e.name).join();
  const emitted = (type) => records.filter((r) => r.kind === "event" && r.name === type);
  try {
    await until(() => shown() === "Goals,Values");
    list.send({ type: "_cut", id: ONE });
    list.send({ type: "_escape" });
    await until(() => store.rows.get(ONE).deleted === true);
    await until(() => shown() === "Values");
    assert.equal(emitted("evaluator.discarded").length, 1);
    assert.equal(emitted("removal.started").length, 0, "no corner notice");
    assert.ok(!store.rows.get(TWO).deleted);
  } finally {
    unwire();
  }
});
