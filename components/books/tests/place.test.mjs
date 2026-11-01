import { test } from "node:test";
import assert from "node:assert/strict";
import { blockTexts, placeFrom, PLACE_WORDS } from "../machine.js";

// books: place, the chat's "where you are in it" (7.7): books, real, on the real bus with
// its real schemas (the kit, 10), with the store and the chapter fetch faked. A probe asks
// as the chat's loop would, so every reply is checked against the place schema.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { ask } = await import("bus");

const BOOK = "01K7TEST00000000000000BK01";
const probe = { config: { id: "probe", meta: { kind: "view", asks: ["books: place"] } } };
const place = () => ask(probe, "books", "place", {});

const record = (position) => ({
  id: BOOK, title: "Meditations", fileTitle: "Meditations", author: "Marcus Aurelius", fileAuthor: "Marcus Aurelius",
  cover: null, chapters: [{ title: "Book One" }, { title: "Book Two" }], toc: [], position,
  version: 1, contentVersion: 3, addedAt: 1, updatedAt: 1, deleted: false,
});

function store(books, open) {
  const meta = new Map([["open", open]]);
  return {
    all: () => Promise.resolve(books),
    put: () => Promise.resolve(),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
    clear: () => Promise.resolve(),
  };
}

const CHAPTER = '<h2>Book Two</h2><figure><img src="a.png" alt=""></figure><p>Begin the morning &amp; say: <em>I shall meet</em> the busy.</p><p>Second.</p>';

async function start(position, chapter = async () => ({ html: CHAPTER })) {
  const fetched = [];
  const api = { chapter: async (...args) => (fetched.push(args), chapter(...args)), pull: async () => ({ books: [], cursor: 0 }) };
  const wired = await wire(["books"], { books: { store: store([record(position)], { id: BOOK, at: 1 }), now: () => 5, api, revoke: () => {} } });
  await until(() => wired.actors.books.getSnapshot().matches("ready"));
  return { ...wired, fetched };
}

test("blockTexts counts each top-level element one block, its text everything inside it", () => {
  assert.deepEqual(blockTexts(CHAPTER), ["Book Two", "", "Begin the morning & say: I shall meet the busy.", "Second."]);
  assert.deepEqual(blockTexts("<p>A<br>B &#233;&#x41;</p>\n<hr><ul><li>x</li><li>y</li></ul>"), ["AB éA", "", "xy"], "void elements open no block, text between blocks is none");
  assert.deepEqual(blockTexts(""), []);
});

test("placeFrom takes the paragraph at the place whole, then the next ones up to the word limit", () => {
  const long = Array.from({ length: PLACE_WORDS + 5 }, (_, i) => `w${i}`).join(" ");
  assert.deepEqual(placeFrom(["a b", "", "c d e", "f"], 0), { block: 0, text: "a b\n\nc d e\n\nf", words: 6 }, "an empty block is passed over");
  assert.deepEqual(placeFrom(["a", "b"], 9), { block: 1, text: "b", words: 1 }, "a place past the end is the last block");
  const cut = placeFrom([long, "next"], 0);
  assert.equal(cut.words, PLACE_WORDS);
  assert.ok(cut.text.endsWith("…") && !cut.text.includes("next"), "a first paragraph past the limit is cut");
  const two = Array.from({ length: 200 }, () => "x").join(" ");
  assert.equal(placeFrom([two, two], 0).words, 200, "a next paragraph that would pass the limit is left out");
});

test("place answers the open book's chapter and the text at the reading place", async () => {
  const { fetched, unwire } = await start({ chapter: 1, block: 2 });
  try {
    assert.deepEqual(await place(), {
      id: BOOK, title: "Meditations", author: "Marcus Aurelius", chapter: 1, chapterTitle: "Book Two",
      block: 2, text: "Begin the morning & say: I shall meet the busy.\n\nSecond.", words: 11,
    });
    assert.deepEqual(fetched, [[BOOK, 3, 1]], "the chapter of the reading place, at the book's content version");
  } finally {
    unwire();
  }
});

test("place answers honestly when nothing is open or the chapter cannot be fetched", async () => {
  const offline = await start({ chapter: 0, block: 0 }, async () => {
    throw new Error("offline");
  });
  try {
    assert.deepEqual(await place(), { error: "unavailable" });
  } finally {
    offline.unwire();
  }
  const wired = await wire(["books"], { books: { store: store([], { id: null, at: 0 }), now: () => 5, api: null, revoke: () => {} } });
  try {
    await until(() => wired.actors.books.getSnapshot().matches("ready"));
    assert.deepEqual(await place(), { id: null });
  } finally {
    wired.unwire();
  }
});
