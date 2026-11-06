import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, homeOf, footerOf, noteTypeOf, strands, prewritten, SLIPBOX, LITERATURE_START } from "../machine.js";

// Note types (13), decided by the machine: the label and its menu, when Permanent may be
// chosen, which places keep a permanent note in the Slip-Box, and a new note's type.
const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = new Validator(JSON.parse(readFileSync(resolve(HERE, "..", "events", "note.saved.json"), "utf8")), "2020-12");

const ME = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const TOP = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const SUB = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const LOOSE = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const KID = "01ARZ3NDEKTSV4RRFFQ69G5FA6";
const NEW = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const THROTTLE_MS = 200;

const under = (id) => ({ kind: "note", id });

const JOURNAL = "00000000000000000000000JRN";

// TOP under the Slip-Box, SUB, permanent, under TOP, LOOSE under no one; KID, permanent, under ME.
const LIST = [
  { id: TOP, title: "Top", subtitle: "", updatedAt: 5, about: [under(SLIPBOX)] },
  { id: SUB, title: "Sub", subtitle: "", updatedAt: 6, about: [under(TOP)], noteType: "permanent" },
  { id: LOOSE, title: "Loose", subtitle: "", updatedAt: 7, about: [] },
  { id: KID, title: "Kid", subtitle: "", updatedAt: 8, about: [under(ME)], noteType: "permanent" },
];
const mine = (about, noteType) => ({ id: ME, title: "Me", body: "Me", version: 3, pending: false, updatedAt: 4, about, ...(noteType ? { noteType } : {}) });

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

function editor({ hidden = [], note = null, subject = null, subjecting = false, keepOpen = false } = {}) {
  const saved = [];
  const opened = [];
  const asked = [];
  const ask = (target, name) => {
    asked.push(target);
    if (target === "flags") return Promise.resolve({ hidden });
    if (target === "subject") return Promise.resolve({ subject });
    if (target === "settings") return Promise.resolve({ keepOpen });
    if (target === "notes" && name === "list") return Promise.resolve({ notes: [...LIST, ...(note ? [{ ...note, subtitle: "" }] : [])] });
    if (target === "notes" && name === "read") return Promise.resolve(note ? { note } : { error: "not-found" });
    if (target === "notes" && name === "find") return Promise.resolve({ notes: [], total: 0, more: 0 });
    return Promise.resolve({});
  };
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    input: { ask, mint: () => NEW, focus: () => {}, subjecting, recallTitles: () => ({}), rememberTitles: () => {} },
    clock,
  });
  actor.on("note.saved", (e) => saved.push(e));
  actor.on("note.opened", (e) => opened.push(e.id));
  actor.start();
  return { actor, saved, clock, opened, asked, arrives: (later) => { note = later; } };
}

async function opened(note, options = {}) {
  const e = editor({ ...options, note });
  await settle();
  e.actor.send({ type: "load", id: note.id });
  await settle();
  return e;
}

const valid = (event) => {
  const { type, ...rest } = event;
  return SAVED.validate(rest).valid;
};

