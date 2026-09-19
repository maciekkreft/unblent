import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, ordered, compose, split, titleOf } from "../machine.js";

// highlight-notes composes the highlights of the book on the stage into one document
// (Decision 2). The pure functions that shape that document — ordered, compose, split,
// titleOf — are tested first; then the actor's decisions: building the set from the
// subject's highlights, following note.changed / note.deleted / subject.changed, saving
// each comment at a throttle, and removing with the same undo window as note-list.

const THROTTLE_MS = 200;
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOOK2 = "01ARZ3NDEKTSV4RRFFQ69G5FB9";
const H1 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const H2 = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const QUOTE = { exact: "hello", prefix: "", suffix: "" };

const placeAt = (chapter, block, offset) => ({
  chapter,
  contentVersion: 1,
  start: { block, offset },
  end: { block, offset: offset + 5 },
});

// A whole note as a read reply or a note.changed carries it (body, version, links).
const noteObj = (id, { body = "", version = 1, bookId = BOOK, place = placeAt(0, 0, 0), quote = QUOTE, about } = {}) => ({
  id,
  title: titleOf(body),
  body,
  version,
  pending: false,
  updatedAt: 1,
  about: about ?? [{ kind: "book", id: bookId, place, quote }],
});

// The list row of a note: about (so the place is there), no body, no version.
const rowOf = (note) => ({ id: note.id, title: note.title, subtitle: "", updatedAt: note.updatedAt, about: note.about });

// A target-aware ask: subject: read and notes: read share the name "read", so the reply
// depends on the target. `notes` maps id → whole note; a missing id is not-found.
const asking =
  ({ subject = null, notes = {} } = {}) =>
  (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject });
    if (target === "notes" && name === "list") return Promise.resolve({ notes: Object.values(notes).map(rowOf) });
    if (target === "notes" && name === "read") {
      const note = notes[payload.id];
      return Promise.resolve(note ? { note } : { error: "not-found" });
    }
    return Promise.resolve({});
  };

function view({ ask = asking(), undoMs = 3000 } = {}) {
  const clock = new SimulatedClock();
  const saved = [];
  const discarded = [];
  const actor = createActor(machine, { input: { ask, undoMs }, clock });
  actor.on("note.saved", (e) => saved.push(e));
  actor.on("note.discarded", (e) => discarded.push(e));
  actor.start();
  return { actor, clock, saved, discarded };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
// The build chains the subject read, the notes list and the reads, so drain a few
// microtask turns to settle it.
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};
const frags = (actor) => actor.getSnapshot().context.fragments;
const ids = (actor) => frags(actor).map((f) => f.id);

// --- Pure functions ---------------------------------------------------------------

test("ordered sorts by chapter, then start block, then start offset", () => {
  const a = { id: "a", place: placeAt(1, 0, 0) };
  const b = { id: "b", place: placeAt(0, 5, 0) };
  const c = { id: "c", place: placeAt(0, 5, 3) };
  const d = { id: "d", place: placeAt(0, 2, 0) };
  assert.deepEqual(ordered([a, b, c, d]).map((f) => f.id), ["d", "b", "c", "a"]);
});

test("compose then split round-trips the bodies", () => {
  const fragments = [
    { id: H1, quote: { exact: "quote one" }, body: "line a\nline b" },
    { id: H2, quote: { exact: "multi\nline   quote" }, body: "" },
  ];
  const { doc, quotes } = compose(fragments);
  const lines = doc.split("\n");
  // A quote line per fragment, its white space (line breaks included) shown as one space.
  assert.equal(lines[quotes[0].line], "quote one");
  assert.equal(lines[quotes[1].line], "multi line quote");
  // Every fragment keeps at least one comment line (the empty one under H2), so a quote
  // line is never directly followed by the next quote line or the end.
  assert.equal(quotes[1].line - quotes[0].line, 3);
  const bodies = split(doc, quotes);
  assert.equal(bodies[H1], "line a\nline b");
  assert.equal(bodies[H2], "");
});

test("titleOf is the first non-empty line, trimmed", () => {
  assert.equal(titleOf(""), "");
  assert.equal(titleOf("\n\n  hi there \nx"), "hi there");
  assert.equal(titleOf("first\nsecond"), "first");
});

// --- The actor --------------------------------------------------------------------

test("builds one fragment per highlight of the subject, ignoring plain notes", async () => {
  const notes = {
    [H1]: noteObj(H1, { body: "a comment", version: 4 }),
    // A note about the book but with no place is not a highlight.
    plain: noteObj("01ARZ3NDEKTSV4RRFFQ69G5FC0", { body: "just a note", about: [{ kind: "book", id: BOOK }] }),
  };
  const { actor } = view({ ask: asking({ subject: { kind: "book", id: BOOK, title: "B" }, notes }) });
  await settle();
  assert.deepEqual(ids(actor), [H1]);
  const f = frags(actor)[0];
  assert.equal(f.body, "a comment");
  assert.equal(f.version, 4);
  assert.deepEqual(f.place, placeAt(0, 0, 0));
});

