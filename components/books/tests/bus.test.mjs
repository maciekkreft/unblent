import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): books with its partner journal, real machines on the real bus, so the
// journal book is derived from what journal really answers and announces. Both stores
// are faked in memory, and nobody is signed in, so neither syncs. The gestures that
// views emit are sent straight to the fact that consumes them, as the bus would deliver
// them; the questions are asked through the bus by a probe, so every reply is checked
// against books' own schemas.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { ask } = await import("bus");

const JOURNAL = "00000000000000000000000JRN";
const OLD = "01K7TEST00000000000000DA01";
const RECENT = "01K7TEST00000000000000DA02";
const TODAY = "01K7TEST00000000000000DA03";

// 10:00 on Tuesday 13 October 2026, local time, so the dates hold in any time zone.
const NOW = new Date(2026, 9, 13, 10).getTime();
const at = (y, m, d) => new Date(y, m - 1, d, 20).getTime();

const probe = {
  config: { id: "probe", meta: { kind: "view", asks: ["books: list", "books: read", "books: chapter", "books: open"] } },
};
const query = (name, payload = {}) => ask(probe, "books", name, payload);

function journalStore(days) {
  const tables = { days: new Map(days.map((r) => [r.id, r])) };
  return {
    all: (t) => Promise.resolve([...tables[t].values()]),
    put: (t, r) => (tables[t].set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: () => Promise.resolve(undefined),
    metaPut: () => Promise.resolve(),
  };
}

function booksStore() {
  const meta = new Map();
  return {
    meta,
    all: () => Promise.resolve([]),
    put: () => Promise.resolve(),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
    clear: () => Promise.resolve(),
  };
}

const DAYS = [
  { id: OLD, day: "2025-12-31", text: "Last of the year.", editedAt: at(2025, 12, 31), version: 1 },
  { id: RECENT, day: "2026-10-11", text: "# Sunday\n## Morning\n### Early\nA walk & <talk>.\nBack.\n\nHome.", editedAt: at(2026, 10, 11), version: 1 },
];

async function start({ days = DAYS, names = ["journal", "books"] } = {}) {
  const store = booksStore();
  const inputs = {
    journal: { store: journalStore(days), now: () => NOW },
    books: { store, now: () => NOW, api: null, revoke: () => {} },
  };
  const wired = await wire(names, inputs);
  const emitted = (type) => wired.records.filter((r) => r.kind === "event" && r.name === type).map((r) => r.payload);
  return { ...wired, store, emitted };
}

test("the journal is the first book, its days the chapters oldest first and the contents newest first", async () => {
  const { actors, emitted, unwire } = await start();
  try {
    await until(() => actors.books.getSnapshot().context.journal !== null);
    const { books } = await query("list");
    assert.equal(books.length, 1);
    assert.deepEqual(books[0], {
      id: JOURNAL, title: "Journal", author: "You", cover: null,
      position: { chapter: 2, block: 0 }, chapterCount: 3, pending: false, addedAt: 0, written: true,
    });
    const { book } = await query("read", { id: JOURNAL });
    // No day is open, so today's empty page is one more chapter at the end; a day of
    // another year carries its year.
    assert.deepEqual(book.chapters.map((c) => c.title), ["Wednesday 31 December 2025", "Sunday 11 October", "Tuesday 13 October"]);
    // Each chapter names its day, today's empty page included, so a view can count by day.
    assert.deepEqual(book.chapters.map((c) => c.day), ["2025-12-31", "2026-10-11", "2026-10-13"]);
    assert.deepEqual(book.toc.map((e) => [e.title, e.chapter]), [["Tuesday 13 October", 2], ["Sunday 11 October", 1], ["Wednesday 31 December 2025", 0]]);
    assert.deepEqual(book.position, { chapter: 2, block: 0 });
    assert.equal(book.written, true);
    assert.equal(emitted("book.changed").filter((b) => b.id === JOURNAL).length, 1);
  } finally {
    unwire();
  }
});

test("a journal chapter is the day's text as HTML, answered without the network", async () => {
  const { actors, unwire } = await start();
  try {
    await until(() => actors.books.getSnapshot().context.journal !== null);
    assert.deepEqual(await query("chapter", { id: JOURNAL, chapter: 1 }), {
      title: "Sunday 11 October",
      html: "<h1>Sunday</h1><h2>Morning</h2><h3>Early</h3><p>A walk &amp; &lt;talk&gt;.<br>Back.</p><p>Home.</p>",
    });
    assert.deepEqual(await query("chapter", { id: JOURNAL, chapter: 2 }), { title: "Tuesday 13 October", html: "" });
    assert.deepEqual(await query("chapter", { id: JOURNAL, chapter: 3 }), { error: "not-found" });
  } finally {
    unwire();
  }
});

test("writing today makes the open day the last chapter, announced once with a newer version", async () => {
  const { actors, emitted, unwire } = await start();
  try {
    await until(() => actors.books.getSnapshot().context.journal !== null);
    const first = emitted("book.changed").at(-1);
    actors.journal.send({ type: "day.saved", id: TODAY, text: "Today." });
    await until(() => emitted("book.changed").length === 2);
    const next = emitted("book.changed").at(-1);
    assert.ok(next.version > first.version);
    assert.deepEqual(next.chapters.map((c) => c.title), ["Wednesday 31 December 2025", "Sunday 11 October", "Tuesday 13 October"]);
    assert.deepEqual(await query("chapter", { id: JOURNAL, chapter: 2 }), { title: "Tuesday 13 October", html: "<p>Today.</p>" });
    // A further keystroke changes the chapter's text, which is news; one that changes
    // nothing a reader sees is not.
    actors.journal.send({ type: "day.saved", id: TODAY, text: "Today.", left: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted("book.changed").length, 2);
  } finally {
    unwire();
  }
});

test("renaming, discarding and turning a page ignore the journal; selecting it opens it and keeps it open", async () => {
  const { actors, emitted, store, unwire } = await start();
  try {
    await until(() => actors.books.getSnapshot().context.journal !== null);
    actors.books.send({ type: "book.renamed", id: JOURNAL, title: "Diary" });
    actors.books.send({ type: "book.discarded", id: JOURNAL });
    actors.books.send({ type: "book.progressed", id: JOURNAL, chapter: 0, block: 3 });
    assert.equal(emitted("book.deleted").length, 0);
    assert.equal(emitted("book.changed").length, 1);
    assert.equal((await query("read", { id: JOURNAL })).book.title, "Journal");

    actors.books.send({ type: "book.selected", id: JOURNAL });
    assert.deepEqual(emitted("book.opened").map((e) => e.id), [JOURNAL]);
    assert.deepEqual(await query("open"), { id: JOURNAL });
    assert.equal(store.meta.get("open").id, JOURNAL);
  } finally {
    unwire();
  }
});

test("without journal on the page there is no journal book", async () => {
  const { actors, emitted, unwire } = await start({ names: ["books"] });
  try {
    await until(() => actors.books.getSnapshot().matches("ready"));
    assert.deepEqual(await query("list"), { books: [] });
    assert.deepEqual(await query("read", { id: JOURNAL }), { error: "not-found" });
    actors.books.send({ type: "book.selected", id: JOURNAL });
    assert.deepEqual(emitted("book.opened"), []);
  } finally {
    unwire();
  }
});
