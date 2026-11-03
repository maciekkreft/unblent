import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, showing, tilesOf } from "../machine.js";

// The shelf's actor is where the rename decision lives (D11): the view turns Enter or
// blur into a _rename gesture carrying the fields' texts, and the machine announces it
// as book.renamed only when it is a real change. Enter/blur/Escape themselves are the
// view's DOM concern, driven in the browser test; here we drive the actor directly
// with a fake ask, the shape fact.js builds for real.
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const flush = () => new Promise((r) => setTimeout(r, 0));

const ask = (target, name) =>
  name === "list"
    ? Promise.resolve({ books: [] })
    : name === "read"
      ? Promise.resolve({ userId: "u1", registrationOpen: false })
      : Promise.resolve({ id: null });

function start() {
  const actor = createActor(machine, { input: { ask } });
  const renamed = [];
  actor.on("book.renamed", (e) => renamed.push(e));
  actor.start();
  return { actor, renamed };
}

// A book.changed, as books emits it, carrying the whole book (4.3, third rule).
const changed = (id, title) => ({
  type: "book.changed",
  id,
  title,
  author: "A",
  cover: null,
  position: { chapter: 0, block: 0 },
  chapters: [{ title: "x" }],
  toc: [],
  version: 1,
  contentVersion: 1,
  pending: false,
  addedAt: 1,
  updatedAt: 1,
});

test("_rename announces book.renamed with the trimmed text when the title changed", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "Old"));
  actor.send({ type: "_rename", id: ID, title: "  New  ", author: "A" });
  assert.deepEqual(renamed, [{ type: "book.renamed", id: ID, title: "New", author: "A" }]);
});

test("_rename announces book.renamed with the trimmed author when only the author changed", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "Old"));
  actor.send({ type: "_rename", id: ID, title: "Old", author: "  New Author  " });
  assert.deepEqual(renamed, [{ type: "book.renamed", id: ID, title: "Old", author: "New Author" }]);
});

test("_rename ignores unchanged text and an unknown book (no announcement)", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "Old"));
  actor.send({ type: "_rename", id: ID, title: "Old", author: "A" }); // unchanged
  actor.send({ type: "_rename", id: ID, title: "  Old  ", author: " A " }); // unchanged after trim
  actor.send({ type: "_rename", id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", title: "X", author: "A" }); // unknown
  assert.deepEqual(renamed, []);
});

test("_rename to an empty string is a real change: it restores the file's title", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "User Title"));
  actor.send({ type: "_rename", id: ID, title: "   ", author: "A" });
  assert.deepEqual(renamed, [{ type: "book.renamed", id: ID, title: "", author: "A" }]);
});

// The "Vim keys" preference (12): asked of settings at start, followed after.
const VIM_INPUT = {};
const vimAsk = (reply) => (target, name) =>
  Promise.resolve(target === "settings" && name === "read" ? reply : {});
const vimActor = (reply) => createActor(machine, { input: { ...VIM_INPUT, ask: vimAsk(reply) } }).start();
const vimSettle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

test("Vim keys start from settings: read, and are off until it answers", async () => {
  const actor = vimActor({ vimKeys: true, profile: "workshop" });
  assert.equal(actor.getSnapshot().context.vimKeys, false, "off before the reply");
  await vimSettle();
  assert.equal(actor.getSnapshot().context.vimKeys, true);
});

test("Vim keys follow settings.changed, in any state, and never move the view", async () => {
  const actor = vimActor({ vimKeys: false });
  await vimSettle();
  const before = actor.getSnapshot().value;
  actor.send({ type: "settings.changed", vimKeys: true });
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
  assert.deepEqual(actor.getSnapshot().value, before);
});

test("an error reply, or a reply without the field, leaves Vim keys off", async () => {
  for (const reply of [{ error: "no-answerer" }, { profile: "product" }]) {
    const actor = vimActor(reply);
    await vimSettle();
    assert.equal(actor.getSnapshot().context.vimKeys, false, JSON.stringify(reply));
  }
});

// The journal (written: true) is owned by `journal`: the shelf puts it first and never
// renames or discards it.
const JRN = "00000000000000000000000JRN";

