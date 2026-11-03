import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, homeOf, footerOf, slipBoxTargets, inSlipBox, SLIPBOX } from "../machine.js";

// The home line and the footer (while Slip-Box shows): what they name, what "Add to
// Slip-Box…" offers, and the saves their buttons make, decided by the machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const schemaOf = (name) => new Validator(JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8")), "2020-12");
const SAVED = schemaOf("note.saved");
const SELECTED = schemaOf("passage.selected");

const ME = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const TOP = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const SUB = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const LOOSE = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const HL = "01ARZ3NDEKTSV4RRFFQ69G5FA4";
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FA5";
const KID = "01ARZ3NDEKTSV4RRFFQ69G5FA6";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const JOURNAL = "00000000000000000000000JRN";

const place = { chapter: 2, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 9 } };
const under = (id) => ({ kind: "note", id });

// A box: TOP under the Slip-Box, SUB under TOP, KID under ME, LOOSE under no one, and a
// highlight in BOOK.
const LIST = [
  { id: TOP, title: "Top", subtitle: "the top", updatedAt: 5, about: [under(SLIPBOX)] },
  { id: SUB, title: "Sub", subtitle: "", updatedAt: 6, about: [under(TOP)] },
  { id: LOOSE, title: "Loose", subtitle: "", updatedAt: 7, about: [] },
  { id: KID, title: "Kid", subtitle: "", updatedAt: 8, about: [under(ME)] },
  {
    id: HL,
    title: "",
    subtitle: "",
    updatedAt: 2,
    about: [{ kind: "book", id: BOOK, chapter: "two", chapterTitle: "Two", place, quote: { exact: "one two three four five six seven eight", prefix: "", suffix: "" } }],
  },
];
const MINE = {
  id: ME,
  title: "Me",
  body: "Me",
  version: 3,
  pending: false,
  updatedAt: 4,
  about: [{ kind: "book", id: BOOK, chapter: "two", chapterTitle: "Two" }, under(TOP), { kind: "highlight", id: HL }],
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

function editor({ hidden = [], staged = false, linked = [], note = MINE, titles = { [`book:${BOOK}`]: "A Book" } } = {}) {
  const saved = [];
  const selected = [];
  const finds = [];
  const ask = (target, name, payload) => {
    if (target === "flags") return Promise.resolve({ hidden });
    if (target === "notes" && name === "list") return Promise.resolve({ notes: [...LIST, { ...note, subtitle: "" }] });
    if (target === "notes" && name === "read") return Promise.resolve({ note });
    if (target === "notes" && name === "find") {
      finds.push(payload);
      return Promise.resolve({ notes: linked.map((id) => ({ id, title: "", line: "", updatedAt: 1, about: [] })), total: linked.length, more: 0 });
    }
    return Promise.resolve({});
  };
  const actor = createActor(machine, {
    input: { ask, mint: () => ME, focus: () => {}, staged, recallTitles: () => titles, rememberTitles: () => {} },
    clock: new SimulatedClock(),
  });
  actor.on("note.saved", (e) => saved.push(e));
  actor.on("passage.selected", (e) => selected.push(e));
  actor.start();
  return { actor, saved, selected, finds };
}

// An editor past its start, with notes' list in hand, showing `note`.
async function opened(options = {}) {
  const e = editor(options);
  await settle();
  e.actor.send({ type: "load", id: (options.note ?? MINE).id });
  await settle();
  return e;
}

test("hidden Slip-Box: no home line and no footer, as before the feature", async () => {
  const { actor, finds } = await opened({ hidden: ["slip-box"] });
  assert.equal(homeOf(actor.getSnapshot()), null);
  assert.equal(footerOf(actor.getSnapshot().context), null);
  assert.deepEqual(finds, []);
});

test("the home line names the book and chapter, then each place, and offers Add to Slip-Box", async () => {
  const { actor } = await opened();
  const home = homeOf(actor.getSnapshot());
  assert.deepEqual(home.books.map((b) => b.text), ["A Book · Two"]);
  assert.deepEqual(home.places, [{ id: TOP, label: "Slip-Box › Top", removable: true }]);
  assert.deepEqual(home.add, { enabled: true });
});

test("a place outside the Slip-Box is named by its title, the Slip-Box by its name, the Journal before any subject named it", async () => {
  const note = { ...MINE, about: [{ kind: "book", id: JOURNAL, chapter: "2026-11-03", chapterTitle: "Tuesday" }, under(SLIPBOX), under(LOOSE)] };
  const { actor } = await opened({ note, titles: {} });
  const home = homeOf(actor.getSnapshot());
  assert.deepEqual(home.books.map((b) => b.text), ["Journal · Tuesday"]);
  assert.deepEqual(home.places.map((p) => p.label), ["Slip-Box", "Loose"]);
});

test("Add to Slip-Box offers the Slip-Box and the notes in it, never the note itself, a place it has, or a note under it", async () => {
  const { actor } = await opened();
  const { context } = actor.getSnapshot();
  // TOP is a place already; LOOSE is not in the box; KID is under ME, so a loop; HL is a highlight.
  assert.deepEqual(slipBoxTargets(context).map((t) => t.id), [SLIPBOX, SUB]);
  assert.equal(slipBoxTargets(context)[1].title, "Slip-Box › Sub");
  assert.equal(inSlipBox(context.entries, SUB), true);
  assert.equal(inSlipBox(context.entries, LOOSE), false);
});

test("a place picked, a place taken out and a passage taken out are each one save with the new links", async () => {
  const { actor, saved } = await opened();
  actor.send({ type: "_place", id: SUB });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].about.filter((l) => l.kind === "note").map((l) => l.id), [TOP, SUB]);
  assert.equal(saved[0].body, "Me");
  actor.send({ type: "_unplace", id: TOP });
  assert.deepEqual(saved[1].about.filter((l) => l.kind === "note").map((l) => l.id), [SUB]);
  actor.send({ type: "_unpassage", id: HL });
  assert.deepEqual(saved[2].about.map((l) => l.kind), ["book", "note"]);
  for (const { type, ...rest } of saved) assert.ok(SAVED.validate(rest).valid, JSON.stringify(SAVED.validate(rest).errors?.[0]));
  // What is not on offer saves nothing: the note itself, a note under it, one not in the box.
  for (const id of [ME, KID, LOOSE, SUB]) actor.send({ type: "_place", id });
  actor.send({ type: "_unplace", id: LOOSE });
  assert.equal(saved.length, 3);
});

