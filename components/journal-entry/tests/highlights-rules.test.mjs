import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, JOURNAL, marksOf, markAt, pastKey, wordAround, fingerPassage, pointOf, posOf, addToNote, highlightsOf, titleOf, sourceLink } from "../machine.js";

// What the entry decides about highlights on an earlier day: where a place is in the text,
// what a key does there, and what each gesture announces. What a press does on screen is
// in highlights.test.mjs.
const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));

const OLD = "01K7TEST00000000000000DY01";
const OLDER = "01K7TEST00000000000000DY00";
const OPEN = "01K7TEST00000000000000DY02";
const NOTE = "01K7TEST00000000000000NT01";
const OTHER = "01K7TEST00000000000000NT02";
const MINTED = "01K7TEST00000000000000MNT1";
const TEXT = "# A title\nFirst line here.\n\nSecond line there.";
const DOC = "A title\nFirst line here.\n\nSecond line there.";

const day = (id, date, text) => ({ id, day: date, text, editedAt: 1, version: 1, waiting: [], unanswered: [] });
const picture = { days: [day(OLDER, "2026-10-10", "Older."), day(OLD, "2026-10-11", TEXT), day(OPEN, "2026-10-12", "Today")], open: OPEN, today: "2026-10-12" };

const place = (start, end, chapter = 1) => ({ chapter, contentVersion: 0, start, end });
const highlight = (id, start, end, exact, extra = {}) => ({
  id,
  title: "",
  updatedAt: 1,
  about: [{ kind: "book", id: JOURNAL, chapter: "2026-10-11", chapterTitle: "Sunday 11 October", place: place(start, end), quote: { exact, prefix: "", suffix: "" } }],
  ...extra,
});
// "First" and "line" of the doc's second line, by position.
const FIRST = highlight(NOTE, { block: 1, offset: 0 }, { block: 1, offset: 5 }, "First");

async function start({ notes = [], open = null, read = {}, pushed = [] } = {}) {
  const actor = createActor(machine, {
    input: {
      ask: (target, name, payload) => {
        if (target === "journal") return Promise.resolve(picture);
        if (target === "notes" && name === "list") return Promise.resolve({ notes });
        if (target === "notes" && name === "open") return Promise.resolve(open ? { note: { id: open } } : {});
        if (target === "notes" && name === "read") return Promise.resolve(read[payload.id] ? { note: read[payload.id] } : { error: "not-found" });
        return Promise.resolve({});
      },
      mint: (() => {
        let n = 0;
        return () => (n++ === 0 ? "01K7TEST00000000000000FRSH" : MINTED);
      })(),
      now: () => 1,
      pushRegister: (text) => pushed.push(text),
    },
  });
  const emitted = [];
  for (const type of machine.config.meta.emits) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await new Promise((done) => setTimeout(done));
  actor.send({ type: "day.selected", id: OLD });
  return { actor, emitted, of: (type) => emitted.filter((e) => e.type === type) };
}

const valid = (event) => {
  const { type, ...rest } = event;
  assert.ok(new Validator(schema(type), "2020-12").validate(rest).valid, type);
};

test("a position in the text and a line and an offset are the same place", () => {
  const pos = DOC.indexOf("Second");
  assert.deepEqual(pointOf(DOC, pos), { block: 3, offset: 0 });
  assert.equal(posOf(DOC, { block: 3, offset: 0 }), pos);
  assert.equal(posOf(DOC, { block: 9, offset: 0 }), null);
  assert.equal(posOf(DOC, { block: 0, offset: 99 }), null);
});

test("a day paints its own highlights, finds a moved quote again, and leaves out a lost one", () => {
  const [first] = highlightsOf([FIRST]);
  const from = DOC.indexOf("First");
  assert.deepEqual(marksOf([first], "2026-10-11", DOC), [{ id: NOTE, from, to: from + 5, commented: false, exact: "First" }]);
  assert.deepEqual(marksOf([first], "2026-10-10", DOC), [], "another day's highlight is not painted");
  assert.equal(marksOf([first], "2026-10-11", `Kept copy.\n${DOC}`)[0].from, from + "Kept copy.\n".length, "the text moved under it");
  assert.deepEqual(marksOf([first], "2026-10-11", "Nothing like it"), [], "its quote is gone");
});

