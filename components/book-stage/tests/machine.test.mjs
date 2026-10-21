import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shownOf, tabsOf, showing } from "../machine.js";

// The decision (3.2, 9): which child the stage shows, driven with a fake bus `ask` that
// answers books: open and books: read from a small state object.
const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const JOURNAL = "00000000000000000000000JRN";
const BOOK = "01HZZZZZZZZZZZZZZZZZZZZZZZ";

const fakeAsk = (state) => (target, name, payload = {}) => {
  if (target === "books" && name === "open") return Promise.resolve({ id: state.openId });
  if (target === "books" && name === "read") {
    const book = state.books[payload.id];
    return Promise.resolve(book ? { book } : { error: "not-found" });
  }
  if (target === "books" && name === "list") return Promise.resolve({ books: Object.values(state.books) });
  return Promise.resolve({ error: "no-answerer" });
};

const BOOKS = { [JOURNAL]: { id: JOURNAL, title: "Journal", written: true }, [BOOK]: { id: BOOK, title: "Dune" } };

const start = async (openId) => {
  const actor = createActor(machine, { input: { ask: fakeAsk({ openId, books: BOOKS }) } }).start();
  await flush();
  return actor;
};

const shown = (actor) => shownOf(actor.getSnapshot().context);

test("the journal open at the start shows the written view", async () => {
  assert.equal(shown(await start(JOURNAL)), "written");
});

test("an ordinary book, or none, shows the reader", async () => {
  assert.equal(shown(await start(BOOK)), "reader");
  assert.equal(shown(await start(null)), "reader");
});

test("opening the journal and then a book switches the view each time", async () => {
  const actor = await start(null);
  actor.send({ type: "book.opened", id: JOURNAL });
  await flush();
  assert.equal(shown(actor), "written");
  actor.send({ type: "book.opened", id: BOOK });
  await flush();
  assert.equal(shown(actor), "reader");
  actor.send({ type: "book.opened", id: null });
  await flush();
  assert.equal(shown(actor), "reader");
});

test("deleting the open book shows the reader; a change to another book is ignored", async () => {
  const actor = await start(JOURNAL);
  actor.send({ type: "book.changed", id: BOOK, written: false });
  assert.equal(shown(actor), "written");
  actor.send({ type: "book.deleted", id: JOURNAL });
  assert.equal(shown(actor), "reader");
});

test("a page without books shows the reader", async () => {
  const actor = createActor(machine, { input: { ask: () => Promise.resolve({ error: "no-answerer" }) } }).start();
  await flush();
  assert.equal(shown(actor), "reader");
  assert.equal(actor.getSnapshot().value.show, "ready");
});

// The tab list (3.1): what the stage announces and what it asks books to open, driven
// with a fake storage and the emits collected from the actor.
const OTHER = "01HYYYYYYYYYYYYYYYYYYYYYYY";
const THIRD = "01HXXXXXXXXXXXXXXXXXXXXXXX";
const LIBRARY = { ...BOOKS, [OTHER]: { id: OTHER, title: "Emma" }, [THIRD]: { id: THIRD, title: "Ulysses" } };
const KEY = "book-stage.tabs";

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
};

const tabbed = async ({ openId = null, stored, books = LIBRARY, storage = fakeStorage(stored ? { [KEY]: JSON.stringify(stored) } : {}) } = {}) => {
  const actor = createActor(machine, { input: { ask: fakeAsk({ openId, books }), address: "book-stage", storage } });
  const shownEvents = [];
  const switched = [];
  actor.on("tabs.shown", (e) => shownEvents.push(e));
  actor.on("book.switched", (e) => switched.push(e.id));
  actor.start();
  await flush();
  return { actor, storage, shownEvents, switched, last: () => shownEvents.at(-1) };
};

const ids = (shown) => shown.tabs.map((t) => t.id);
const open = async (actor, id) => {
  actor.send({ type: "book.opened", id });
  await flush();
};

