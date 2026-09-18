import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake bus `ask` that
// answers dock: read, books: open and books: read from a small state object, the
// shapes fact.js wires for real. subject stores nothing, so there is no store or clock.
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeAsk(state) {
  return (target, name, payload = {}) => {
    if (target === "dock" && name === "read") return Promise.resolve({ stage: state.stage, docks: {} });
    if (target === "books" && name === "open") return Promise.resolve({ id: state.openId });
    if (target === "books" && name === "read") {
      const book = state.books[payload.id];
      return Promise.resolve(book ? { book } : { error: "not-found" });
    }
    return Promise.resolve({});
  };
}

function start(state) {
  const changed = [];
  const actor = createActor(machine, { input: { ask: fakeAsk(state) } });
  actor.on("subject.changed", (e) => changed.push(e));
  actor.start();
  return { actor, changed };
}

const readSubject = (actor) =>
  new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: {}, reply }));

test("a book on the stage becomes the subject and is announced", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  assert.deepEqual(changed.at(-1), { type: "subject.changed", subject: { kind: "book", id: "b1", title: "Dune" } });
  assert.deepEqual(await readSubject(actor), { subject: { kind: "book", id: "b1", title: "Dune" } });
});

test("an instance-suffixed stage still resolves the kind", async () => {
  const { changed } = start({ stage: "book-reader#2", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b1", title: "Dune" });
});

test("no open book means no subject, and nothing is announced", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: null, books: {} });
  await flush();
  assert.equal(changed.length, 0);
  assert.deepEqual(await readSubject(actor), { subject: null });
});

test("a stage that is not the reader is no subject", async () => {
  const { actor, changed } = start({ stage: "note-list", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  assert.equal(changed.length, 0);
  assert.deepEqual(await readSubject(actor), { subject: null });
});

test("read is answered null before the first asks land", async () => {
  const actor = createActor(machine, { input: { ask: () => new Promise(() => {}) } });
  actor.start();
  assert.deepEqual(await readSubject(actor), { subject: null });
});

test("opening another book switches the subject", async () => {
  const { actor, changed } = start({
    stage: "book-reader",
    openId: "b1",
    books: { b1: { id: "b1", title: "Dune" }, b2: { id: "b2", title: "Emma" } },
  });
  await flush();
  changed.length = 0;
  actor.send({ type: "book.opened", id: "b2" });
  await flush();
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b2", title: "Emma" });
});

test("a rename of the open book changes the subject's title", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({ type: "book.changed", id: "b1", title: "Dune (1965)" });
  await flush();
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b1", title: "Dune (1965)" });
});

test("a change to another book is ignored", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({ type: "book.changed", id: "b9", title: "Other" });
  await flush();
  assert.equal(changed.length, 0);
  assert.deepEqual(await readSubject(actor), { subject: { kind: "book", id: "b1", title: "Dune" } });
});

test("deleting the open book clears the subject", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({ type: "book.deleted", id: "b1" });
  await flush();
  assert.deepEqual(changed.at(-1), { type: "subject.changed", subject: null });
  assert.deepEqual(await readSubject(actor), { subject: null });
});

test("moving another view onto the stage clears the subject", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({ type: "dock.changed", stage: "note-list", docks: {} });
  await flush();
  assert.deepEqual(changed.at(-1).subject, null);
});

test("a dock re-arrangement that keeps the staged view announces nothing", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({
    type: "dock.changed",
    stage: "book-reader",
    docks: { left: { open: true, views: ["book-shelf"], active: "book-shelf" } },
  });
  await flush();
  assert.equal(changed.length, 0);
});
