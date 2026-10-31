import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the Evaluators tab as the try page composes it — evaluator-list beside
// evaluator-editor — with evaluators, all real machines on the real bus. The store is
// faked in memory and nobody is signed in, so nothing syncs.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const JOURNAL = "00000000000000000000000JRN";
const BOOK = "01K7TEST0000000000000BK001";
const BOOK_EVAL = "01K7TEST0000000000000E0001";
const JOURNAL_EVAL = "01K7TEST0000000000000E0002";

const store = (tables, meta = new Map()) => ({
  all: (t = "rows") => Promise.resolve([...(tables[t]?.values() ?? [])]),
  put: (t, r) => (r === undefined ? tables.rows.set(t.id, t) : tables[t].set(r.id, r), Promise.resolve()),
  outboxAll: () => Promise.resolve([]),
  outboxPut: () => Promise.resolve(),
  outboxDelete: () => Promise.resolve(),
  metaGet: (k) => Promise.resolve(meta.get(k)),
  metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  clear: () => Promise.resolve(),
});

const evaluator = (id, bookId, name) => ({ id, book: bookId, name, on: true, questions: [], version: 1 });

let minted = 0;
const mint = () => `01K7TEST00000000000000M${String(++minted).padStart(3, "0")}`;

// Evaluators belong to the account: the list shows every one, whichever book it is kept
// with, and a pick opens it in the editor; a New evaluator is kept with the Journal.
test("the list shows every book's evaluators, a pick opens one, and New evaluator is kept with the Journal", async () => {
  const { actors, unwire } = await wire(["evaluators", "evaluator-list", "evaluator-editor"], {
    evaluators: { store: store({ rows: new Map([[BOOK_EVAL, evaluator(BOOK_EVAL, BOOK, "Book's")], [JOURNAL_EVAL, evaluator(JOURNAL_EVAL, JOURNAL, "Journal's")]]) }) },
    "evaluator-list": { mint },
    "evaluator-editor": { mint, throttleMs: 50 },
  });
  try {
    const list = actors["evaluator-list"];
    const editor = actors["evaluator-editor"];
    await until(() => list.getSnapshot().matches("ready") && list.getSnapshot().context.evaluators.length === 2);
    list.send({ type: "_pick", id: BOOK_EVAL });
    await until(() => editor.getSnapshot().context.draft?.id === BOOK_EVAL);
    const fresh = list.getSnapshot().context.draft;
    list.send({ type: "_pick", id: fresh });
    await until(() => editor.getSnapshot().context.draft?.id === fresh);
    assert.equal(editor.getSnapshot().context.draft.book, JOURNAL);
    editor.send({ type: "_edit", patch: { name: "New one" } });
    await until(() => list.getSnapshot().context.evaluators.some((e) => e.id === fresh && e.book === JOURNAL));
  } finally {
    unwire();
  }
});

test("after a reload the evaluator the editor reopens is the row the list marks", async () => {
  const { actors, unwire } = await wire(["evaluators", "evaluator-list", "evaluator-editor"], {
    evaluators: { store: store({ rows: new Map([[BOOK_EVAL, evaluator(BOOK_EVAL, BOOK, "Book's")]]) }) },
    "evaluator-list": { mint },
    "evaluator-editor": { mint, throttleMs: 50, open: { id: BOOK_EVAL, book: BOOK } },
  });
  try {
    await until(() => actors["evaluator-editor"].getSnapshot().context.draft?.id === BOOK_EVAL);
    await until(() => actors["evaluator-list"].getSnapshot().context.open === BOOK_EVAL);
  } finally {
    unwire();
  }
});