test("the open book gets a tab at the start, labelled, announced once, and stored", async () => {
  const { shownEvents, storage } = await tabbed({ openId: BOOK });
  assert.equal(shownEvents.length, 1);
  assert.deepEqual(shownEvents[0], { type: "tabs.shown", view: "book-stage", tabs: [{ id: BOOK, label: "Dune", closable: false }], active: BOOK });
  assert.deepEqual(JSON.parse(storage.data[KEY]), [BOOK]);
});

test("the journal's tab says Journal", async () => {
  const { last } = await tabbed({ openId: JOURNAL, books: { [JOURNAL]: { id: JOURNAL, title: "My days", written: true } } });
  assert.equal(last().tabs[0].label, "Journal");
});

test("opening a book with no tab adds it at the end; re-opening one only brings it forward", async () => {
  const { actor, last, storage } = await tabbed({ openId: BOOK });
  await open(actor, OTHER);
  await open(actor, JOURNAL);
  assert.deepEqual(ids(last()), [BOOK, OTHER, JOURNAL]);
  assert.equal(last().active, JOURNAL);
  await open(actor, BOOK);
  assert.deepEqual(ids(last()), [BOOK, OTHER, JOURNAL]);
  assert.equal(last().active, BOOK);
  assert.deepEqual(JSON.parse(storage.data[KEY]), [BOOK, OTHER, JOURNAL]);
  assert.ok(last().tabs.every((t) => t.closable));
});

test("the stored tabs come back in order, and ids the account does not have are dropped", async () => {
  const gone = "01HWWWWWWWWWWWWWWWWWWWWWWW";
  const { last, storage } = await tabbed({ openId: OTHER, stored: [THIRD, gone, BOOK, OTHER] });
  assert.deepEqual(ids(last()), [THIRD, BOOK, OTHER]);
  assert.equal(last().active, OTHER);
  assert.deepEqual(JSON.parse(storage.data[KEY]), [THIRD, BOOK, OTHER]);
});

test("unreadable storage starts with no tabs but the open book", async () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const { last } = await tabbed({ openId: BOOK, storage: broken });
  assert.deepEqual(ids(last()), [BOOK]);
  const { last: last2 } = await tabbed({ openId: BOOK, storage: fakeStorage({ [KEY]: "not json" }) });
  assert.deepEqual(ids(last2()), [BOOK]);
});

test("picking a tab asks books to switch; another view's pick or the front tab is ignored", async () => {
  const { actor, switched, last } = await tabbed({ openId: BOOK, stored: [BOOK, OTHER] });
  actor.send({ type: "tab.picked", view: "dock-desk", id: OTHER });
  actor.send({ type: "tab.picked", view: "book-stage", id: BOOK });
  assert.deepEqual(switched, []);
  actor.send({ type: "tab.picked", view: "book-stage", id: OTHER });
  assert.deepEqual(switched, [OTHER]);
  assert.equal(last().active, OTHER);
});

test("closing the front tab brings its right neighbour forward, or its left one at the end", async () => {
  const { actor, switched, last } = await tabbed({ openId: OTHER, stored: [BOOK, OTHER, THIRD] });
  actor.send({ type: "tab.closed", view: "book-stage", id: OTHER });
  assert.deepEqual(ids(last()), [BOOK, THIRD]);
  assert.deepEqual(switched, [THIRD]);
  assert.equal(last().active, THIRD);
  await open(actor, THIRD);
  actor.send({ type: "book.closed", id: THIRD });
  assert.deepEqual(switched, [THIRD, BOOK]);
  assert.deepEqual(ids(last()), [BOOK]);
  assert.equal(last().tabs[0].closable, false);
});

