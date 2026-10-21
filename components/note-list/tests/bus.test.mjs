import { test } from "node:test";
import assert from "node:assert/strict";
import { shown, apart } from "../machine.js";

// The kit (10): note-list with its partners, real machines on the real bus — `notes`
// (whose notes it lists and whose tombstones remove a row), `note-editor` (which says
// which note is open) and `subject` (which says what is on the stage). What each does
// alone is decided in its own machine test; here is what they do together, without a
// browser (9). The stores, the server and what `subject` reads of `books` and `dock` are
// faked; a book being opened is sent to `subject` as the bus delivers `book.opened`, and
// the user's gestures are sent to the view's actor the way its view forwards them.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const BOOK_ONE = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const BOOK_TWO = "01ARZ3NDEKTSV4RRFFQ69G5BK2";
const NOTE_ONE = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const NOTE_TWO = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const NOTE_NONE = "01ARZ3NDEKTSV4RRFFQ69G5FD4";
const TITLES = { [BOOK_ONE]: "Sample Book", [BOOK_TWO]: "Sample Book" };

const note = (id, body, about = []) => ({ id, title: body, body, version: 1, updatedAt: 10, about });
const ABOUT_ONE = note(NOTE_ONE, "About one", [{ kind: "book", id: BOOK_ONE }]);
const ABOUT_TWO = note(NOTE_TWO, "About two", [{ kind: "book", id: BOOK_TWO }]);

// The notes store as fact.js builds it, in memory; `slow` holds the first read back, the
// way a cold IndexedDB answers after the other facts.
function notesStore(rows = [], { slow = 0 } = {}) {
  const notes = new Map(rows.map((n) => [n.id, n]));
  const outbox = new Map();
  const meta = new Map();
  return {
    notes,
    all: () => new Promise((r) => setTimeout(() => r([...notes.values()]), slow)),
    put: (r) => (notes.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
    empty: () => (notes.clear(), outbox.clear(), Promise.resolve()),
  };
}

// What `subject` reads of `dock` and `books` (its starting picture and a book's title).
const stage = (openId = null) => (target, name, payload) => {
  if (target === "dock") return Promise.resolve({ stage: null, docks: {} });
  if (target === "books" && name === "open") return Promise.resolve({ id: openId });
  if (target === "books" && name === "read")
    return Promise.resolve(TITLES[payload.id] ? { book: { id: payload.id, title: TITLES[payload.id] } } : { error: "not-found" });
  return Promise.resolve({});
};

let minted = 0;
const mint = () => `01ARZ3NDEKTSV4RRFFQ69G5M${String(minted++ % 100).padStart(2, "0")}`;

async function start({ notes = [], openId = null, slow = 0, notesInput = {}, names = ["notes", "subject", "note-list", "note-editor"] } = {}) {
  const store = notesStore(notes, { slow });
  const wired = await wire(names, {
    notes: { store, now: (() => { let n = 100; return () => ++n; })(), api: null, revoke: () => {}, ...notesInput },
    subject: { ask: stage(openId) },
    "note-list": { mint, undoMs: 20, following: true, highlightsOpen: false },
    "notice-stack": { fadeMs: 30 },
    "note-editor": {
      mint,
      focus: () => {},
      follows: true,
      subjecting: true,
      recall: () => null,
      forget: () => {},
      recallTitles: () => ({}),
      rememberTitles: () => {},
    },
  });
  const list = () => wired.actors["note-list"].getSnapshot().context;
  const shownBodies = () => shown(list()).map((n) => n.title);
  const editor = () => wired.actors["note-editor"].getSnapshot().context;
  const open = (id) => wired.actors.subject.send({ type: "book.opened", id });
  const emitted = (type) => wired.records.filter((r) => r.kind === "event" && r.name === type);
  return { ...wired, store, list, shownBodies, editor, open, emitted };
}

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// The list shows only the notes about the book on the stage, and the editor opens that
// book's note, following the stage; a pinned editor keeps its note, which the list sets
// apart as the open row, and a pick while pinned moves the pin with no notice (12).
test("the list shows the subject's notes, following the stage, and a pinned note is set apart", async () => {
  const h = await start({ notes: [ABOUT_ONE, ABOUT_TWO] });
  try {
    // No book open: no subject to scope to, so both notes show.
    await until(() => same(h.shownBodies(), ["About one", "About two"]));

    h.open(BOOK_ONE);
    await until(() => same(h.shownBodies(), ["About one"]) && h.editor().body === "About one");
    h.open(BOOK_TWO);
    await until(() => same(h.shownBodies(), ["About two"]) && h.editor().body === "About two");

    // Pin: the stage moves, the note stays, and the list holds it apart as the open row.
    h.actors["note-editor"].send({ type: "_togglePin" });
    assert.equal(h.editor().pinned, true);
    h.open(BOOK_ONE);
    await until(() => same(h.shownBodies(), ["About one"]));
    await until(() => apart(h.list())?.id === NOTE_TWO);
    assert.equal(h.editor().body, "About two", "the pinned note did not follow the stage");
    assert.equal(h.list().open, NOTE_TWO, "the apart row is the open one");

    // A pick while pinned opens the picked note and keeps the pin on, now on it; the
    // stage's own note is open, so nothing is apart, and nothing conflicted.
    h.actors["note-list"].send({ type: "_pick", id: NOTE_ONE });
    await until(() => h.editor().body === "About one");
    assert.equal(h.editor().pinned, true, "the pin stays on after a pick");
    await until(() => apart(h.list()) == null);
    assert.equal(h.emitted("note.conflicted").length, 0, "no notice");

    h.open(BOOK_TWO);
    await until(() => same(h.shownBodies(), ["About two"]));
    assert.equal(h.editor().body, "About one", "the pinned note did not follow the stage");

    // Unpinned, the next change of stage is followed again.
    h.actors["note-editor"].send({ type: "_togglePin" });
    assert.equal(h.editor().pinned, false);
    h.open(BOOK_ONE);
    await until(() => same(h.shownBodies(), ["About one"]));
    h.open(BOOK_TWO);
    await until(() => h.editor().body === "About two");
  } finally {
    h.unwire();
  }
});

// A note that reaches this device after its book is opened opens in the editor (12):
// the first pull is held back until the book is on the stage, so the editor first lands
// on the empty page, then the note arrives.
test("a note that arrives after its book is opened opens in the editor", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const api = {
    put: async (row) => ({ ...row, version: 1, updatedAt: 900 }),
    pull: async (since) => (await held, { notes: [ABOUT_ONE, ABOUT_TWO], cursor: since + 1 }),
  };
  const h = await start({ notesInput: { api, ask: async () => ({ userId: "u1", registrationOpen: false }) } });
  try {
    h.open(BOOK_ONE);
    await until(() => h.editor().subject?.id === BOOK_ONE && h.actors["note-editor"].getSnapshot().matches("empty"));
    assert.equal(h.editor().body, "", "no note about the book is known yet: the empty page");
    release();
    await until(() => h.editor().body === "About one");
    assert.equal(h.editor().id, NOTE_ONE);
  } finally {
    h.unwire();
  }
});

