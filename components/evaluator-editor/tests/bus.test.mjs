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

test("another book opens its most recently edited evaluator, and a book with none a New evaluator", async () => {
  const BOOK2 = "01K7TEST0000000000000BK002";
  const OLD = "01K7TEST0000000000000E0003";
  const MARKED = "01K7TEST0000000000000E0004";
  const at = (r, updatedAt) => ({ ...r, updatedAt });
  const rows = [
    at(evaluator(BOOK_EVAL, BOOK, "Book's"), "2026-10-01T00:00:00.000Z"),
    evaluator(OLD, BOOK, "Book's old"),
    at(evaluator(MARKED, BOOK, "Marked"), "2026-09-02T00:00:00.000Z"),
    at(evaluator(JOURNAL_EVAL, JOURNAL, "Journal's"), "2026-09-01T00:00:00.000Z"),
  ];
  const { actors, unwire } = await wire(["journal", "books", "subject", "evaluators", "evaluator-list", "evaluator-editor"], {
    journal: { store: store({ days: new Map() }), now: () => NOW },
    books: {
      store: store({ rows: new Map([[BOOK, book], [BOOK2, { ...book, id: BOOK2, title: "Another" }]]) }, new Map([["open", { id: BOOK, at: 1 }]])),
      now: () => NOW,
      api: null,
      revoke: () => {},
    },
    evaluators: { store: store({ rows: new Map(rows.map((r) => [r.id, r])) }) },
    "evaluator-list": { mint, following: true },
    "evaluator-editor": { mint, following: true, throttleMs: 50 },
  });
  const list = () => actors["evaluator-list"].getSnapshot().context.evaluators.map((e) => e.name);
  const editor = () => actors["evaluator-editor"].getSnapshot().context;
  const draft = () => editor().draft;
  // The row the list marks, which it learns only from the editor's evaluator.opened.
  const open = () => actors["evaluator-list"].getSnapshot().context.open;
  try {
    await until(() => list().length === 3);
    assert.equal(open(), null);
    actors["evaluator-list"].send({ type: "_pick", id: OLD });
    await until(() => draft()?.id === OLD);
    await until(() => open() === OLD);
    actors["evaluator-editor"].send({ type: "_edit", patch: { name: "Book's old, edited" } });
    actors["evaluator-editor"].send({ type: "_blur" });

    actors.books.send({ type: "book.selected", id: JOURNAL });
    await until(() => draft()?.book === JOURNAL);
    assert.equal(draft().id, JOURNAL_EVAL, "the Journal's own, though one of another book is newer");
    await until(() => open() === JOURNAL_EVAL);

    actors.books.send({ type: "book.selected", id: BOOK });
    await until(() => draft()?.book === BOOK);
    assert.equal(draft().id, OLD, "the one edited last, though it had no time before");
    await until(() => open() === OLD);

    actors.books.send({ type: "book.selected", id: BOOK2 });
    await until(() => draft()?.book === BOOK2);
    assert.deepEqual([draft().name, editor().evaluators.some((r) => r.id === draft().id)], ["", false], "a New evaluator");
    await until(() => open() === draft().id);
  } finally {
    unwire();
  }
});

test("after a reload an evaluator of another book than the one it was opened in stays only under a pin", async () => {
  const wiring = (parts, extra = {}) =>
    wire(parts, {
      journal: { store: store({ days: new Map() }), now: () => NOW },
      books: { store: store({ rows: new Map([[BOOK, book]]) }, new Map([["open", { id: JOURNAL, at: 1 }]])), now: () => NOW, api: null, revoke: () => {} },
      evaluators: {
        store: store({ rows: new Map([[BOOK_EVAL, { ...evaluator(BOOK_EVAL, BOOK, "Book's"), journal: true }], [JOURNAL_EVAL, evaluator(JOURNAL_EVAL, JOURNAL, "Journal's")]]) }),
      },
      "evaluator-list": { mint, following: true },
      "evaluator-editor": { mint, following: true, throttleMs: 50, open: { id: BOOK_EVAL, book: JOURNAL } },
      ...extra,
    });
  const facts = ["journal", "books", "subject", "evaluators", "evaluator-list", "evaluator-editor"];

  // Not pinned: the editor follows the Journal on the stage to its own, which the list marks.
  let { actors, unwire } = await wiring(facts);
  try {
    await until(() => actors["evaluator-editor"].getSnapshot().context.draft?.id === JOURNAL_EVAL);
    await until(() => actors["evaluator-list"].getSnapshot().context.open === JOURNAL_EVAL);
    assert.deepEqual(actors["evaluator-list"].getSnapshot().context.evaluators.map((e) => e.name), ["Journal's"]);
  } finally {
    unwire();
  }

  // Pinned to the Journal: the evaluator stays open.
  ({ actors, unwire } = await wiring(["pins", ...facts], { pins: { stored: JSON.stringify({ evaluators: JOURNAL }), save: () => {} } }));
  try {
    await until(() => actors["evaluator-editor"].getSnapshot().context.pin === JOURNAL);
    await until(() => actors["evaluator-editor"].getSnapshot().context.draft?.id === BOOK_EVAL);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(actors["evaluator-editor"].getSnapshot().context.draft?.id, BOOK_EVAL);
  } finally {
    unwire();
  }
});