test("closing a tab behind the front one switches nothing", async () => {
  const { actor, switched, last, storage } = await tabbed({ openId: OTHER, stored: [BOOK, OTHER] });
  actor.send({ type: "tab.closed", view: "book-stage", id: BOOK });
  assert.deepEqual(switched, []);
  assert.deepEqual(ids(last()), [OTHER]);
  assert.equal(last().active, OTHER);
  assert.deepEqual(JSON.parse(storage.data[KEY]), [OTHER]);
});

test("the last tab cannot be closed, and another view's close is ignored", async () => {
  const { actor, switched, shownEvents } = await tabbed({ openId: BOOK });
  actor.send({ type: "tab.closed", view: "book-stage", id: BOOK });
  actor.send({ type: "book.closed", id: BOOK });
  assert.equal(shownEvents.length, 1);
  const two = await tabbed({ openId: BOOK, stored: [BOOK, OTHER] });
  two.actor.send({ type: "tab.closed", view: "book-stage#other", id: BOOK });
  assert.deepEqual(ids(two.last()), [BOOK, OTHER]);
  assert.deepEqual([...switched, ...two.switched], []);
});

test("a deleted book loses its tab, and the front one hands over to its neighbour", async () => {
  const { actor, switched, last } = await tabbed({ openId: OTHER, stored: [BOOK, OTHER, THIRD] });
  actor.send({ type: "book.deleted", id: BOOK });
  assert.deepEqual(ids(last()), [OTHER, THIRD]);
  assert.deepEqual(switched, []);
  actor.send({ type: "book.deleted", id: OTHER });
  assert.deepEqual(ids(last()), [THIRD]);
  assert.deepEqual(switched, [THIRD]);
});

test("labels follow book.changed; a change that leaves them alone announces nothing", async () => {
  const { actor, last, shownEvents } = await tabbed({ openId: BOOK });
  actor.send({ type: "book.changed", id: BOOK, title: "Dune" });
  assert.equal(shownEvents.length, 1);
  actor.send({ type: "book.changed", id: BOOK, title: "Dune Messiah" });
  assert.equal(last().tabs[0].label, "Dune Messiah");
  assert.equal(shownEvents.length, 2);
});

test("a book opened before books lists it gets its tab when its label arrives", async () => {
  const NEW = "01HVVVVVVVVVVVVVVVVVVVVVVV";
  const { actor, last } = await tabbed({ openId: BOOK });
  await open(actor, NEW);
  assert.deepEqual(ids(last()), [BOOK]);
  actor.send({ type: "book.changed", id: NEW, title: "New" });
  assert.deepEqual(ids(last()), [BOOK, NEW]);
  assert.equal(last().active, NEW);
});

test("a tab still waiting for its label neither keeps the last drawn tab closable nor takes the front", async () => {
  const NEW = "01HVVVVVVVVVVVVVVVVVVVVVVV";
  const lone = await tabbed({ openId: BOOK });
  await open(lone.actor, NEW);
  await open(lone.actor, BOOK);
  lone.actor.send({ type: "book.closed", id: BOOK });
  assert.deepEqual(ids(lone.last()), [BOOK], "the one drawn tab stays");
  assert.deepEqual(lone.switched, []);

  const { actor, switched, last } = await tabbed({ openId: BOOK });
  await open(actor, NEW);
  await open(actor, OTHER);
  await open(actor, BOOK);
  actor.send({ type: "tab.closed", view: "book-stage", id: BOOK });
  assert.deepEqual(switched, [OTHER], "the next drawn tab comes forward, past the hidden one");
  assert.deepEqual(ids(last()), [OTHER]);
});

test("a page without books announces no tabs", async () => {
  const actor = createActor(machine, { input: { ask: () => Promise.resolve({ error: "no-answerer" }), address: "book-stage", storage: fakeStorage() } });
  const seen = [];
  actor.on("tabs.shown", (e) => seen.push(e));
  actor.start();
  await flush();
  assert.deepEqual(seen, []);
  assert.deepEqual(tabsOf(actor.getSnapshot().context).tabs, []);
});

