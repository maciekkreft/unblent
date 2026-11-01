import { test } from "node:test";
import assert from "node:assert/strict";

// The chat's notes lookups (7.7): notes, real, on the real bus with its real schemas (the
// kit, 10), its store faked in memory and nobody signed in. A probe asks as the chat's
// loop would, so every reply is checked against the find and highlights schemas.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { ask } = await import("bus");

const probe = { config: { id: "probe", meta: { kind: "view", asks: ["notes: find", "notes: highlights"] } } };
const find = (payload = {}) => ask(probe, "notes", "find", payload);
const highlights = (payload = {}) => ask(probe, "notes", "highlights", payload);

const BOOK = "01K7TEST00000000000000BK01";
const JOURNAL = "00000000000000000000000JRN";
// Noon on a day of October 2026, local time, so the dates hold in any time zone.
const at = (d) => new Date(2026, 9, d, 12).getTime();
// A ULID made at `ms`, as the browser makes a note's id (5).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const idAt = (ms, tail) => {
  let n = ms;
  let time = "";
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[n % 32] + time;
    n = Math.floor(n / 32);
  }
  return time + tail;
};

const place = (chapter) => ({ chapter, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 4 } });
const quote = (exact) => ({ exact, prefix: "", suffix: "" });

const A = idAt(at(1), "0000000000000000");
const B = idAt(at(2), "0000000000000001");
const C = idAt(at(3), "0000000000000002");
const H1 = idAt(at(4), "0000000000000003");
const H2 = idAt(at(5), "0000000000000004");
const GONE = idAt(at(6), "0000000000000005");

const NOTES = [
  { id: A, title: "Stoics", body: "Stoics\nOn the morning routine of Marcus", version: 1, updatedAt: at(9), about: [{ kind: "book", id: BOOK, chapter: "book-two", chapterTitle: "Book Two" }] },
  { id: B, title: "Mum", body: "Mum\n\nA CALL about the move", version: 1, updatedAt: at(2), about: [{ kind: "book", id: JOURNAL, chapter: "2026-10-02", chapterTitle: "Friday 2 October" }] },
  { id: C, title: "Loose", body: "Loose", version: 1, updatedAt: at(3), about: [] },
  { id: H1, title: "", body: "use this on Monday", version: 1, updatedAt: at(4), about: [{ kind: "book", id: BOOK, chapter: "book-two", chapterTitle: "Book Two", place: place(1), quote: quote("Thoughts are just words") }] },
  { id: H2, title: "", body: "", version: 1, updatedAt: at(5), about: [{ kind: "book", id: BOOK, place: place(0), quote: quote("Begin the morning") }] },
  { id: GONE, title: "Gone", body: "Gone", version: 2, updatedAt: at(6), about: [], deleted: true },
];

function memory(notes) {
  const rows = new Map(notes.map((n) => [n.id, n]));
  return {
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
    empty: async () => rows.clear(),
  };
}

async function start(notes = NOTES) {
  const wired = await wire(["notes"], { notes: { store: memory(notes), now: () => at(20), api: null } });
  await until(() => wired.actors.notes.getSnapshot().matches("ready"));
  return wired;
}

test("find lists the notes without highlights, newest first, short, with how many match", async () => {
  const { unwire } = await start();
  try {
    const all = await find();
    assert.deepEqual([all.total, all.more], [3, 0], "highlights and the deleted note are left out");
    assert.deepEqual(all.notes.map((n) => n.id), [A, C, B], "newest first by last change");
    assert.deepEqual(all.notes[0], {
      id: A, title: "Stoics", line: "On the morning routine of Marcus", updatedAt: at(9),
      about: [{ kind: "book", id: BOOK, chapter: "book-two", chapterTitle: "Book Two" }],
    });
    const one = await find({ limit: 1 });
    assert.deepEqual([one.notes.length, one.total, one.more], [1, 3, 2]);
    assert.deepEqual((await find({ book: BOOK })).notes.map((n) => n.id), [A]);
    assert.deepEqual((await find({ chapter: "Book Two" })).notes.map((n) => n.id), [A], "a chapter by its title");
    assert.deepEqual((await find({ book: JOURNAL, chapter: "2026-10-02" })).notes.map((n) => n.id), [B], "a journal chapter by its date");
    assert.deepEqual((await find({ book: JOURNAL, chapter: "Book Two" })).notes, [], "the chapter is of the named book");
    assert.deepEqual((await find({ contains: "a call" })).notes.map((n) => n.id), [B], "contains ignores case");
    assert.deepEqual((await find({ day: "2026-10-01" })).notes.map((n) => n.id), [A], "the day a note was made");
    assert.deepEqual((await find({ day: "2026-10-09" })).notes.map((n) => n.id), [A], "the day a note last changed");
    assert.deepEqual(await find({ limit: 51 }), { error: "invalid-payload" });
  } finally {
    unwire();
  }
});

test("a long line is cut at 25 words", async () => {
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
  const { unwire } = await start([{ id: A, title: "T", body: `T\n${words.join(" ")}`, version: 1, updatedAt: 1, about: [] }]);
  try {
    assert.equal((await find()).notes[0].line, `${words.slice(0, 25).join(" ")}…`);
  } finally {
    unwire();
  }
});

test("highlights lists each passage and comment, newest first, narrowed by book and chapter", async () => {
  const { unwire } = await start();
  try {
    const all = await highlights();
    assert.deepEqual([all.total, all.more], [2, 0]);
    assert.deepEqual(all.highlights, [
      { id: H2, passage: "Begin the morning", comment: "", book: BOOK, chapter: 0, updatedAt: at(5) },
      { id: H1, passage: "Thoughts are just words", comment: "use this on Monday", book: BOOK, chapter: 1, chapterTitle: "Book Two", updatedAt: at(4) },
    ]);
    assert.deepEqual((await highlights({ book: BOOK, chapter: 1 })).highlights.map((h) => h.id), [H1]);
    assert.deepEqual(await highlights({ book: JOURNAL }), { highlights: [], total: 0, more: 0 });
    const one = await highlights({ limit: 1 });
    assert.deepEqual([one.highlights.length, one.total, one.more], [1, 2, 1]);
  } finally {
    unwire();
  }
});
