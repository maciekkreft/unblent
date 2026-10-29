import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shortName } from "../machine.js";

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
  assert.deepEqual(changed.at(-1), {
    type: "subject.changed",
    subject: { kind: "book", id: "b1", title: "Dune", view: "book-reader" },
  });
  assert.deepEqual(await readSubject(actor), { subject: { kind: "book", id: "b1", title: "Dune", view: "book-reader" } });
});

test("an instance-suffixed stage still resolves the kind and reports its address", async () => {
  const { changed } = start({ stage: "book-reader#2", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b1", title: "Dune", view: "book-reader#2" });
});

test("no open book means no subject, and nothing is announced", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: null, books: {} });
  await flush();
  assert.equal(changed.length, 0);
  assert.deepEqual(await readSubject(actor), { subject: null });
});

test("a view about the subject in front, with a book open, is still the subject (reload)", async () => {
  // No view that shows a thing has been in front this session, so the showing view
  // falls back to the first row of the table (3.1), the product's book stage: the
  // open book is the subject.
  const { actor, changed } = start({ stage: "note-list", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b1", title: "Dune", view: "book-stage" });
  assert.deepEqual(await readSubject(actor), { subject: { kind: "book", id: "b1", title: "Dune", view: "book-stage" } });
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
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b2", title: "Emma", view: "book-reader" });
});

test("a rename of the open book changes the subject's title", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({ type: "book.changed", id: "b1", title: "Dune (1965)" });
  await flush();
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b1", title: "Dune (1965)", view: "book-reader" });
});

test("a change to another book is ignored", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({ type: "book.changed", id: "b9", title: "Other" });
  await flush();
  assert.equal(changed.length, 0);
  assert.deepEqual(await readSubject(actor), { subject: { kind: "book", id: "b1", title: "Dune", view: "book-reader" } });
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

test("a view about the subject coming to the front keeps the subject and announces nothing", async () => {
  // The reader showed the book; bringing highlight-notes to the front does not
  // replace it, because it is a view about the subject (3.1).
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: { id: "b1", title: "Dune" } } });
  await flush();
  changed.length = 0;
  actor.send({ type: "dock.changed", stage: "highlight-notes", docks: {} });
  await flush();
  assert.equal(changed.length, 0);
  assert.deepEqual(await readSubject(actor), { subject: { kind: "book", id: "b1", title: "Dune", view: "book-reader" } });
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

test("a chapter's short name: lowercase, digits kept, accents plain, other runs one hyphen", () => {
  assert.equal(shortName("Chapter 12"), "chapter-12");
  assert.equal(shortName("1984"), "1984");
  assert.equal(shortName("Zażółć gęślą jaźń, Łódź"), "zazolc-gesla-jazn-lodz");
  assert.equal(shortName("Straße, Æsir & Œuvre — Øst"), "strasse-aesir-oeuvre-ost");
  assert.equal(shortName("  “Hello, World!” (part 2)…  "), "hello-world-part-2");
  assert.equal(shortName(""), "");
  assert.equal(shortName("— * —"), "");
  assert.equal(shortName(undefined), "");
});

const chaptered = {
  id: "b1",
  title: "Dune",
  chapters: [{ title: "Book One: Dune" }, { title: "Rozdział Ósmy" }, { title: "***" }],
  position: { chapter: 0, block: 3 },
};

test("a book's open chapter rides the subject, named by its title", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: chaptered } });
  await flush();
  const subject = { kind: "book", id: "b1", title: "Dune", view: "book-reader", chapter: "book-one-dune", chapterTitle: "Book One: Dune" };
  assert.deepEqual(changed.at(-1).subject, subject);
  assert.deepEqual(await readSubject(actor), { subject });
});

test("moving to another chapter is announced; moving within one is not", async () => {
  const { actor, changed } = start({ stage: "book-reader", openId: "b1", books: { b1: chaptered } });
  await flush();
  changed.length = 0;
  actor.send({ type: "book.changed", ...chaptered, position: { chapter: 0, block: 9 } });
  await flush();
  assert.equal(changed.length, 0);
  actor.send({ type: "book.changed", ...chaptered, position: { chapter: 1, block: 0 } });
  await flush();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].subject.chapter, "rozdzial-osmy");
  assert.equal(changed[0].subject.chapterTitle, "Rozdział Ósmy");
  // A title with no letter or digit has no short name, so the subject has no chapter.
  actor.send({ type: "book.changed", ...chaptered, position: { chapter: 2, block: 0 } });
  await flush();
  assert.deepEqual(changed.at(-1).subject, { kind: "book", id: "b1", title: "Dune", view: "book-reader" });
});

const JRN = "00000000000000000000000JRN";
const journalBook = {
  id: JRN,
  title: "Journal",
  written: true,
  chapters: [{ title: "Monday 26 October", day: "2026-10-26" }, { title: "Thursday 29 October", day: "2026-10-29" }],
  position: { chapter: 1, block: 0 },
};

test("the Journal's open chapter is the day its page shows, from journal: open and day.shown", async () => {
  const state = { stage: "book-stage", openId: JRN, books: { [JRN]: journalBook } };
  const base = fakeAsk(state);
  const ask = (target, name, payload) =>
    target === "journal" && name === "open"
      ? Promise.resolve({ shown: { day: "2026-10-26", text: "", writable: false } })
      : base(target, name, payload);
  const changed = [];
  const actor = createActor(machine, { input: { ask } });
  actor.on("subject.changed", (e) => changed.push(e));
  actor.start();
  await flush();
  assert.equal(changed.at(-1).subject.chapter, "2026-10-26");
  assert.equal(changed.at(-1).subject.chapterTitle, "Monday 26 October");
  actor.send({ type: "day.shown", day: "2026-10-29", writable: true });
  await flush();
  assert.equal(changed.at(-1).subject.chapter, "2026-10-29");
  assert.equal(changed.at(-1).subject.chapterTitle, "Thursday 29 October");
  // A day the book does not list yet is still named, by its date.
  actor.send({ type: "day.shown", day: "2026-10-27" });
  await flush();
  assert.deepEqual(
    [changed.at(-1).subject.chapter, changed.at(-1).subject.chapterTitle],
    ["2026-10-27", "2026-10-27"],
  );
});

test("with no journal page the Journal's open chapter is the day of its reading place", async () => {
  const { changed } = start({ stage: "book-stage", openId: JRN, books: { [JRN]: journalBook } });
  await flush();
  assert.equal(changed.at(-1).subject.chapter, "2026-10-29");
});