// The stage survives a reload (3.5): the book open on the server comes back on its own,
// and the list scopes to its notes even though the notes answer after the subject's
// starting null, never flashing every note.
test("the auto-reopened book scopes the list to its notes, not every note", async () => {
  const h = await start({
    openId: BOOK_ONE,
    slow: 30,
    notes: [note(NOTE_ONE, "About the book", [{ kind: "book", id: BOOK_ONE }]), note(NOTE_NONE, "About nothing")],
  });
  try {
    await until(() => h.list().notes.length === 2);
    assert.deepEqual(h.shownBodies(), ["About the book"]);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(h.shownBodies(), ["About the book"], "the list stayed scoped to the book");
  } finally {
    h.unwire();
  }
});

// A delete is a fact only when its undo window ends (5): the row goes, the note becomes a
// tombstone in the store, the editor that showed it falls to the empty page, and the
// next start, from the same store, does not bring it back.
test("a delete commits when its window ends and stays gone", async () => {
  const first = note(NOTE_ONE, "First\nbody");
  const h = await start({ notes: [first] });
  try {
    await until(() => h.list().notes.length === 1);
    h.actors["note-list"].send({ type: "_pick", id: NOTE_ONE });
    await until(() => h.editor().id === NOTE_ONE);
    h.actors["note-list"].send({ type: "_discard", id: NOTE_ONE });
    await until(() => h.emitted("note.discarded").length === 1 && h.emitted("note.deleted").length === 1);
    await until(() => h.list().notes.length === 0);
    await until(() => h.editor().id == null && h.editor().body === "");
    assert.equal(h.store.notes.get(NOTE_ONE).deleted, true, "the note is a tombstone, not erased");
  } finally {
    h.unwire();
  }
  const again = await start({ notes: [...h.store.notes.values()] });
  try {
    await until(() => again.emitted("note.opened").length > 0);
    assert.deepEqual(again.list().notes, [], "it stays gone after a restart");
    assert.equal(again.editor().id, null);
  } finally {
    again.unwire();
  }
});

// A cut row placed with p reaches `notes` as note.moved, and the list's order is the
// one notes keeps; a delete handed to the corner notice is deleted by `notes` when the
// notice's window ends (12, Vim keys; 5, an item's place is last write wins).
test("a move goes through notes, and a handed-off delete is settled by the corner notice", async () => {
  const one = note(NOTE_ONE, "One");
  const two = { ...note(NOTE_TWO, "Two"), updatedAt: 20 };
  const none = { ...note(NOTE_NONE, "Three"), updatedAt: 5 };
  const h = await start({ notes: [one, two, none], names: ["notes", "note-list", "notice-stack"] });
  try {
    const order = () => h.list().notes.map((n) => n.title);
    await until(() => order().join() === "Two,One,Three");
    h.actors["note-list"].send({ type: "_cut", id: NOTE_TWO });
    h.actors["note-list"].send({ type: "_paste", after: NOTE_ONE, before: NOTE_NONE });
    await until(() => order().join() === "One,Two,Three");
    h.actors["note-list"].send({ type: "_cut", id: NOTE_NONE });
    h.actors["note-list"].send({ type: "_left" });
    await until(() => shown(h.list()).length === 2);
    await until(() => order().join() === "One,Two", 2000);
    assert.equal(h.emitted("removal.settled").length, 1);
  } finally {
    h.unwire();
  }
});