test("hidden Slip-Box: no type label and no type on a save, the type kept as it is", async () => {
  const { actor, saved, clock } = await opened(mine([under(TOP)], "literature"), { hidden: ["slip-box"] });
  assert.equal(homeOf(actor.getSnapshot()), null);
  actor.send({ type: "_retype", noteType: "fleeting" });
  actor.send({ type: "_typed", body: "Me\nmore" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  assert.equal("noteType" in saved[0], false);
});

test("the label names the note's type, fleeting when it has none, and the menu lists the three with a line each", async () => {
  const { actor } = await opened(mine([]));
  const type = homeOf(actor.getSnapshot()).type;
  assert.equal(type.value, "fleeting");
  assert.deepEqual(type.options.map((t) => t.label), ["Fleeting", "Literature", "Permanent"]);
  assert.ok(type.options.every((t) => t.says.length > 0));
});

test("Permanent outside the Slip-Box asks for a place first: alone it saves nothing, in the Slip-Box it is set at once", async () => {
  const outside = await opened(mine([under(LOOSE)]));
  const options = noteTypeOf(outside.actor.getSnapshot().context).options;
  assert.deepEqual(options.map((t) => t.enabled), [true, true, true]);
  assert.equal(options[2].needsPlace, true);
  outside.actor.send({ type: "_retype", noteType: "permanent" });
  assert.deepEqual(outside.saved, []);
  assert.equal(homeOf(outside.actor.getSnapshot()).type.value, "fleeting");

  const inside = await opened(mine([under(SUB)]));
  assert.equal(noteTypeOf(inside.actor.getSnapshot().context).options[2].needsPlace, undefined);
  inside.actor.send({ type: "_retype", noteType: "permanent" });
  assert.equal(inside.saved.at(-1).noteType, "permanent");
});

test("a place picked for Permanent is one save carrying both the place and the type", async () => {
  const book = { kind: "book", id: BOOK };
  const { actor, saved } = await opened(mine([book], "literature"));
  actor.send({ type: "_place", id: SUB });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].about, [book, under(SUB)], "the book's link stays");
  assert.equal(saved[0].noteType, "permanent");
  assert.ok(valid(saved[0]));
  assert.equal(homeOf(actor.getSnapshot()).type.value, "permanent");
});

test("Add to Slip-Box shows only on a Permanent note, and the type shows on a note with no links", async () => {
  const fleeting = await opened(mine([]));
  const home = homeOf(fleeting.actor.getSnapshot());
  assert.equal(home.add, null);
  assert.equal(home.type.value, "fleeting");
  const permanent = await opened(mine([under(TOP)], "permanent"));
  assert.deepEqual(homeOf(permanent.actor.getSnapshot()).add, { enabled: true });
});

test("leaving Permanent keeps the note's links, and a Permanent note picking Permanent saves nothing", async () => {
  const { actor, saved } = await opened({ ...mine([under(SUB)], "permanent"), id: LOOSE });
  actor.send({ type: "_retype", noteType: "permanent" });
  assert.deepEqual(saved, []);
  actor.send({ type: "_retype", noteType: "literature" });
  assert.equal(saved.length, 1);
  assert.equal("about" in saved[0], false, "a save without links keeps them");
  assert.deepEqual(homeOf(actor.getSnapshot()).places.map((p) => p.id), [SUB]);
});

test("a Permanent note with notes under it keeps its type, the others greyed with the reason, until they are gone", async () => {
  const { actor, saved } = await opened(mine([under(TOP)], "permanent"));
  const options = () => noteTypeOf(actor.getSnapshot().context).options;
  assert.deepEqual(options().map((t) => t.enabled), [false, false, true]);
  assert.deepEqual(options().map((t) => t.why), ["Move or delete the notes under it first", "Move or delete the notes under it first", undefined]);
  actor.send({ type: "_retype", noteType: "fleeting" });
  assert.deepEqual(saved, []);
  actor.send({ type: "note.deleted", id: KID });
  assert.deepEqual(options().map((t) => t.enabled), [true, true, true]);
});

test("a note that is not Permanent may change type even while it holds notes", async () => {
  const { actor } = await opened(mine([under(TOP)], "literature"));
  assert.deepEqual(noteTypeOf(actor.getSnapshot().context).options.map((t) => t.enabled), [true, true, true]);
});

test("Notes under this shows on a Permanent note and on any note that holds notes, never on an empty other one", async () => {
  const empty = await opened({ ...mine([]), id: LOOSE });
  assert.equal(footerOf(empty.actor.getSnapshot().context).under, null);
  const permanent = await opened({ ...mine([under(TOP)], "permanent"), id: SUB });
  assert.deepEqual(footerOf(permanent.actor.getSnapshot().context).under, []);
  const holding = await opened(mine([], "literature"));
  assert.deepEqual(footerOf(holding.actor.getSnapshot().context).under.map((n) => n.id), [KID]);
});