test("the journal sits first and cannot be renamed or deleted", async () => {
  const { actor, renamed } = start();
  const discarded = [];
  actor.on("book.discarded", (e) => discarded.push(e));
  await flush();
  actor.send(changed(ID, "Imported"));
  actor.send({ ...changed(JRN, "Journal"), addedAt: 0, written: true });
  assert.deepEqual(actor.getSnapshot().context.books.map((b) => b.id), [JRN, ID]);
  actor.send({ type: "_rename", id: JRN, title: "Diary", author: "Me" });
  actor.send({ type: "_discard", id: JRN });
  actor.send({ type: "_dd", id: JRN });
  assert.deepEqual(renamed, []);
  assert.deepEqual(discarded, []);
  assert.equal(actor.getSnapshot().context.deleted, null);
});

// --- Signed out (14) -------------------------------------------------------------------

const SIGNED_IN = { userId: "u1", registrationOpen: false, guest: false, name: "Ann" };
const SIGNED_OUT = { userId: null, registrationOpen: true, guest: false, name: null };

// The shelf with the journal and one book; session as given, or missing.
const shelf = async (session, tryPage = false) => {
  const books = [{ ...changed(JRN, "Journal"), chapterCount: 1, addedAt: 0, written: true }, { ...changed(ID, "Dune"), chapterCount: 1 }];
  const ask = (target, name) =>
    Promise.resolve(target === "session" ? (session ?? { error: "no-answerer" }) : name === "list" ? { books } : name === "open" ? { id: ID } : {});
  const actor = createActor(machine, { input: { ask, tryPage } });
  const discarded = [];
  const restored = [];
  actor.on("book.discarded", (e) => discarded.push(e));
  actor.on("book.restored", (e) => restored.push(e));
  actor.start();
  await flush();
  await flush();
  return { actor, discarded, restored, ctx: () => actor.getSnapshot().context };
};

test("signed out the shelf asks to sign in; signed in, or with no session to ask, it shows", async () => {
  assert.equal(showing({ tryPage: false, signedIn: null }), "wait", "nothing until session answers");
  assert.equal(showing((await shelf(SIGNED_OUT)).ctx()), "sign-in");
  assert.equal(showing((await shelf(SIGNED_IN)).ctx()), "show");
  assert.equal(showing((await shelf()).ctx()), "show", "a page without session counts as signed in");
  assert.equal(showing((await shelf(SIGNED_OUT, true)).ctx()), "show", "a try page shows its visitor the shelf");
});

test("signing out hides the tiles without dropping them, and forgets the book dd deleted", async () => {
  const { actor, ctx, restored } = await shelf(SIGNED_IN);
  actor.send({ type: "_dd", id: ID });
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(ctx()), "sign-in");
  assert.deepEqual(ctx().books.map((b) => b.id), [JRN, ID], "the tiles are kept");
  assert.equal(ctx().selected, ID, "the open book stays highlighted");
  assert.equal(ctx().deleted, null, "p can no longer bring it back");
  actor.send({ type: "session.changed", ...SIGNED_IN });
  await flush();
  await flush();
  actor.send({ type: "_paste" });
  assert.deepEqual(restored, []);
  assert.equal(showing(ctx()), "show");
});

// --- Deleting and cutting (12, Undo; Vim keys) -----------------------------------------

test("the trash deletes a book at once", async () => {
  const { actor, discarded } = await shelf(SIGNED_IN);
  actor.send({ type: "_discard", id: ID });
  assert.deepEqual(discarded, [{ type: "book.discarded", id: ID }]);
});

test("dd deletes a tile at once and remembers it; p brings it back once", async () => {
  const { actor, ctx, discarded, restored } = await shelf(SIGNED_IN);
  actor.send({ type: "_paste" });
  assert.deepEqual(restored, [], "p with nothing deleted does nothing");
  actor.send({ type: "_dd", id: ID });
  assert.deepEqual(discarded, [{ type: "book.discarded", id: ID }]);
  assert.equal(ctx().deleted, ID);
  actor.send({ type: "book.deleted", id: ID });
  actor.send({ type: "_paste" });
  assert.deepEqual(restored, [{ type: "book.restored", id: ID }]);
  assert.equal(ctx().deleted, null);
  actor.send({ type: "_paste" });
  assert.equal(restored.length, 1, "a second p does nothing");
});

