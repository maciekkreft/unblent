import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shownOf } from "../machine.js";

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
  assert.equal(actor.getSnapshot().value, "ready");
});
