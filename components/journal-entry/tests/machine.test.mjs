import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, conflictOn, shown, longDate, parseBody, serialize, selectedOf } from "../machine.js";

// The entry's decisions (3.2): which day is shown, whether it can be typed in, and what
// is saved when. Times are built with the local Date constructor, so the midnight cases
// hold in any time zone.

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["day.saved"].map((n) => [n, schema(n)]));

const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();

const id = (tag, n) => `01K7TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const [TODAY, SUNDAY, FRESH] = [id("Y", 1), id("Y", 2), id("F", 1)];

const day = (did, date, text, extra = {}) => ({ id: did, day: date, text, editedAt: at(12, 21), version: 1, waiting: [], unanswered: [], ...extra });
const picture = (over = {}) => ({ days: [], open: null, ...over });

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

// --- The shown day ---------------------------------------------------------------------

test("the entry shows the picked earlier day read only, else the open day, else a new page", () => {
  const today = day(TODAY, "2026-10-12", "Now.");
  const sunday = day(SUNDAY, "2026-10-11", "Then.");
  const p = picture({ days: [sunday, today], open: TODAY });
  assert.deepEqual([shown(p, SUNDAY, FRESH, at(12, 9)).day.id, shown(p, SUNDAY, FRESH, at(12, 9)).editable], [SUNDAY, false]);
  assert.deepEqual([shown(p, TODAY, FRESH, at(12, 9)).day.id, shown(p, null, FRESH, at(12, 9)).editable], [TODAY, true]);
  const blank = shown({ ...p, open: null }, null, FRESH, at(13, 9));
  assert.deepEqual([blank.day.id, blank.day.day, blank.editable], [FRESH, "2026-10-13", true]);
  assert.equal(longDate("2026-10-12"), "Monday 12 October");
});

test("a conflict on the shown day can be kept only while the day is open", () => {
  const c = { id: TODAY, mine: { text: "Mine.", baseVersion: 1 }, theirs: { text: "Theirs.", version: 2, editedAt: at(12, 9) } };
  assert.deepEqual(conflictOn(c, day(TODAY, "2026-10-12", "Theirs."), true), { mine: "Mine.", theirs: "Theirs.", keepable: true });
  assert.equal(conflictOn(c, day(TODAY, "2026-10-12", "Theirs."), false).keepable, false);
  assert.equal(conflictOn(c, day(SUNDAY, "2026-10-11", "Other."), false), null);
  assert.equal(conflictOn(null, day(TODAY, "2026-10-12", ""), true), null);
});

// --- The actor -------------------------------------------------------------------------

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function start(p, { now = at(12, 21), books = {}, asked = [] } = {}) {
  const clock = new SimulatedClock();
  let n = 0;
  const actor = createActor(machine, {
    input: {
      ask: (target, name, payload) => {
        if (target === "books") {
          asked.push(payload.id);
          return Promise.resolve(books[payload.id] ? { book: books[payload.id] } : { error: "not-found" });
        }
        return Promise.resolve(target === "journal" ? p : {});
      },
      mint: () => (n++ === 0 ? FRESH : id("F", n)),
      now: () => now,
      throttleMs: 200,
    },
    clock,
  });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted, clock };
}

const changed = (p) => ({ type: "journal.changed", ...p });

test("typing is saved at the throttle, and leaving the box saves once more, saying so", async () => {
  const today = day(TODAY, "2026-10-12", "First.");
  const { actor, emitted, clock } = await start(picture({ days: [today], open: TODAY }));
  actor.send({ type: "_edit", text: "First.\nSec" });
  actor.send({ type: "_edit", text: "First.\nSecond" });
  assert.equal(emitted.length, 0);
  clock.increment(200);
  assert.deepEqual(emitted, [{ type: "day.saved", id: TODAY, text: "First.\nSecond" }]);
  // The journal's echo keeps what is on screen while it matches the draft.
  actor.send(changed(picture({ days: [{ ...today, text: "First.\nSecond" }], open: TODAY })));
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted[1], { type: "day.saved", id: TODAY, text: "First.\nSecond", left: true });
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 2, "a second blur with nothing typed saves nothing");
  valid(emitted);
});

test("a new page is saved under a fresh id, and the next new page gets another", async () => {
  const { actor, emitted, clock } = await start(picture());
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 0, "an untouched new page saves nothing");
  actor.send({ type: "_edit", text: "Hello" });
  clock.increment(200);
  assert.deepEqual(emitted, [{ type: "day.saved", id: FRESH, text: "Hello" }]);
  const made = day(FRESH, "2026-10-12", "Hello");
  actor.send(changed(picture({ days: [made], open: FRESH })));
  assert.equal(actor.getSnapshot().context.draft.id, FRESH);
  // The day closes: the new page is a new day.
  actor.send(changed(picture({ days: [made], open: null })));
  assert.notEqual(actor.getSnapshot().context.fresh, FRESH);
  assert.equal(actor.getSnapshot().context.draft.id, actor.getSnapshot().context.fresh);
});

test("an earlier day is read only", async () => {
  const sunday = day(SUNDAY, "2026-10-11", "A.");
  const today = day(TODAY, "2026-10-12", "Now.");
  const { actor, emitted, clock } = await start(picture({ days: [sunday, today], open: TODAY }));
  actor.send({ type: "day.selected", id: SUNDAY });
  assert.equal(actor.getSnapshot().context.draft, null);
  actor.send({ type: "_edit", text: "Rewritten." });
  clock.increment(200);
  assert.equal(emitted.length, 0, "nothing on an earlier day is saved");
});

test("picking another day while typing saves the typing first", async () => {
  const sunday = day(SUNDAY, "2026-10-11", "A.");
  const today = day(TODAY, "2026-10-12", "Now.");
  const { actor, emitted } = await start(picture({ days: [sunday, today], open: TODAY }));
  actor.send({ type: "_edit", text: "Now and then." });
  actor.send({ type: "day.selected", id: SUNDAY });
  assert.deepEqual(emitted, [{ type: "day.saved", id: TODAY, text: "Now and then." }]);
});

test("a conflict shows both copies, and Keep yours saves the user's copy in one step", async () => {
  const today = day(TODAY, "2026-10-12", "Theirs.", { version: 3 });
  const { actor, emitted } = await start(picture({ days: [today], open: TODAY }));
  actor.send({ type: "journal.conflicted", id: TODAY, mine: { text: "Mine.", baseVersion: 2 }, theirs: { text: "Theirs.", version: 3, editedAt: at(12, 20) } });
  assert.equal(actor.getSnapshot().context.conflict.mine.text, "Mine.");
  actor.send({ type: "_keepMine" });
  assert.deepEqual(emitted, [{ type: "day.saved", id: TODAY, text: "Mine." }]);
  assert.equal(actor.getSnapshot().context.conflict, null);
  assert.equal(actor.getSnapshot().context.draft.text, "Mine.");
});

test("on a closed day the other copy stays: Keep yours does nothing, Done clears it", async () => {
  const sunday = day(SUNDAY, "2026-10-11", "Theirs.");
  const { actor, emitted } = await start(picture({ days: [sunday], open: null }));
  actor.send({ type: "journal.conflicted", id: SUNDAY, mine: { text: "Mine.", baseVersion: 1 }, theirs: { text: "Theirs.", version: 2, editedAt: at(11, 20) } });
  actor.send({ type: "_keepMine" });
  assert.equal(emitted.length, 0);
  actor.send({ type: "_keepTheirs" });
  assert.equal(actor.getSnapshot().context.conflict, null);
});

test("Vim keys start from settings: read and follow settings.changed", async () => {
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    input: {
      ask: (target) => Promise.resolve(target === "settings" ? { vimKeys: true } : target === "journal" ? picture() : {}),
      mint: () => FRESH,
      now: () => at(12, 9),
    },
    clock,
  });
  actor.start();
  assert.equal(actor.getSnapshot().context.vimKeys, false, "off before the reply");
  await flush();
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
});

test("a journal that cannot answer is an honest failure", async () => {
  const { actor } = await start({ error: "no-answerer" });
  assert.ok(actor.getSnapshot().matches("failed"));
});

// --- Levels ----------------------------------------------------------------------------

test("a day's text carries its levels as line prefixes, and the edited document has none", () => {
  const wire = "# Monday\n## Run\n### Plan\nTen km.";
  const { doc, levels } = parseBody(wire);
  assert.equal(doc, "Monday\nRun\nPlan\nTen km.");
  assert.deepEqual(levels, ["title", "heading", "subheading", "body"]);
  assert.equal(serialize(doc, levels), wire);
  assert.deepEqual(parseBody(""), { doc: "", levels: ["body"] });
  assert.equal(serialize("", ["title"]), "", "a blank page is empty, never a lone marker");
});

test("a blank line is a paragraph gap, never a marker, and typed blank lines round-trip unchanged", () => {
  assert.equal(serialize("Monday\n\nRan", ["title", "title", "body"]), "# Monday\n\nRan");
  const wire = "## Title\n\nPara one\n\nPara two\n\n";
  const { doc, levels } = parseBody(wire);
  assert.equal(doc, "Title\n\nPara one\n\nPara two\n\n");
  assert.equal(serialize(doc, levels), wire);
});

// --- Following the journal book ----------------------------------------------------------

const JOURNAL = "00000000000000000000000JRN";
const OTHER = id("B", 1);
const journalBook = { id: JOURNAL, title: "Journal", author: "You", cover: null, chapters: [], toc: [], position: { chapter: 0, block: 0 }, version: 1, written: true };
const otherBook = { ...journalBook, id: OTHER, title: "A novel", author: "Someone", written: undefined };
const BOOKS = { [JOURNAL]: journalBook, [OTHER]: otherBook };
const showing = (actor) => {
  const { context } = actor.getSnapshot();
  const v = shown(context.picture, selectedOf(context), context.fresh, context.now());
  return [v.day.id, v.editable];
};

test("with no day open, an earlier chapter shows its day read only, and the last is today's page", async () => {
  const [d1, d2] = [day(SUNDAY, "2026-10-10", "One."), day(TODAY, "2026-10-11", "Two.")];
  const { actor } = await start(picture({ days: [d1, d2], open: null }), { books: BOOKS });
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 0 });
  await flush();
  assert.deepEqual(showing(actor), [SUNDAY, false]);
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 1 });
  assert.deepEqual(showing(actor), [TODAY, false], "the answer is cached: no second ask needed");
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 2 });
  assert.deepEqual(showing(actor), [FRESH, true], "one chapter past the days is today's page");
});

test("with a day open, the last chapter is that day, editable, and opening the journal shows it", async () => {
  const [d1, d2] = [day(SUNDAY, "2026-10-11", "One."), day(TODAY, "2026-10-12", "Two.")];
  const { actor } = await start(picture({ days: [d1, d2], open: TODAY }), { books: BOOKS });
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 0 });
  await flush();
  assert.deepEqual(showing(actor), [SUNDAY, false]);
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 1 });
  assert.deepEqual(showing(actor), [TODAY, true]);
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 0 });
  actor.send({ type: "book.opened", id: JOURNAL });
  assert.deepEqual(showing(actor), [TODAY, true]);
});

test("another book's opening and chapters are ignored, and each book is asked about once", async () => {
  const asked = [];
  const sunday = day(SUNDAY, "2026-10-11", "One.");
  const { actor } = await start(picture({ days: [sunday], open: null }), { books: BOOKS, asked });
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 0 });
  await flush();
  actor.send({ type: "book.opened", id: OTHER });
  actor.send({ type: "chapter.selected", id: OTHER, chapter: 3 });
  await flush();
  actor.send({ type: "chapter.selected", id: OTHER, chapter: 1 });
  actor.send({ type: "book.opened", id: null });
  await flush();
  assert.deepEqual(showing(actor), [SUNDAY, false]);
  assert.deepEqual(asked, [JOURNAL, OTHER]);
});

test("book.changed and book.deleted keep whether a book is written current", async () => {
  const asked = [];
  const sunday = day(SUNDAY, "2026-10-11", "One.");
  const { actor } = await start(picture({ days: [sunday], open: null }), { books: BOOKS, asked });
  actor.send({ type: "book.changed", ...journalBook });
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 0 });
  assert.deepEqual(showing(actor), [SUNDAY, false], "known from book.changed, so shown at once");
  assert.deepEqual(asked, []);
  actor.send({ type: "book.deleted", id: JOURNAL });
  actor.send({ type: "book.opened", id: JOURNAL });
  await flush();
  assert.deepEqual(asked, [JOURNAL], "forgotten on delete, so asked again");
});

test("the Days list's pick still works after following a chapter, and a pick while typing saves first", async () => {
  const [d1, d2] = [day(SUNDAY, "2026-10-11", "One."), day(TODAY, "2026-10-12", "Two.")];
  const { actor, emitted } = await start(picture({ days: [d1, d2], open: TODAY }), { books: BOOKS });
  actor.send({ type: "book.changed", ...journalBook });
  actor.send({ type: "_edit", text: "Two and more." });
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 0 });
  assert.deepEqual(emitted, [{ type: "day.saved", id: TODAY, text: "Two and more." }]);
  assert.deepEqual(showing(actor), [SUNDAY, false]);
  actor.send({ type: "day.selected", id: null });
  assert.deepEqual(showing(actor), [TODAY, true]);
  valid(emitted);
});

// --- Announcing the shown day ------------------------------------------------------------

const DAY_SHOWN = schema("day.shown");

// The day.shown dates an actor emits, in order, each checked against its schema.
const announced = (actor) => {
  const days = [];
  actor.on("day.shown", ({ type, ...rest }) => {
    assert.ok(new Validator(DAY_SHOWN, "2020-12").validate(rest).valid, "day.shown");
    days.push(rest.day);
  });
  return days;
};

async function startShowing(p, now = () => at(12, 21)) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    input: {
      ask: (target, name, payload) =>
        Promise.resolve(target === "journal" ? p : target === "books" ? (BOOKS[payload.id] ? { book: BOOKS[payload.id] } : { error: "not-found" }) : {}),
      mint: () => FRESH,
      now,
    },
    clock,
  });
  const days = announced(actor);
  actor.start();
  assert.deepEqual(days, [], "nothing before the page has loaded");
  await flush();
  return { actor, days, clock };
}

test("the shown day is announced once the page has loaded, and again only when it moves", async () => {
  const [d1, d2] = [day(SUNDAY, "2026-10-11", "One."), day(TODAY, "2026-10-12", "Two.")];
  const p = picture({ days: [d1, d2], open: TODAY });
  const { actor, days } = await startShowing(p);
  assert.deepEqual(days, ["2026-10-12"]);
  actor.send({ type: "day.selected", id: SUNDAY });
  actor.send({ type: "day.selected", id: SUNDAY });
  actor.send(changed(p));
  assert.deepEqual(days, ["2026-10-12", "2026-10-11"], "the same day again is not announced");
  actor.send({ type: "_edit", text: "x" });
  actor.send({ type: "day.selected", id: null });
  assert.deepEqual(days, ["2026-10-12", "2026-10-11", "2026-10-12"]);
});

test("following the journal book announces each chapter's day, and the last chapter today's", async () => {
  const [d1, d2] = [day(SUNDAY, "2026-10-10", "One."), day(TODAY, "2026-10-11", "Two.")];
  const { actor, days } = await startShowing(picture({ days: [d1, d2], open: null }));
  assert.deepEqual(days, ["2026-10-12"], "no day open: today's empty page");
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 0 });
  await flush();
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 1 });
  actor.send({ type: "chapter.selected", id: JOURNAL, chapter: 2 });
  actor.send({ type: "book.opened", id: JOURNAL });
  assert.deepEqual(days, ["2026-10-12", "2026-10-10", "2026-10-11", "2026-10-12"]);
});

test("at midnight today's empty page announces the new day, and an earlier day stays put", async () => {
  let now = at(12, 23, 59);
  const { actor, days, clock } = await startShowing(picture(), () => now);
  assert.deepEqual(days, ["2026-10-12"]);
  now = at(13, 0, 0) + 1000;
  clock.increment(at(13) - at(12, 23, 59) + 1000);
  assert.deepEqual(days, ["2026-10-12", "2026-10-13"]);
  // The next midnight is set again from the new day.
  now = at(14, 0, 0) + 1000;
  clock.increment(at(14) - at(13));
  assert.deepEqual(days, ["2026-10-12", "2026-10-13", "2026-10-14"]);
  // A day written yesterday, picked in the Days list, does not move at midnight.
  actor.send(changed(picture({ days: [day(SUNDAY, "2026-10-11", "One.")], open: null })));
  actor.send({ type: "day.selected", id: SUNDAY });
  now = at(15, 0, 0) + 1000;
  clock.increment(at(15) - at(14));
  assert.deepEqual(days, ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-11"]);
});

test("yesterday kept open past midnight is announced writable, and announced again when the journal closes it", async () => {
  const late = day(TODAY, "2026-10-12", "Late.", { editedAt: at(12, 23, 50) });
  const said = [];
  const now = at(13, 0, 10);
  const { actor } = await startShowing(picture({ days: [late], open: TODAY }), () => now);
  actor.on("day.shown", ({ day: d, writable }) => said.push([d, writable]));
  assert.equal(actor.getSnapshot().context.shownWritable, true, "announced writable at load");
  // Picked in the Days list it stays the open day, so nothing new is said.
  actor.send({ type: "day.selected", id: TODAY });
  assert.deepEqual(said, []);
  // The journal's own close: the same day, now read only.
  actor.send(changed(picture({ days: [late], open: null })));
  assert.deepEqual(said, [["2026-10-12", false]]);
  // Following the open day instead moves on to today's empty page.
  actor.send({ type: "day.selected", id: null });
  assert.deepEqual(said, [["2026-10-12", false], ["2026-10-13", true]]);
});