test("pinned from the start, the list and the open evaluator stay on their book while the stage moves; unpinned, both follow it, and a reload keeps the pin", async () => {
  const saved = [];
  const wiring = (stored) =>
    wire(["pins", "journal", "books", "subject", "evaluators", "evaluator-list", "evaluator-editor"], {
      pins: { stored, save: (v) => saved.push(v) },
      journal: { store: store({ days: new Map() }), now: () => NOW },
      books: { store: store({ rows: new Map([[BOOK, book]]) }, new Map([["open", { id: BOOK, at: 1 }]])), now: () => NOW, api: null, revoke: () => {} },
      evaluators: {
        store: store({ rows: new Map([[BOOK_EVAL, evaluator(BOOK_EVAL, BOOK, "Book's")], [JOURNAL_EVAL, evaluator(JOURNAL_EVAL, JOURNAL, "Journal's")]]) }),
      },
      "evaluator-list": { mint, following: true },
      "evaluator-editor": { mint, following: true, throttleMs: 50 },
    });
  let { actors, unwire } = await wiring(null);
  const list = () => actors["evaluator-list"].getSnapshot().context;
  const draft = () => actors["evaluator-editor"].getSnapshot().context.draft;
  try {
    await until(() => list().evaluators.map((e) => e.name).join() === "Book's");
    actors["evaluator-list"].send({ type: "_pick", id: BOOK_EVAL });
    await until(() => draft()?.name === "Book's");
    await until(() => actors.pins.getSnapshot().context.pins.evaluators === BOOK);

    actors.books.send({ type: "book.selected", id: JOURNAL });
    await until(() => list().subject?.id === JOURNAL);
    await until(() => actors["evaluator-editor"].getSnapshot().context.subject?.id === JOURNAL);
    assert.equal(list().book, BOOK, "the list stays on the pinned book");
    assert.equal(draft()?.name, "Book's", "the open evaluator stays");
  } finally {
    unwire();
  }

  // A reload: the pin comes back from what pins saved, with the Journal still on the stage.
  ({ actors, unwire } = await wiring(saved.at(-1)));
  try {
    actors.books.send({ type: "book.selected", id: JOURNAL });
    await until(() => list().subject?.id === JOURNAL);
    await until(() => list().evaluators.length > 0);
    assert.equal(list().book, BOOK, "still pinned after a reload");

    actors["evaluator-list"].send({ type: "_pick", id: BOOK_EVAL });
    await until(() => draft()?.name === "Book's");
    actors["evaluator-editor"].send({ type: "_togglePin" });
    await until(() => list().book === JOURNAL);
    await until(() => draft()?.book === JOURNAL);
    assert.equal(draft().name, "Journal's", "unpinned, the editor follows to the Journal's newest");
    await until(() => list().open === JOURNAL_EVAL);
  } finally {
    unwire();
  }
});

test("after a reload the evaluator the editor reopens is the row the list marks", async () => {
  const { actors, unwire } = await wire(["journal", "books", "subject", "evaluators", "evaluator-list", "evaluator-editor"], {
    journal: { store: store({ days: new Map() }), now: () => NOW },
    books: { store: store({ rows: new Map([[BOOK, book]]) }, new Map([["open", { id: BOOK, at: 1 }]])), now: () => NOW, api: null, revoke: () => {} },
    evaluators: { store: store({ rows: new Map([[BOOK_EVAL, evaluator(BOOK_EVAL, BOOK, "Book's")]]) }) },
    "evaluator-list": { mint, following: true },
    "evaluator-editor": { mint, following: true, throttleMs: 50, open: { id: BOOK_EVAL, book: BOOK } },
  });
  try {
    await until(() => actors["evaluator-editor"].getSnapshot().context.draft?.id === BOOK_EVAL);
    await until(() => actors["evaluator-list"].getSnapshot().context.open === BOOK_EVAL);
  } finally {
    unwire();
  }
});