test("a type picked is one save with the draft and the new type, shown at once; the same type saves nothing", async () => {
  const { actor, saved } = await opened(mine([under(TOP)]));
  actor.send({ type: "_retype", noteType: "fleeting" });
  assert.deepEqual(saved, []);
  actor.send({ type: "_retype", noteType: "permanent" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].noteType, "permanent");
  assert.equal(saved[0].body, "Me");
  assert.equal(saved[0].baseVersion, 3);
  assert.equal("about" in saved[0], false, "the links stay as they are");
  assert.ok(valid(saved[0]));
  assert.equal(homeOf(actor.getSnapshot()).type.value, "permanent");
});

test("a permanent note's last place in the Slip-Box keeps it there; a second place may go", async () => {
  const one = await opened(mine([under(TOP)], "permanent"));
  assert.equal(homeOf(one.actor.getSnapshot()).places[0].stays, true);
  one.actor.send({ type: "_unplace", id: TOP });
  assert.deepEqual(one.saved, []);

  const two = await opened(mine([under(TOP), under(SLIPBOX), under(LOOSE)], "permanent"));
  const places = homeOf(two.actor.getSnapshot()).places;
  assert.deepEqual(places.map((p) => Boolean(p.stays)), [false, false, false]);
  two.actor.send({ type: "_unplace", id: TOP });
  assert.equal(two.saved.length, 1);
});

test("a note whose last place would take a permanent note under it out of the Slip-Box keeps that place", async () => {
  const { actor, saved } = await opened(mine([under(TOP)]));
  assert.equal(strands(actor.getSnapshot().context, TOP), true, "KID, permanent, is under ME");
  actor.send({ type: "_unplace", id: TOP });
  assert.deepEqual(saved, []);
});

async function typedNew(subject, options = {}) {
  const e = editor({ subjecting: true, subject, ...options });
  await settle();
  e.actor.send({ type: "_typed", body: "fresh" });
  e.clock.increment(THROTTLE_MS);
  return e.saved;
}

const asNote = (id) => ({ kind: "note", id, title: "A note", view: "book-stage" });
const asBook = (id) => ({ kind: "book", id, title: "A book", view: "book-stage" });

test("a new note's type follows the link it gets: permanent under a Permanent note or the Slip-Box, literature beside a book, fleeting in the Journal or with no link", async () => {
  const inBox = await typedNew(asNote(SUB));
  assert.equal(inBox[0].noteType, "permanent");
  assert.deepEqual(inBox[0].about, [under(SUB)]);
  assert.ok(valid(inBox[0]));
  assert.equal((await typedNew(asNote(SLIPBOX)))[0].noteType, "permanent");
  const beside = await typedNew(asBook(BOOK));
  assert.equal(beside[0].noteType, "literature");
  assert.deepEqual(beside[0].about, [{ kind: "book", id: BOOK }]);
  const day = await typedNew({ ...asBook(JOURNAL), chapter: "2026-11-06", chapterTitle: "Today" });
  assert.equal(day[0].noteType, "fleeting");
  assert.equal(day[0].about[0].id, JOURNAL);
  const none = await typedNew(null);
  assert.equal(none[0].noteType, "fleeting");
  assert.deepEqual(none[0].about, []);
});

test("a new note written while another note is the subject goes under nothing, since only a Permanent note can have notes under it", async () => {
  // TOP is in the Slip-Box but not Permanent, LOOSE is outside it.
  for (const id of [TOP, LOOSE]) {
    const saved = await typedNew(asNote(id));
    assert.equal(saved[0].noteType, "fleeting");
    assert.deepEqual(saved[0].about, []);
  }
});

test("with Slip-Box hidden a new note written under a note is linked as before, with no type", async () => {
  const saved = await typedNew(asNote(LOOSE), { hidden: ["slip-box"] });
  assert.deepEqual(saved[0].about, [under(LOOSE)]);
  assert.equal("noteType" in saved[0], false);
});