test("the cursor is inside a highlight from its first letter up to its end", () => {
  const marks = [{ id: NOTE, from: 4, to: 8 }];
  assert.equal(markAt(marks, 3), null);
  assert.equal(markAt(marks, 4).id, NOTE);
  assert.equal(markAt(marks, 7).id, NOTE);
  assert.equal(markAt(marks, 8), null);
});

test("only a link to the Journal that names a day and a place is a highlight on a day", () => {
  const book = { id: OTHER, title: "", about: [{ kind: "book", id: "01K7TEST00000000000000BK01", place: place({ block: 0, offset: 0 }, { block: 0, offset: 1 }), quote: { exact: "x" } }] };
  const plain = { id: OTHER, title: "", about: [{ kind: "book", id: JOURNAL, chapter: "2026-10-11", chapterTitle: "t" }] };
  assert.deepEqual(highlightsOf([book, plain]), []);
  assert.equal(highlightsOf([{ ...FIRST, title: "A comment" }])[0].commented, true);
});

const vim = (over = {}) => ({ insertMode: false, visualMode: false, inputState: {}, ...over });
const key = (k, over = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...over });

test("on an earlier day Vim's edits stop, its motions go on, and u stays the global Undo", () => {
  for (const k of ["i", "A", "o", "O", "x", "p", "J", "c", "s", "D"]) assert.equal(pastKey(key(k), vim()), "block", k);
  for (const k of ["h", "j", "k", "l", "w", "b", "G", "g", "$", "0", "v", "V", ":", "Escape"]) assert.equal(pastKey(key(k), vim()), "vim", k);
  assert.equal(pastKey(key("u"), vim()), "global");
  assert.equal(pastKey(key("r", { ctrlKey: true }), vim()), "global");
  assert.equal(pastKey(key("d", { ctrlKey: true }), vim()), "vim", "half a page down");
  assert.equal(pastKey(key("a", { ctrlKey: true }), vim()), "block", "Vim's number increment");
  for (const k of ["y", "a", "d"]) assert.equal(pastKey(key(k), vim()), k);
  assert.equal(pastKey(key("Enter"), vim()), "enter");
});

test("a half-typed command stays Vim's, so gx and gg still work", () => {
  const half = vim({ inputState: { keyBuffer: ["g"] } });
  assert.equal(pastKey(key("x"), half), "vim");
  assert.equal(pastKey(key("g"), half), "vim");
});

test("in Vim's visual mode y copies, Enter makes, and the edits stop", () => {
  const visual = vim({ visualMode: true });
  assert.equal(pastKey(key("y"), visual), "yank");
  assert.equal(pastKey(key("Enter"), visual), "make");
  for (const k of ["d", "x", "c", "u", "p"]) assert.equal(pastKey(key(k), visual), "block", k);
  for (const k of ["w", "b", "i", "a", "o", "Escape"]) assert.equal(pastKey(key(k), visual), "vim", k);
});

test("a finger's passage keeps its word fixed and runs either way from it", () => {
  const flat = "one two three four";
  const word = wordAround(flat, flat.indexOf("three") + 1);
  assert.deepEqual(word, [8, 13]);
  assert.deepEqual(fingerPassage(flat, word, flat.indexOf("four") + 1), [8, 18], "after it");
  assert.deepEqual(fingerPassage(flat, word, 1), [0, 13], "before it");
  assert.deepEqual(fingerPassage(flat, word, 9), word, "back on it");
  assert.deepEqual(wordAround(flat, 3), [0, 3], "on a blank, the word before it");
  assert.deepEqual(wordAround("  word", 0), [2, 6], "with none before it, the one after");
});

test("a selection makes one highlight linked to the day, with the day's number as its chapter", async () => {
  const { actor, of } = await start();
  const from = DOC.indexOf("line here");
  actor.send({ type: "_highlight", from, to: from + 4, exact: true, open: true });
  const [saved] = of("note.saved");
  valid(saved);
  assert.equal(saved.id, MINTED);
  assert.equal(saved.left, true, "one step of its own");
  const [link] = saved.about;
  assert.equal(link.id, JOURNAL);
  assert.equal(link.chapter, "2026-10-11");
  assert.equal(link.place.chapter, 1, "the day's number, oldest first");
  assert.deepEqual(link.place.start, { block: 1, offset: 6 });
  assert.deepEqual(link.place.end, { block: 1, offset: 10 });
  assert.equal(link.quote.exact, "line");
  assert.equal(actor.getSnapshot().context.reveal.id, MINTED, "the mouse and the finger open its bubble");
});

