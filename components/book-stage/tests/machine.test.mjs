import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shownOf, tabsOf } from "../machine.js";

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