test("moving a tab trades places with its neighbour, is stored, and keeps the front", async () => {
  const { actor, last, storage, switched } = await tabbed({ openId: OTHER, stored: [BOOK, OTHER, THIRD] });
  actor.send({ type: "tab.moved", view: "book-stage", id: OTHER, step: -1 });
  assert.deepEqual(ids(last()), [OTHER, BOOK, THIRD]);
  actor.send({ type: "tab.moved", view: "book-stage", id: OTHER, step: 1 });
  actor.send({ type: "tab.moved", view: "book-stage", id: OTHER, step: 1 });
  assert.deepEqual(ids(last()), [BOOK, THIRD, OTHER]);
  assert.equal(last().active, OTHER);
  assert.deepEqual(switched, []);
  assert.deepEqual(JSON.parse(storage.data[KEY]), [BOOK, THIRD, OTHER]);
});

test("a move past either end does nothing", async () => {
  const { actor, shownEvents } = await tabbed({ openId: BOOK, stored: [BOOK, OTHER] });
  const before = shownEvents.length;
  actor.send({ type: "tab.moved", view: "book-stage", id: BOOK, step: -1 });
  actor.send({ type: "tab.moved", view: "book-stage", id: OTHER, step: 1 });
  assert.equal(shownEvents.length, before);
});

test("the moved order comes back after a restore", async () => {
  const { actor, storage } = await tabbed({ openId: BOOK, stored: [BOOK, OTHER, THIRD] });
  actor.send({ type: "tab.moved", view: "book-stage", id: BOOK, step: 1 });
  const again = await tabbed({ openId: BOOK, storage });
  assert.deepEqual(ids(again.last()), [OTHER, BOOK, THIRD]);
});

test("another view's move is ignored", async () => {
  const { actor, last, shownEvents } = await tabbed({ openId: BOOK, stored: [BOOK, OTHER] });
  const before = shownEvents.length;
  actor.send({ type: "tab.moved", view: "book-stage#other", id: BOOK, step: 1 });
  assert.equal(shownEvents.length, before);
  assert.deepEqual(ids(last()), [BOOK, OTHER]);
});

// Note tabs: notes the user opened on the stage, labelled from `notes`, shown by the
// stage's note editor, which the stage tells what to show by command (4.4).
const NOTE_A = "01J0000000000000000000000A";
const NOTE_B = "01J0000000000000000000000B";
const NOTES = [{ id: NOTE_A, title: "Plans" }, { id: NOTE_B, title: "" }];

const NOTES_KEY = KEY + ".notes";

const staging = async ({ openId = BOOK, stored, storedNotes, notes = NOTES } = {}) => {
  const initial = {};
  if (stored) initial[KEY] = JSON.stringify(stored);
  if (storedNotes) initial[NOTES_KEY] = JSON.stringify(storedNotes);
  const storage = fakeStorage(initial);
  const books = fakeAsk({ openId, books: LIBRARY });
  const ask = (target, name, payload) =>
    target === "notes" && name === "list" ? Promise.resolve({ notes }) : books(target, name, payload);
  const sent = [];
  const send = (target, name, payload) => sent.push({ target, name, ...payload });
  const actor = createActor(machine, { input: { ask, send, address: "book-stage", storage } });
  const shownEvents = [];
  const switched = [];
  actor.on("tabs.shown", (e) => shownEvents.push(e));
  actor.on("book.switched", (e) => switched.push(e.id));
  actor.start();
  await flush();
  return { actor, storage, sent, switched, last: () => shownEvents.at(-1) };
};