test("the keyboard's highlight is exact and leaves the bubble closed; a drag grows to whole words", async () => {
  const { actor, of } = await start();
  const from = DOC.indexOf("line here");
  actor.send({ type: "_highlight", from: from + 1, to: from + 3, exact: true });
  assert.equal(of("note.saved")[0].about[0].quote.exact, "in");
  assert.equal(actor.getSnapshot().context.reveal, null);
  actor.send({ type: "_highlight", from: from + 6, to: from + 8, exact: false });
  assert.equal(of("note.saved")[1].about[0].quote.exact, "here");
});

test("a selection across lines quotes them joined, and blank space at its ends is dropped", async () => {
  const { actor, of } = await start();
  actor.send({ type: "_highlight", from: DOC.indexOf("here"), to: DOC.indexOf("Second") + 6, exact: true });
  const [link] = of("note.saved")[0].about;
  assert.equal(link.quote.exact, "here.\n\nSecond");
  assert.deepEqual(link.place.end, { block: 3, offset: 6 });
  actor.send({ type: "_highlight", from: DOC.indexOf("\n\n"), to: DOC.indexOf("Second"), exact: true });
  assert.equal(of("note.saved").length, 1, "nothing but white space makes nothing");
});

test("today's page, and two copies waiting, take no highlight", async () => {
  const { actor, of } = await start();
  actor.send({ type: "journal.conflicted", id: OLD, mine: { text: "a" }, theirs: { text: "b" } });
  actor.send({ type: "_highlight", from: 0, to: 3, exact: true });
  assert.equal(of("note.saved").length, 0, "two copies");
  actor.send({ type: "_keepTheirs" });
  actor.send({ type: "day.selected", id: OPEN });
  actor.send({ type: "_highlight", from: 0, to: 3, exact: true });
  assert.equal(of("note.saved").filter((e) => e.about).length, 0, "today");
});

test("a selection wholly inside a highlight only opens its bubble", async () => {
  const { actor, of } = await start({ notes: [FIRST] });
  const from = DOC.indexOf("First");
  actor.send({ type: "_highlight", from: from + 1, to: from + 3, exact: true });
  assert.equal(of("note.saved").length, 0);
  assert.equal(actor.getSnapshot().context.reveal.id, NOTE);
});

test("a selection that touches a highlight merges them, comments stacked, the earliest surviving", async () => {
  const line = highlight(OTHER, { block: 1, offset: 6 }, { block: 1, offset: 10 }, "line");
  const read = { [NOTE]: { ...FIRST, body: "Mine", version: 3 }, [OTHER]: { ...line, body: "Yours", version: 2 } };
  const { actor, of } = await start({ notes: [FIRST, line], read });
  const from = DOC.indexOf("First");
  actor.send({ type: "_highlight", from: from + 3, to: from + 8, exact: true, open: true });
  await new Promise((done) => setTimeout(done));
  const [saved] = of("note.saved");
  valid(saved);
  assert.equal(saved.id, NOTE);
  assert.equal(saved.body, "Mine\n\nYours");
  assert.equal(saved.title, "Mine");
  assert.equal(saved.baseVersion, 3);
  assert.equal(saved.about[0].quote.exact, "First line");
  assert.deepEqual(of("note.discarded").map((e) => e.id), [OTHER]);
  assert.equal(actor.getSnapshot().context.reveal.id, NOTE);
});

test("notes' news keeps the highlights current, and a Remove goes through notes", async () => {
  const { actor, of } = await start();
  actor.send({ type: "note.changed", ...FIRST, body: "", version: 1 });
  assert.equal(actor.getSnapshot().context.highlights.length, 1);
  actor.send({ type: "_remove", id: OTHER });
  assert.equal(of("note.discarded").length, 0, "not a highlight here");
  actor.send({ type: "_remove", id: NOTE });
  assert.deepEqual(of("note.discarded").map((e) => e.id), [NOTE]);
  actor.send({ type: "note.deleted", id: NOTE });
  assert.equal(actor.getSnapshot().context.highlights.length, 0);
});