test("a subject arriving after the read still builds its highlights (no reload race)", async () => {
  const notes = { [H1]: noteObj(H1, { body: "c" }) };
  // The subject read resolves null; the book arrives on its own via subject.changed.
  const { actor } = view({ ask: asking({ subject: null, notes }) });
  await settle();
  assert.deepEqual(frags(actor), []);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: BOOK, title: "B" } });
  await settle();
  assert.deepEqual(ids(actor), [H1]);
});

test("a subject change rebuilds the set for the new book", async () => {
  const notes = {
    [H1]: noteObj(H1, { body: "one" }),
    [H2]: noteObj(H2, { body: "two", bookId: BOOK2 }),
  };
  const { actor } = view({ ask: asking({ subject: { kind: "book", id: BOOK, title: "B" }, notes }) });
  await settle();
  assert.deepEqual(ids(actor), [H1]);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: BOOK2, title: "B2" } });
  await settle();
  assert.deepEqual(ids(actor), [H2]);
});

test("note.changed adds a new highlight, adopts a newer body, and drops one that lost its place", async () => {
  const notes = { [H1]: noteObj(H1, { body: "", version: 1 }) };
  const { actor } = view({ ask: asking({ subject: { kind: "book", id: BOOK, title: "B" }, notes }) });
  await settle();
  // A new highlight of this book appears.
  actor.send({ type: "note.changed", ...noteObj(H2, { body: "new", version: 2 }) });
  assert.deepEqual(new Set(ids(actor)), new Set([H1, H2]));
  // A newer body from elsewhere is adopted.
  actor.send({ type: "note.changed", ...noteObj(H1, { body: "edited elsewhere", version: 3 }) });
  const f1 = frags(actor).find((f) => f.id === H1);
  assert.equal(f1.body, "edited elsewhere");
  assert.equal(f1.version, 3);
  // H2 loses its place (its link keeps the book but drops the place): it drops out.
  actor.send({ type: "note.changed", ...noteObj(H2, { body: "new", version: 4, about: [{ kind: "book", id: BOOK }] }) });
  assert.deepEqual(ids(actor), [H1]);
});

test("note.deleted drops the fragment", async () => {
  const notes = { [H1]: noteObj(H1, { body: "c" }) };
  const { actor } = view({ ask: asking({ subject: { kind: "book", id: BOOK, title: "B" }, notes }) });
  await settle();
  actor.send({ type: "note.deleted", id: H1 });
  assert.deepEqual(frags(actor), []);
});

test("typing then a pause saves each changed comment once; the echo only bumps the version", async () => {
  const notes = { [H1]: noteObj(H1, { body: "", version: 1 }) };
  const { actor, clock, saved } = view({ ask: asking({ subject: { kind: "book", id: BOOK, title: "B" }, notes }) });
  await settle();
  actor.send({ type: "_typed", bodies: { [H1]: "My thought" } });
  assert.equal(saved.length, 0); // still inside the throttle window
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], { type: "note.saved", id: H1, title: "My thought", body: "My thought", baseVersion: 1 });
  // notes echoes the save back at a new version: only the version moves, the body stays.
  actor.send({ type: "note.changed", ...noteObj(H1, { body: "My thought", version: 2 }) });
  const f = frags(actor).find((x) => x.id === H1);
  assert.equal(f.body, "My thought");
  assert.equal(f.version, 2);
  // A second pause on the same text saves nothing more.
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
});

test("blur saves at once", async () => {
  const notes = { [H1]: noteObj(H1, { body: "", version: 1 }) };
  const { actor, saved } = view({ ask: asking({ subject: { kind: "book", id: BOOK, title: "B" }, notes }) });
  await settle();
  actor.send({ type: "_typed", bodies: { [H1]: "x" } });
  actor.send({ type: "_blurred" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].body, "x");
});

test("discard can be undone, or elapses into note.discarded", async () => {
  const notes = { [H1]: noteObj(H1, { body: "c" }) };
  const { actor, clock, discarded } = view({ ask: asking({ subject: { kind: "book", id: BOOK, title: "B" }, notes }), undoMs: 3000 });
  await settle();
  actor.send({ type: "_discard", id: H1 });
  assert.ok(actor.getSnapshot().context.discarding.has(H1));
  actor.send({ type: "_undo", id: H1 });
  assert.ok(!actor.getSnapshot().context.discarding.has(H1));
  clock.increment(3000);
  assert.equal(discarded.length, 0); // undone before the window ran out
  // Discard again and let it elapse.
  actor.send({ type: "_discard", id: H1 });
  clock.increment(3000);
  assert.deepEqual(discarded, [{ type: "note.discarded", id: H1 }]);
});
