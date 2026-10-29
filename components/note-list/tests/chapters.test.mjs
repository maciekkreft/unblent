import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, chaptered, chapterOf, apart, placement, source } from "../machine.js";

// The chapter switch and its groups (plan step 3), decided from the machine's context
// alone, so they are tested here without a browser (9).
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const LOOSE = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const ONE = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const TWO = "01ARZ3NDEKTSV4RRFFQ69G5FC3";
const TWO_B = "01ARZ3NDEKTSV4RRFFQ69G5FD4";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FE5";

const link = (chapter, chapterTitle) => ({ kind: "book", id: BOOK, ...(chapter ? { chapter, chapterTitle } : {}) });
const note = (id, position, about) => ({ id, title: id.slice(-2), subtitle: "", updatedAt: 1, position, about });
// The whole order the user set: TWO, LOOSE, ONE, TWO_B, then a note about another book.
const notes = [
  note(TWO, "a", [link("chapter-two", "Chapter Two")]),
  note(LOOSE, "b", [link()]),
  note(ONE, "c", [link("chapter-one", "Chapter One")]),
  note(TWO_B, "d", [link("chapter-two", "Chapter Two")]),
  note(OTHER, "e", [{ kind: "book", id: "01ARZ3NDEKTSV4RRFFQ69G5BK2" }]),
];
const subject = (chapter, chapterTitle) => ({ kind: "book", id: BOOK, title: "Book", ...(chapter ? { chapter, chapterTitle } : {}) });
const context = (over = {}) => ({ notes, following: true, subject: subject("chapter-two", "Chapter Two"), handed: new Set(), open: null, allChapters: false, cut: null, ...over });
const idsOf = (rows) => rows.map((n) => n.id);

test("under This chapter the notes linked to no chapter come first, then the open chapter's, and the rest are counted", () => {
  const g = chaptered(context());
  assert.equal(g.unit, "chapter");
  assert.equal(g.title, "Chapter Two");
  assert.equal(g.all, false);
  assert.deepEqual(idsOf(g.loose), [LOOSE]);
  assert.deepEqual(idsOf(g.here), [TWO, TWO_B]);
  assert.equal(g.more, 1, "Chapter One's note; the other book's is not about the subject");
});

test("a chapter with no notes yet has an empty group and counts every other chapter's", () => {
  const g = chaptered(context({ subject: subject("chapter-three", "Chapter Three") }));
  assert.deepEqual(idsOf(g.here), []);
  assert.equal(g.more, 3);
});

test("a Journal day is a chapter named by its date, so the switch speaks of days", () => {
  const day = [note(ONE, "a", [link("2026-10-29", "Thursday 29 October")]), note(TWO, "b", [link("2026-10-27", "Tuesday 27 October")])];
  const g = chaptered(context({ notes: day, subject: subject("2026-10-29", "Thursday 29 October") }));
  assert.equal(g.unit, "day");
  assert.deepEqual(idsOf(g.here), [ONE]);
  assert.equal(g.more, 1);
});

test("there is no switch without an open chapter, or when the list does not follow the stage", () => {
  assert.equal(chaptered(context({ subject: subject() })), null);
  assert.equal(chaptered(context({ subject: null })), null);
  assert.equal(chaptered(context({ following: false })), null);
});

test("the switch starts on This chapter, comes back from input, and _chapters turns it", () => {
  const ask = () => Promise.resolve({});
  const start = (input) => createActor(machine, { input: { ask, mint: () => LOOSE, undoMs: 100, following: true, ...input } }).start();
  const actor = start({});
  assert.equal(actor.getSnapshot().context.allChapters, false);
  actor.send({ type: "_chapters", all: true });
  assert.equal(actor.getSnapshot().context.allChapters, true);
  actor.send({ type: "_chapters", all: false });
  assert.equal(actor.getSnapshot().context.allChapters, false);
  assert.equal(start({ allChapters: true }).getSnapshot().context.allChapters, true);
});

test("a row names its chapter of the subject, and nothing for the whole book", () => {
  const s = subject("chapter-two", "Chapter Two");
  assert.equal(chapterOf(notes[2], s), "Chapter One");
  assert.equal(chapterOf(notes[1], s), null);
  assert.equal(chapterOf(notes[4], s), null);
  // Not following, a row names the first chapter it is linked to.
  assert.equal(chapterOf(notes[0], null), "Chapter Two");
});

test("under This chapter the open note of another chapter is listed apart and not counted; under All it is in the list", () => {
  const g = chaptered(context({ open: ONE }));
  assert.equal(g.more, 0);
  assert.equal(apart(context({ open: ONE }))?.id, ONE);
  assert.equal(source(notes[2], {}, subject("chapter-two", "Chapter Two")), "From Chapter One");
  assert.equal(apart(context({ open: ONE, allChapters: true })), null);
  assert.equal(apart(context({ open: LOOSE })), null);
  assert.equal(apart(context({ open: ONE, subject: subject() })), null);
});

test("a move in the filtered list lands next to the row it was placed at in the whole order", () => {
  // As shown under Chapter Two: LOOSE, TWO, TWO_B (group order, not the whole order).
  const shownIds = [LOOSE, TWO, TWO_B];
  // ONE cut, placed below TWO: right after TWO, before LOOSE, which comes next in the whole order.
  assert.deepEqual(placement(context({ cut: ONE }), shownIds, TWO, true), { after: TWO, before: LOOSE });
  // Placed above TWO_B: between ONE's old neighbours, skipping the cut note itself.
  assert.deepEqual(placement(context({ cut: ONE }), shownIds, TWO_B, false), { after: LOOSE, before: TWO_B });
  // Below the last row: before the hidden note that follows it, never far past it.
  assert.deepEqual(placement(context({ cut: TWO }), [LOOSE, TWO_B], TWO_B, true), { after: TWO_B, before: OTHER });
  // From a fixed row, above the first shown note.
  assert.deepEqual(placement(context({ cut: TWO_B }), [LOOSE, TWO], "draft", true), { after: TWO, before: LOOSE });
  // Nothing shown: the top of the whole order.
  assert.deepEqual(placement(context(), [], "draft", true), { after: null, before: TWO });
});
