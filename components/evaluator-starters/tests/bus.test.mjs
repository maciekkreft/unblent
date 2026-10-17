import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): evaluator-starters and evaluators, both real, on the real bus with their
// real schemas. books is a stand-in that answers list with the Journal, so the group
// has a book to show its evaluator under. A tick reaches evaluators as starter.ticked
// and comes back to the box as evaluator.changed carrying starterFor.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount } = await import("bus");
const { setup } = await import("xstate");
const { readFileSync } = await import("node:fs");

const JOURNAL = "00000000000000000000000JRN";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";

const memory = (rows) => ({
  rows,
  all: async () => [...rows.values()],
  put: async (r) => void rows.set(r.id, r),
  outboxAll: async () => [],
  outboxPut: async () => {},
  outboxDelete: async () => {},
  metaGet: async () => undefined,
  metaPut: async () => {},
});

function booksStandIn() {
  const list = JSON.parse(readFileSync(new URL("../../books/queries/list.json", import.meta.url)));
  const machine = setup({}).createMachine({
    id: "books",
    meta: { kind: "fact", shape: "local-only", owns: "books", emits: ["book.changed", "book.deleted"] },
    on: {
      "list?": {
        actions: ({ event }) =>
          event.reply({ books: [{ id: JOURNAL, title: "Journal", author: "You", cover: null, position: { chapter: 0, block: 0 }, chapterCount: 1, pending: false, addedAt: 0, written: true }] }),
      },
    },
  });
  const events = Object.fromEntries(
    ["book.changed", "book.deleted"].map((n) => [n, JSON.parse(readFileSync(new URL(`../../books/events/${n}.json`, import.meta.url)))]),
  );
  return mount(machine, { queries: { list }, events });
}

test("a tick in Starters becomes the evaluator's starterFor and shows ticked", async () => {
  const books = booksStandIn();
  const rows = new Map([[ID, { id: ID, book: JOURNAL, name: "Clear goal", on: true, questions: [], version: 1 }]]);
  const { actors, unwire } = await wire(["evaluators", "evaluator-starters"], { evaluators: { store: memory(rows) } });
  try {
    const starters = actors["evaluator-starters"];
    await until(() => actors.evaluators.getSnapshot().matches("ready"));
    starters.send({ type: "_shown" });
    await until(() => starters.getSnapshot().matches("ready") && starters.getSnapshot().context.evaluators.length === 1);
    assert.equal(starters.getSnapshot().context.failed, false);
    starters.send({ type: "_tick", evaluator: ID, on: true });
    await until(() => starters.getSnapshot().context.evaluators[0].starterFor?.includes("evaluators"));
    assert.deepEqual(rows.get(ID).starterFor, ["evaluators"], "evaluators keeps the tick");
  } finally {
    unwire();
    unmount(books);
  }
});