test("with the open note kept, a new note's type still follows the link it is saved with", async () => {
  const e = editor({ subjecting: true, subject: asBook(BOOK), keepOpen: true });
  await settle();
  e.actor.send({ type: "_typed", body: "fresh" });
  // The stage moves before the first save; the kept note takes the subject it then has.
  e.actor.send({ type: "subject.changed", subject: asBook(JOURNAL) });
  e.clock.increment(THROTTLE_MS);
  assert.equal(e.saved[0].about[0].id, JOURNAL);
  assert.equal(e.saved[0].noteType, "fleeting");

  const none = editor({ subjecting: true, subject: asBook(BOOK), keepOpen: true });
  await settle();
  none.actor.send({ type: "_typed", body: "fresh" });
  none.actor.send({ type: "subject.changed", subject: null });
  none.clock.increment(THROTTLE_MS);
  assert.deepEqual(none.saved[0].about, []);
  assert.equal(none.saved[0].noteType, "fleeting");
});

// The pre-written title of a new literature note (13, Note type).
const besideBook = async (options = {}) => {
  const e = editor({ subjecting: true, subject: asBook(BOOK), ...options });
  await settle();
  return e;
};
const bodyOf = (e) => e.actor.getSnapshot().context.body;
const leaves = (e) => {
  e.actor.send({ type: "_focused" });
  e.actor.send({ type: "_finished", lines: [] });
  e.actor.send({ type: "_blurred" });
};

test("beside a book the empty page holds the title, and leaving it untouched saves nothing and makes no note", async () => {
  const e = await besideBook();
  assert.equal(e.actor.getSnapshot().value, "empty");
  assert.equal(bodyOf(e), LITERATURE_START);
  assert.equal(prewritten(e.actor.getSnapshot()), true);
  leaves(e);
  e.clock.increment(THROTTLE_MS * 2);
  e.actor.send({ type: "subject.changed", subject: asBook(JOURNAL) });
  await settle();
  assert.deepEqual(e.saved, []);
  assert.equal(e.actor.getSnapshot().context.id, null);
});

test("the first typing saves the whole text as literature, with one save until the keyboard leaves", async () => {
  const e = await besideBook();
  e.actor.send({ type: "_typed", body: `${LITERATURE_START}A line` });
  assert.equal(e.actor.getSnapshot().context.id, NEW);
  e.clock.increment(THROTTLE_MS);
  assert.equal(e.saved.length, 1);
  assert.equal(e.saved[0].body, "# Literature Note\n\nA line");
  assert.equal(e.saved[0].title, "Literature Note");
  assert.equal(e.saved[0].noteType, "literature");
  assert.deepEqual(e.saved[0].about, [{ kind: "book", id: BOOK }]);
  assert.ok(valid(e.saved[0]));
  e.actor.send({ type: "_blurred" });
  assert.equal(e.saved.length, 2);
  assert.equal(e.saved[1].left, true);
  assert.equal(e.saved[1].body, "# Literature Note\n\nA line");
});

test("changing only the title is typing and saves", async () => {
  const e = await besideBook();
  e.actor.send({ type: "_typed", body: "# Chapter thoughts\n\n" });
  e.clock.increment(THROTTLE_MS);
  assert.equal(e.saved[0].body, "# Chapter thoughts\n\n");
  assert.equal(e.saved[0].title, "Chapter thoughts");
});

test("typing back to the title before the first save saves nothing", async () => {
  const e = await besideBook();
  e.actor.send({ type: "_typed", body: `${LITERATURE_START}x` });
  e.actor.send({ type: "_typed", body: LITERATURE_START });
  e.clock.increment(THROTTLE_MS);
  e.actor.send({ type: "_blurred" });
  assert.deepEqual(e.saved, []);
});

test("only a new literature note starts with the title: not in the Journal, with no link, under a note, or with Slip-Box hidden", async () => {
  const day = { ...asBook(JOURNAL), chapter: "2026-11-06", chapterTitle: "Today" };
  for (const options of [{ subject: day }, { subject: null }, { subject: asNote(SUB) }, { subject: asNote(SLIPBOX) }, { hidden: ["slip-box"] }]) {
    const e = await besideBook(options);
    assert.equal(bodyOf(e), "", JSON.stringify(options));
    assert.equal(prewritten(e.actor.getSnapshot()), false);
  }
  const off = await besideBook({ hidden: ["slip-box"] });
  off.actor.send({ type: "flags.changed", hidden: [], released: [], shown: [] });
  assert.equal(bodyOf(off), LITERATURE_START, "the title comes with the feature");
  off.actor.send({ type: "flags.changed", hidden: ["slip-box"], released: [], shown: [] });
  assert.equal(bodyOf(off), "", "and goes with it");
});