test("the Slip-Box itself has no home line and takes no place, but has its footer", async () => {
  const { actor, saved } = await opened({ note: { ...MINE, id: SLIPBOX, about: [] }, staged: true });
  assert.equal(homeOf(actor.getSnapshot()), null);
  assert.deepEqual(footerOf(actor.getSnapshot().context).passages, []);
  actor.send({ type: "_place", id: TOP });
  assert.deepEqual(saved, []);
});

test("a note not written yet has no footer", async () => {
  const { actor } = await opened();
  assert.equal(footerOf({ ...actor.getSnapshot().context, baseVersion: null }), null);
});

test("the footer holds the note's passages, the notes under it in the panel only, and the notes that link to it", async () => {
  const { actor, finds } = await opened({ linked: [SUB, ME] });
  assert.deepEqual(finds.at(-1), { contains: `(note:${ME})`, limit: 50 });
  const footer = footerOf(actor.getSnapshot().context);
  assert.deepEqual(footer.passages, [{ id: HL, words: "“one two three four five six seven…”", chapter: "Two", gone: false }]);
  assert.deepEqual(footer.under, [{ id: KID, title: "Kid" }]);
  assert.deepEqual(footer.linked, [{ id: SUB, title: "Sub" }]);

  const stage = await opened({ staged: true });
  assert.equal(footerOf(stage.actor.getSnapshot().context).under, null);
});

test("Linked from follows the notes' news: a link written adds the note, a link taken out or a delete removes it", async () => {
  const { actor } = await opened();
  const linked = () => footerOf(actor.getSnapshot().context).linked.map((n) => n.id);
  assert.deepEqual(linked(), []);
  actor.send({ type: "note.changed", id: LOOSE, title: "Loose", body: `Loose\nsee [Me](note:${ME})`, version: 2, pending: false, updatedAt: 9, about: [] });
  assert.deepEqual(linked(), [LOOSE]);
  actor.send({ type: "note.changed", id: LOOSE, title: "Loose", body: "Loose", version: 3, pending: false, updatedAt: 10, about: [] });
  assert.deepEqual(linked(), []);
  actor.send({ type: "note.changed", id: SUB, title: "Sub", body: `[x](note:${ME})`, version: 2, pending: false, updatedAt: 11, about: [under(TOP)] });
  actor.send({ type: "note.deleted", id: SUB });
  assert.deepEqual(linked(), []);
});

test("a passage's click opens it in its book; a removed one shows grey and opens nothing", async () => {
  const { actor, selected } = await opened();
  actor.send({ type: "_passage", id: HL });
  assert.deepEqual(selected, [{ type: "passage.selected", book: BOOK, id: HL, place }]);
  assert.ok(SELECTED.validate({ book: BOOK, id: HL, place }).valid);
  actor.send({ type: "note.deleted", id: HL });
  assert.equal(footerOf(actor.getSnapshot().context).passages[0].gone, true);
  actor.send({ type: "_passage", id: HL });
  assert.equal(selected.length, 1);
});

test("the stage's editor learns a book's title from subject.changed, for its home line", async () => {
  const { actor } = await opened({ staged: true, titles: {} });
  assert.deepEqual(homeOf(actor.getSnapshot()).books.map((b) => b.text), ["Two"]);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: BOOK, title: "Later Title", view: "book-stage" } });
  assert.deepEqual(homeOf(actor.getSnapshot()).books.map((b) => b.text), ["Later Title · Two"]);
});