test("a second dd replaces the remembered book; the book coming back another way forgets it", async () => {
  const { actor, ctx, discarded, restored } = await shelf(SIGNED_IN);
  const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
  actor.send({ ...changed(OTHER, "Emma"), addedAt: 0 });
  actor.send({ type: "_dd", id: ID });
  actor.send({ type: "_dd", id: OTHER });
  assert.deepEqual(discarded.map((e) => e.id), [ID, OTHER]);
  assert.equal(ctx().deleted, OTHER);
  actor.send({ type: "book.deleted", id: ID });
  actor.send({ type: "book.deleted", id: OTHER });
  actor.send({ ...changed(OTHER, "Emma"), addedAt: 0 });
  assert.equal(ctx().deleted, null, "an Undo brought it back");
  actor.send({ type: "_paste" });
  assert.deepEqual(restored, []);
});

// The Slip-Box tile (13): shown only while `flags` says the feature is not hidden (3.1).
const SLIPBOX = "00000000000000000000000SBX";
const JOURNAL = "00000000000000000000000JRN";

function startWith(flags) {
  const answer = (target, name) => {
    if (target === "flags") return Promise.resolve(flags);
    if (target === "session") return Promise.resolve({ userId: "u1", registrationOpen: false });
    if (name === "list") return Promise.resolve({ books: [{ ...changed(ID, "Dune"), chapterCount: 1, written: false }, { ...changed(JOURNAL, "Journal"), written: true }] });
    return Promise.resolve({ id: null });
  };
  const actor = createActor(machine, { input: { ask: answer } });
  const out = [];
  for (const type of ["note.staged", "book.selected", "book.discarded", "book.renamed"]) actor.on(type, (e) => out.push(e));
  actor.start();
  return { actor, out };
}

const ids = (actor) => tilesOf(actor.getSnapshot().context).map((t) => t.id);

test("the Slip-Box tile comes right after the journal while the feature is shown", async () => {
  const { actor } = startWith({ off: [], hidden: [], released: ["slip-box"], shown: ["slip-box"] });
  await flush();
  assert.deepEqual(ids(actor), [JOURNAL, SLIPBOX, ID]);
});

test("no Slip-Box tile while the feature is hidden, before flags answers, or on a page without flags", async () => {
  const hidden = startWith({ off: ["slip-box"], hidden: ["slip-box"], released: [], shown: ["slip-box"] });
  const none = startWith({ error: "no-answerer" });
  assert.deepEqual(tilesOf(hidden.actor.getSnapshot().context), [], "nothing before the replies");
  await flush();
  assert.deepEqual(ids(hidden.actor), [JOURNAL, ID]);
  assert.deepEqual(ids(none.actor), [JOURNAL, ID]);
  hidden.actor.send({ type: "flags.changed", off: [], hidden: [], released: ["slip-box"], shown: ["slip-box"] });
  assert.deepEqual(ids(hidden.actor), [JOURNAL, SLIPBOX, ID], "flags.changed shows it");
});

test("opening the Slip-Box stages the note; it cannot be renamed or deleted", async () => {
  const { actor, out } = startWith({ off: [], hidden: [], released: ["slip-box"], shown: ["slip-box"] });
  await flush();
  actor.send({ type: "_select", id: SLIPBOX });
  actor.send({ type: "_rename", id: SLIPBOX, title: "Box", author: "" });
  actor.send({ type: "_discard", id: SLIPBOX });
  actor.send({ type: "_dd", id: SLIPBOX });
  assert.deepEqual(out, [{ type: "note.staged", id: SLIPBOX }]);
  assert.equal(actor.getSnapshot().context.deleted, null);
});

test("while the feature is hidden opening the Slip-Box's id does nothing", async () => {
  const { actor, out } = startWith({ off: ["slip-box"], hidden: ["slip-box"], released: [], shown: [] });
  await flush();
  actor.send({ type: "_select", id: SLIPBOX });
  assert.deepEqual(out, []);
});