test("a staged note gets a tab at the end, in front, labelled by its title, and its editor is told", async () => {
  const { actor, last, sent, switched, storage } = await staging();
  actor.send({ type: "note.staged", id: NOTE_A });
  assert.deepEqual(last().tabs, [
    { id: BOOK, label: "Dune", closable: true },
    { id: NOTE_A, label: "Plans", closable: true },
  ]);
  assert.equal(last().active, NOTE_A);
  assert.equal(shownOf(actor.getSnapshot().context), "note");
  assert.deepEqual(sent, [{ target: "note-editor#stage", name: "load", id: NOTE_A }]);
  assert.deepEqual(switched, [], "the open book stays, so the subject does not move");
  assert.deepEqual(JSON.parse(storage.data[KEY]), [BOOK, NOTE_A]);
  assert.deepEqual(JSON.parse(storage.data[NOTES_KEY]), [NOTE_A]);
});

test("a note with no title says Untitled, and a renamed note's tab follows note.changed", async () => {
  const { actor, last } = await staging();
  actor.send({ type: "note.staged", id: NOTE_B });
  assert.equal(last().tabs[1].label, "Untitled");
  actor.send({ type: "note.changed", id: NOTE_B, title: "Later" });
  assert.equal(last().tabs[1].label, "Later");
});

test("staging a note already on the stage brings its tab forward without a second tab", async () => {
  const { actor, last, sent } = await staging();
  actor.send({ type: "note.staged", id: NOTE_A });
  actor.send({ type: "note.staged", id: NOTE_B });
  actor.send({ type: "note.staged", id: NOTE_A });
  assert.deepEqual(ids(last()), [BOOK, NOTE_A, NOTE_B]);
  assert.equal(last().active, NOTE_A);
  actor.send({ type: "note.staged", id: NOTE_A });
  assert.deepEqual(sent.map((c) => c.id), [NOTE_A, NOTE_B, NOTE_A], "the tab in front is not reloaded");
});

test("picking a note tab shows it; picking the book's tab, or opening a book, brings the book back", async () => {
  const { actor, last, sent, switched } = await staging();
  actor.send({ type: "note.staged", id: NOTE_A });
  actor.send({ type: "tab.picked", view: "book-stage", id: BOOK });
  assert.equal(last().active, BOOK);
  assert.equal(shownOf(actor.getSnapshot().context), "reader");
  assert.deepEqual(switched, [], "the book is already open");
  actor.send({ type: "tab.picked", view: "book-stage", id: NOTE_A });
  assert.equal(last().active, NOTE_A);
  assert.equal(sent.length, 2);
  await open(actor, OTHER);
  assert.equal(last().active, OTHER);
  assert.deepEqual(ids(last()), [BOOK, NOTE_A, OTHER], "the note tab stays when another book opens");
  assert.equal(shownOf(actor.getSnapshot().context), "reader");
});

test("closing a note tab, by its × or by :q in its editor, removes it and leaves the note alone", async () => {
  const { actor, last, switched } = await staging();
  actor.send({ type: "note.staged", id: NOTE_A });
  actor.send({ type: "note.staged", id: NOTE_B });
  actor.send({ type: "tab.closed", view: "book-stage", id: NOTE_B });
  assert.deepEqual(ids(last()), [BOOK, NOTE_A]);
  assert.equal(last().active, NOTE_A, "the tab to its left comes forward");
  actor.send({ type: "note.closed", id: NOTE_A });
  assert.deepEqual(ids(last()), [BOOK]);
  assert.equal(last().active, BOOK);
  assert.deepEqual(switched, [], "the open book comes back without opening anything");
});

test("the last tab cannot be closed, even a note's", async () => {
  const { actor, last } = await staging();
  actor.send({ type: "note.staged", id: NOTE_A });
  actor.send({ type: "tab.closed", view: "book-stage", id: BOOK });
  assert.deepEqual(ids(last()), [NOTE_A]);
  actor.send({ type: "note.closed", id: NOTE_A });
  assert.deepEqual(ids(last()), [NOTE_A]);
});