test("Add to note is greyed with its reason, and adds to the note open in the Notes panel", async () => {
  const context = { hidden: [], opened: null, holding: {} };
  assert.equal(addToNote({ ...context, hidden: ["slip-box"] }, NOTE), null, "Slip-Box hidden: no button");
  assert.equal(addToNote(context, NOTE).why, "Open a note first");
  assert.equal(addToNote({ ...context, opened: NOTE }, NOTE).why, "Already in this note");
  assert.equal(addToNote({ ...context, opened: OTHER, holding: { [OTHER]: [NOTE] } }, NOTE).why, "Already in this note");
  assert.equal(addToNote({ ...context, opened: OTHER }, NOTE).enabled, true);

  const { actor, of } = await start({ notes: [FIRST] });
  actor.send({ type: "_addToNote", id: NOTE });
  assert.equal(of("passage.added").length, 0, "no note open");
  actor.send({ type: "note.opened", id: OTHER });
  actor.send({ type: "_addToNote", id: NOTE });
  assert.deepEqual(of("passage.added").map(({ note, highlight }) => [note, highlight]), [[OTHER, NOTE]]);
  valid(of("passage.added")[0]);
});

test("copying announces the text or the link, and fills this editor's own Vim register", async () => {
  const pushed = [];
  const { actor, of } = await start({ notes: [FIRST], pushed });
  actor.send({ type: "_copyText", text: "A passage" });
  actor.send({ type: "_copyText", text: "  " });
  assert.deepEqual(of("text.copied").map((e) => e.text), ["A passage"]);
  actor.send({ type: "_copyLink", id: NOTE });
  valid(of("link.copied")[0]);
  assert.equal(of("link.copied")[0].text, sourceLink(NOTE, { exact: "First" }));
  assert.deepEqual(pushed, ["A passage", `[First](note:${NOTE})`]);
});

test("the comment box saves the title and the body once, and only what changed", async () => {
  const { actor, of } = await start({ notes: [FIRST], read: { [NOTE]: { ...FIRST, body: "Old", version: 4 } } });
  actor.send({ type: "_commentOpen", id: NOTE });
  await new Promise((done) => setTimeout(done));
  assert.equal(actor.getSnapshot().context.comment.body, "Old");
  actor.send({ type: "_commentSave", body: "Old" });
  assert.equal(of("note.saved").length, 0, "left as it was");
  actor.send({ type: "_commentSave", body: "\nNew words\nand more" });
  const [saved] = of("note.saved");
  valid(saved);
  assert.equal(saved.title, "New words");
  assert.equal(saved.body, "\nNew words\nand more");
  assert.equal(saved.baseVersion, 4);
  assert.equal(saved.left, true);
  assert.equal(saved.about, undefined, "its links stay");
  actor.send({ type: "note.changed", ...FIRST, title: "New words", body: "", version: 5 });
  assert.equal(actor.getSnapshot().context.comment.version, 5, "the next save is based on the new version");
  assert.equal(actor.getSnapshot().context.highlights[0].commented, true);
  actor.send({ type: "_commentClose" });
  assert.equal(actor.getSnapshot().context.comment, null);
  assert.equal(titleOf("  \n\n"), "", "an emptied comment takes the accent line away");
});

test("following a link to a journal highlight shows its day and glows it; another book's does nothing", async () => {
  const { actor } = await start();
  actor.send({ type: "day.selected", id: OPEN });
  actor.send({ type: "passage.selected", book: "01K7TEST00000000000000BK01", id: NOTE, place: place({ block: 0, offset: 0 }, { block: 0, offset: 1 }) });
  assert.equal(actor.getSnapshot().context.glow, null);
  actor.send({ type: "passage.selected", book: JOURNAL, id: NOTE, place: place({ block: 1, offset: 0 }, { block: 1, offset: 5 }) });
  const { context } = actor.getSnapshot();
  assert.equal(context.glow.id, NOTE);
  assert.equal(context.chapter, 1);
  assert.equal(context.picture.days[context.chapter].id, OLD);
  actor.send({ type: "book.opened", id: JOURNAL });
  await new Promise((done) => setTimeout(done));
  assert.equal(actor.getSnapshot().context.chapter, 1, "the journal opening for it keeps the pick");
});

test("a link on one journal day to a highlight on another shows that day, since the bus never returns an emit", async () => {
  const { actor, of } = await start({ read: { [NOTE]: { ...FIRST, body: "", version: 1 } } });
  actor.send({ type: "_show", chapter: 0 });
  actor.send({ type: "_follow", id: NOTE });
  await new Promise((done) => setTimeout(done));
  assert.equal(of("passage.selected").length, 1);
  assert.equal(actor.getSnapshot().context.chapter, 1);
  assert.equal(actor.getSnapshot().context.glow.id, NOTE);
});
