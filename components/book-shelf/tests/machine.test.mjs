import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, showing, shown } from "../machine.js";

// The shelf's actor is where the rename decision lives (D11): the view turns Enter or
// blur into a _rename gesture carrying the field's text, and the machine announces it
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
  const actor = createActor(machine, { input: { ask, undoMs: 3000 } });
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
  actor.send({ type: "_rename", id: ID, title: "  New  " });
  assert.deepEqual(renamed, [{ type: "book.renamed", id: ID, title: "New" }]);
});

test("_rename ignores unchanged text and an unknown book (no announcement)", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "Old"));
  actor.send({ type: "_rename", id: ID, title: "Old" }); // unchanged
  actor.send({ type: "_rename", id: ID, title: "  Old  " }); // unchanged after trim
  actor.send({ type: "_rename", id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", title: "X" }); // unknown
  assert.deepEqual(renamed, []);
});

test("_rename to an empty string is a real change: it restores the file's title", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "User Title"));
  actor.send({ type: "_rename", id: ID, title: "   " });
  assert.deepEqual(renamed, [{ type: "book.renamed", id: ID, title: "" }]);
});

// The "Vim keys" preference (12): asked of settings at start, followed after.
const VIM_INPUT = { undoMs: 3000 };
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

test("the journal sits first and cannot be renamed or discarded", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "Imported"));
  actor.send({ ...changed(JRN, "Journal"), addedAt: 0, written: true });
  assert.deepEqual(actor.getSnapshot().context.books.map((b) => b.id), [JRN, ID]);
  actor.send({ type: "_rename", id: JRN, title: "Diary" });
  actor.send({ type: "_discard", id: JRN });
  assert.deepEqual(renamed, []);
  assert.equal(actor.getSnapshot().context.discarding.size, 0);
});

// --- Signed out (14) -------------------------------------------------------------------

const SIGNED_IN = { userId: "u1", registrationOpen: false, guest: false, name: "Ann" };
const SIGNED_OUT = { userId: null, registrationOpen: true, guest: false, name: null };

// The shelf with the journal and one book; session as given, or missing.
const shelf = async (session, tryPage = false) => {
  const books = [{ ...changed(JRN, "Journal"), chapterCount: 1, addedAt: 0, written: true }, { ...changed(ID, "Dune"), chapterCount: 1 }];
  const ask = (target, name) =>
    Promise.resolve(target === "session" ? (session ?? { error: "no-answerer" }) : name === "list" ? { books } : name === "open" ? { id: ID } : {});
  const actor = createActor(machine, { input: { ask, undoMs: 3000, tryPage } });
  const discarded = [];
  actor.on("book.discarded", (e) => discarded.push(e));
  actor.start();
  await flush();
  await flush();
  return { actor, discarded, ctx: () => actor.getSnapshot().context };
};

test("signed out the shelf asks to sign in; signed in, or with no session to ask, it shows", async () => {
  assert.equal(showing({ tryPage: false, signedIn: null }), "wait", "nothing until session answers");
  assert.equal(showing((await shelf(SIGNED_OUT)).ctx()), "sign-in");
  assert.equal(showing((await shelf(SIGNED_IN)).ctx()), "show");
  assert.equal(showing((await shelf()).ctx()), "show", "a page without session counts as signed in");
  assert.equal(showing((await shelf(SIGNED_OUT, true)).ctx()), "show", "a try page shows its visitor the shelf");
});

test("signing out hides the tiles without dropping them, and takes back a delete still in its undo window", async () => {
  const { actor, ctx, discarded } = await shelf(SIGNED_IN);
  actor.send({ type: "_discard", id: ID });
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(ctx()), "sign-in");
  assert.deepEqual(ctx().books.map((b) => b.id), [JRN, ID], "the tiles are kept");
  assert.equal(ctx().selected, ID, "the open book stays highlighted");
  assert.equal(ctx().discarding.size, 0, "the delete is taken back");
  actor.send({ type: "_elapsed", id: ID });
  assert.deepEqual(discarded, []);
  actor.send({ type: "session.changed", ...SIGNED_IN });
  await flush();
  await flush();
  assert.equal(showing(ctx()), "show");
  assert.deepEqual(ctx().books.map((b) => b.id), [JRN, ID]);
});

// --- The corner notice (12, Vim keys: a delete never happens out of sight) --------------

test("leaving the shelf hands a counting-down tile to the corner notice, hidden until it ends", async () => {
  const { actor, ctx, discarded } = await shelf(SIGNED_IN);
  const started = [];
  actor.on("removal.started", (e) => started.push({ kind: e.kind, id: e.id, name: e.name }));
  actor.send({ type: "_left" });
  assert.deepEqual(started, [], "nothing counting down, nothing handed");
  actor.send({ type: "_discard", id: ID });
  actor.send({ type: "_left" });
  assert.deepEqual(started, [{ kind: "book", id: ID, name: "Dune" }]);
  assert.equal(ctx().discarding.size, 0);
  assert.deepEqual(shown(ctx()).map((b) => b.id), [JRN], "the tile is off the shelf");
  actor.send({ type: "_elapsed", id: ID });
  assert.deepEqual(discarded, [], "the notice settles it now, not the tile's timer");
  actor.send({ type: "_discard", id: ID });
  assert.equal(ctx().discarding.size, 0, "a handed tile cannot be deleted again");
  actor.send({ type: "removal.undone", kind: "note", id: ID });
  assert.equal(shown(ctx()).length, 1, "another kind's undo is not ours");
  actor.send({ type: "removal.undone", kind: "book", id: ID });
  assert.deepEqual(shown(ctx()).map((b) => b.id), [JRN, ID], "Undo in the notice brings it back");
});

test("opening a book while another counts down hands that delete to the corner notice", async () => {
  const { actor, ctx } = await shelf(SIGNED_IN);
  const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
  actor.send({ ...changed(OTHER, "Emma"), addedAt: 0 });
  const started = [];
  const selected = [];
  actor.on("removal.started", (e) => started.push(e.id));
  actor.on("book.selected", (e) => selected.push(e.id));
  actor.send({ type: "_discard", id: ID });
  actor.send({ type: "_select", id: OTHER });
  assert.deepEqual(started, [ID]);
  assert.deepEqual(selected, [OTHER]);
  assert.ok(ctx().handed.has(ID));
  actor.send({ type: "book.deleted", id: ID });
  assert.equal(ctx().handed.size, 0, "the fact's deletion ends the wait");
});