test("a new note picked beside a book holds the title, and picking another saves nothing", async () => {
  const e = await besideBook();
  e.actor.send({ type: "load", id: NEW });
  await settle();
  assert.equal(e.actor.getSnapshot().value, "blank");
  assert.equal(bodyOf(e), LITERATURE_START);
  e.actor.send({ type: "load", id: "01ARZ3NDEKTSV4RRFFQ69G5FAA" });
  await settle();
  e.actor.send({ type: "_blurred" });
  assert.deepEqual(e.saved, []);
  e.actor.send({ type: "_typed", body: `${LITERATURE_START}Mine` });
  e.clock.increment(THROTTLE_MS);
  assert.equal(e.saved[0].id, "01ARZ3NDEKTSV4RRFFQ69G5FAA");
  assert.equal(e.saved[0].body, `${LITERATURE_START}Mine`);
  assert.equal(e.saved[0].noteType, "literature");
});

test("a chapter with no note shows the title again, and with the keyboard on the page the page stays", async () => {
  const chapter = (n) => ({ ...asBook(BOOK), chapter: `c${n}`, chapterTitle: `Chapter ${n}` });
  const e = await besideBook({ subject: chapter(1) });
  e.actor.send({ type: "subject.changed", subject: chapter(2) });
  assert.equal(bodyOf(e), "", "nothing is shown while the notes are read");
  await settle();
  assert.equal(bodyOf(e), LITERATURE_START);
  e.actor.send({ type: "_focused" });
  e.actor.send({ type: "subject.changed", subject: chapter(3) });
  await settle();
  assert.equal(bodyOf(e), LITERATURE_START);
  e.actor.send({ type: "_typed", body: `${LITERATURE_START}Mine` });
  e.clock.increment(THROTTLE_MS);
  assert.deepEqual(e.saved[0].about, [{ kind: "book", id: BOOK, chapter: "c3", chapterTitle: "Chapter 3" }]);
});

test("a note about the subject arriving later replaces the untouched title", async () => {
  const note = { id: ME, title: "Me", body: "Me", version: 3, pending: false, updatedAt: 4, about: [{ kind: "book", id: BOOK }] };
  const e = await besideBook();
  e.arrives(note);
  e.actor.send({ type: "note.changed", ...note });
  await settle();
  assert.equal(bodyOf(e), "Me");
  assert.deepEqual(e.saved, []);
});

test("deleting the new note, as Undo does, brings the title back as an empty page", async () => {
  const e = await besideBook();
  e.actor.send({ type: "_typed", body: `${LITERATURE_START}Gone` });
  e.clock.increment(THROTTLE_MS);
  e.actor.send({ type: "note.changed", id: NEW, title: "Literature Note", body: `${LITERATURE_START}Gone`, version: 1, pending: false, updatedAt: 9, about: [{ kind: "book", id: BOOK }] });
  e.actor.send({ type: "_blurred" });
  const count = e.saved.length;
  e.actor.send({ type: "note.deleted", id: NEW });
  await settle();
  assert.equal(bodyOf(e), LITERATURE_START);
  assert.equal(e.actor.getSnapshot().context.id, null);
  e.actor.send({ type: "_blurred" });
  assert.equal(e.saved.length, count);
});

test("line-checks is not asked about the untouched title", async () => {
  const e = await besideBook();
  e.actor.send({ type: "load", id: NEW });
  await settle();
  assert.equal(e.asked.includes("line-checks"), false);
});

test("changing an existing note to Literature adds no title", async () => {
  const e = await opened(mine([]));
  e.actor.send({ type: "_retype", noteType: "literature" });
  assert.equal(e.saved[0].noteType, "literature");
  assert.equal(e.saved[0].body, "Me");
});
