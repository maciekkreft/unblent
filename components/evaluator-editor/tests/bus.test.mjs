import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the Evaluators tab as the product composes it — evaluator-list beside
// evaluator-editor, both with `subject` — with subject, books, journal and evaluators,
// all real machines on the real bus. Their stores are faked in memory and nobody is
// signed in, so nothing syncs. book.selected, a book-shelf gesture, is sent straight to
// books, as the bus would deliver it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const JOURNAL = "00000000000000000000000JRN";
const BOOK = "01K7TEST0000000000000BK001";
const BOOK_EVAL = "01K7TEST0000000000000E0001";
const JOURNAL_EVAL = "01K7TEST0000000000000E0002";
const NOW = new Date(2026, 9, 13, 10).getTime();

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

const book = {
  id: BOOK, title: "A book", fileTitle: "A book", author: "Someone", cover: null,
  chapters: [{ title: "One" }], toc: [], position: { chapter: 0, block: 0 },
  version: 1, contentVersion: 1, addedAt: 1, updatedAt: 1, deleted: false,
};
const evaluator = (id, bookId, name) => ({ id, book: bookId, name, on: true, questions: [], version: 1 });

let minted = 0;
const mint = () => `01K7TEST00000000000000M${String(++minted).padStart(3, "0")}`;

test("switching the open book to the journal and back moves the list and the open evaluator with it", async () => {
  const { actors, unwire } = await wire(["journal", "books", "subject", "evaluators", "evaluator-list", "evaluator-editor"], {
    journal: { store: store({ days: new Map() }), now: () => NOW },
    books: { store: store({ rows: new Map([[BOOK, book]]) }, new Map([["open", { id: BOOK, at: 1 }]])), now: () => NOW, api: null, revoke: () => {} },
    evaluators: {
      store: store({ rows: new Map([[BOOK_EVAL, evaluator(BOOK_EVAL, BOOK, "Book's")], [JOURNAL_EVAL, evaluator(JOURNAL_EVAL, JOURNAL, "Journal's")]]) }),
    },
    "evaluator-list": { mint, following: true },
    "evaluator-editor": { mint, following: true, throttleMs: 50 },
  });
  const list = () => actors["evaluator-list"].getSnapshot().context.evaluators.map((e) => e.name);
  const draft = () => actors["evaluator-editor"].getSnapshot().context.draft;
  try {
    await until(() => list().join() === "Book's");
    actors["evaluator-list"].send({ type: "_pick", id: BOOK_EVAL });
    await until(() => draft()?.name === "Book's");

    actors.books.send({ type: "book.selected", id: JOURNAL });
    await until(() => list().join() === "Journal's");
    await until(() => draft()?.book === JOURNAL);
    assert.equal(draft().name, "", "the journal opens on a New evaluator, not the book's");

    actors.books.send({ type: "book.selected", id: BOOK });
    await until(() => list().join() === "Book's");
    await until(() => draft()?.book === BOOK);
  } finally {
    unwire();
  }
});

test("in the journal a marked evaluator of another book is listed, opened and edited, and turning Show in journal off takes it out", async () => {
  const marked = { ...evaluator(BOOK_EVAL, BOOK, "Book's"), questions: [{ id: "01K7TEST0000000000000Q0001", kind: "yesno", text: "Kind?", yes: "", no: "", options: [] }], journal: true };
  const { actors, unwire } = await wire(["journal", "books", "subject", "evaluators", "evaluator-list", "evaluator-editor"], {
    journal: { store: store({ days: new Map() }), now: () => NOW },
    books: { store: store({ rows: new Map([[BOOK, book]]) }, new Map([["open", { id: JOURNAL, at: 1 }]])), now: () => NOW, api: null, revoke: () => {} },
    evaluators: { store: store({ rows: new Map([[BOOK_EVAL, marked], [JOURNAL_EVAL, evaluator(JOURNAL_EVAL, JOURNAL, "Journal's")]]) }) },
    "evaluator-list": { mint, following: true },
    "evaluator-editor": { mint, following: true, throttleMs: 50 },
  });
  const list = () => actors["evaluator-list"].getSnapshot().context.evaluators.map((e) => e.name);
  const editor = () => actors["evaluator-editor"].getSnapshot().context;
  try {
    await until(() => list().join() === "Book's,Journal's");
    assert.equal(actors["evaluator-list"].getSnapshot().context.titles[BOOK], "A book");
    assert.equal(editor().journal, JOURNAL, "the editor knows the journal, where the switch is not offered");
    actors["evaluator-list"].send({ type: "_pick", id: BOOK_EVAL });
    await until(() => editor().draft?.name === "Book's");
    assert.deepEqual([editor().draft.book, editor().draft.journal], [BOOK, true]);

    actors["evaluator-editor"].send({ type: "_edit", patch: { name: "Kindness" } });
    actors["evaluator-editor"].send({ type: "_blur" });
    await until(() => list().join() === "Kindness,Journal's");

    actors["evaluator-editor"].send({ type: "_journal", on: false });
    actors["evaluator-editor"].send({ type: "_blur" });
    await until(() => list().join() === "Journal's");
    assert.equal(editor().draft.name, "Kindness", "the evaluator stays open in the editor, where it can be turned back on");
  } finally {
    unwire();
  }
});