test("a deleted note loses its tab, and the book beside it comes forward", async () => {
  const { actor, last } = await staging();
  actor.send({ type: "note.staged", id: NOTE_A });
  actor.send({ type: "note.deleted", id: NOTE_A });
  assert.deepEqual(ids(last()), [BOOK]);
  assert.equal(shownOf(actor.getSnapshot().context), "reader");
});

test("stored note tabs come back with the book tabs, and one the account does not have is dropped", async () => {
  const gone = "01J000000000000000000000ZZ";
  const { last, storage } = await staging({ stored: [NOTE_A, BOOK, gone], storedNotes: [NOTE_A, gone] });
  assert.deepEqual(ids(last()), [NOTE_A, BOOK]);
  assert.equal(last().active, BOOK, "after a reload the open book is in front");
  assert.deepEqual(JSON.parse(storage.data[NOTES_KEY]), [NOTE_A]);
});

test("a list stored before note tabs reads as books", async () => {
  const { last } = await staging({ stored: [OTHER, BOOK] });
  assert.deepEqual(ids(last()), [OTHER, BOOK]);
});

// --- Signed out (14) -------------------------------------------------------------------

const SIGNED_IN = { userId: "u1", registrationOpen: false, guest: false, name: "Ann" };
const SIGNED_OUT = { userId: null, registrationOpen: true, guest: false, name: null };

// The stage with a book open and the journal's tab beside it; session as given, or missing.
const hidden = async (session, tryPage = false) => {
  const books = fakeAsk({ openId: OTHER, books: LIBRARY });
  const ask = (target, name, payload) => (target === "session" ? Promise.resolve(session ?? { error: "no-answerer" }) : books(target, name, payload));
  const storage = fakeStorage({ [KEY]: JSON.stringify([JOURNAL, OTHER]) });
  const actor = createActor(machine, { input: { ask, address: "book-stage", storage, tryPage } });
  const shownEvents = [];
  actor.on("tabs.shown", (e) => shownEvents.push(e));
  actor.start();
  await flush();
  return { actor, storage, shownEvents, ctx: () => actor.getSnapshot().context, last: () => shownEvents.at(-1) };
};

test("signed out the stage asks to sign in and draws no tabs; signed in, or with no session to ask, it shows", async () => {
  assert.equal(showing({ tryPage: false, signedIn: null }), "wait", "nothing until session answers");
  const out = await hidden(SIGNED_OUT);
  assert.equal(showing(out.ctx()), "sign-in");
  assert.deepEqual(out.last(), { type: "tabs.shown", view: "book-stage", tabs: [], active: null }, "no tab of the account is drawn");
  assert.deepEqual(JSON.parse(out.storage.data[KEY]), [JOURNAL, OTHER], "the tabs stay stored");
  const signedIn = await hidden(SIGNED_IN);
  assert.equal(showing(signedIn.ctx()), "show");
  assert.deepEqual(ids(signedIn.last()), [JOURNAL, OTHER]);
  assert.equal(showing((await hidden()).ctx()), "show", "a page without session counts as signed in");
});

test("on a try page a visitor not yet signed in sees the stage", async () => {
  const { ctx, last } = await hidden(SIGNED_OUT, true);
  assert.equal(showing(ctx()), "show");
  assert.deepEqual(ids(last()), [JOURNAL, OTHER]);
});

test("signing in brings back the same tabs and the same book in front without a reload, and signing out hides them", async () => {
  const { actor, ctx, last, shownEvents } = await hidden(SIGNED_OUT);
  actor.send({ type: "session.changed", ...SIGNED_IN });
  assert.equal(showing(ctx()), "show");
  assert.deepEqual(ids(last()), [JOURNAL, OTHER]);
  assert.equal(last().active, OTHER);
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(ctx()), "sign-in");
  assert.deepEqual(last().tabs, []);
  const count = shownEvents.length;
  actor.send({ type: "session.changed", ...SIGNED_OUT, registrationOpen: false });
  assert.equal(shownEvents.length, count, "news that changes nothing draws nothing again");
});
