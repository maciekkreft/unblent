import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine } from "../machine.js";

// The undo window, driven by a SimulatedClock so the countdown is tested without
// waiting real time (the view reads the value from --duration-undo).
const UNDO_MS = 100;

// The actor is driven with a fake ask and mint, the shapes view.js builds for real.
const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const C = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const MINTED = "01ARZ3NDEKTSV4RRFFQ69G5FD2";
const MINTED2 = "01ARZ3NDEKTSV4RRFFQ69G5FE3";

const tick = () => new Promise((r) => setTimeout(r, 0));

// A mint that hands out distinct ids in order, so a re-mint (the next-note row after
// the last one became real) is told from the id before it.
const minter = () => {
  const ids = [MINTED, MINTED2];
  let i = 0;
  return () => ids[i++] ?? `01ARZ3NDEKTSV4RRFFQ69G5F${i}`;
};

function list({ ask, mint = minter(), undoMs = UNDO_MS } = {}) {
  const selected = [];
  const discarded = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { ask, mint, undoMs }, clock });
  actor.on("note.selected", (e) => selected.push(e.id));
  actor.on("note.discarded", (e) => discarded.push(e.id));
  actor.start();
  return { actor, selected, discarded, clock };
}

const answeringList = (notes) => (target, name) =>
  Promise.resolve(name === "list" ? { notes } : {});

const ids = (actor) => actor.getSnapshot().context.notes.map((n) => n.id);

test("the starting picture is notes: list, sorted newest first", async () => {
  const asked = [];
  const { actor } = list({
    ask: (...args) => {
      asked.push(args);
      return Promise.resolve({ notes: [{ id: A, title: "A", updatedAt: 10 }, { id: B, title: "B", updatedAt: 20 }] });
    },
  });
  await tick();
  assert.equal(actor.getSnapshot().value, "ready");
  assert.deepEqual(ids(actor), [B, A]);
  assert.deepEqual(asked, [["notes", "list", {}]]);
});

test("note.changed upserts a row and re-sorts", async () => {
  const { actor } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "note.changed", id: B, title: "B", subtitle: "second", body: "b", version: 1, pending: false, updatedAt: 30 });
  assert.deepEqual(ids(actor), [B, A], "the newer note leads");
  // The row keeps the subtitle the event carried (the list does not derive it).
  assert.equal(actor.getSnapshot().context.notes.find((n) => n.id === B).subtitle, "second");
  // The same id again replaces its row rather than doubling it.
  actor.send({ type: "note.changed", id: A, title: "A2", subtitle: "", body: "a", version: 2, pending: false, updatedAt: 40 });
  assert.deepEqual(ids(actor), [A, B]);
  assert.equal(actor.getSnapshot().context.notes.find((n) => n.id === A).title, "A2");
});

test("note.opened sets the open row", async () => {
  const { actor } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "note.opened", id: A });
  assert.equal(actor.getSnapshot().context.open, A);
});

test("_pick emits note.selected for an existing note, and not for a stale id", async () => {
  const { actor, selected } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_pick", id: A });
  actor.send({ type: "_pick", id: C });
  assert.deepEqual(selected, [A]);
});

test("the next-note draft is minted on start and can be picked while it has no row", async () => {
  const { actor, selected } = list({ ask: answeringList([]) });
  await tick();
  assert.equal(actor.getSnapshot().context.draft, MINTED);
  actor.send({ type: "_pick", id: MINTED });
  assert.deepEqual(selected, [MINTED]);
});

test("note.changed for the draft turns it into a row and mints the next", async () => {
  const { actor } = list({ ask: answeringList([]) });
  await tick();
  const first = actor.getSnapshot().context.draft;
  actor.send({ type: "note.changed", id: first, title: "Made", body: "m", version: 1, pending: false, updatedAt: 50 });
  // The draft became a real note, and a fresh next-note id took its place.
  assert.deepEqual(ids(actor), [first]);
  const next = actor.getSnapshot().context.draft;
  assert.notEqual(next, first);
  assert.equal(next, MINTED2);
});

test("opening another note keeps the next-note draft", async () => {
  const { actor } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  const draft = actor.getSnapshot().context.draft;
  actor.send({ type: "note.opened", id: A });
  assert.equal(actor.getSnapshot().context.draft, draft);
  assert.equal(actor.getSnapshot().context.open, A);
});

test("note.deleted removes a row", async () => {
  const { actor } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }, { id: B, title: "B", updatedAt: 20 }]) });
  await tick();
  actor.send({ type: "note.deleted", id: A });
  assert.deepEqual(ids(actor), [B]);
});

test("a list notes cannot answer yields an empty list without throwing", async () => {
  const { actor } = list({ ask: () => Promise.resolve({ error: "no-answerer" }) });
  await tick();
  assert.equal(actor.getSnapshot().value, "failed");
  assert.deepEqual(ids(actor), []);
});

// --- Discard countdown (delayed delete, 5) ---------------------------------------

const discardingHas = (actor, id) => actor.getSnapshot().context.discarding.has(id);

test("a discard starts a countdown and emits note.discarded only when it elapses", async () => {
  const { actor, discarded, clock } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_discard", id: A });
  assert.equal(discardingHas(actor, A), true, "the row is counting down");
  assert.deepEqual(discarded, [], "nothing is a fact yet");

  clock.increment(UNDO_MS - 1);
  assert.deepEqual(discarded, [], "still nothing a tick before the window ends");
  clock.increment(1);
  assert.deepEqual(discarded, [A], "the window ran out: the delete is a fact");
  assert.equal(discardingHas(actor, A), false, "and the countdown is over");
  clock.increment(UNDO_MS * 5);
  assert.deepEqual(discarded, [A], "it fires once, never again");
});

test("undo before the window ends cancels the delete and emits nothing", async () => {
  const { actor, discarded, clock } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_discard", id: A });
  clock.increment(UNDO_MS - 1);
  actor.send({ type: "_undo", id: A });
  assert.equal(discardingHas(actor, A), false, "the row is back");
  clock.increment(UNDO_MS * 2);
  assert.deepEqual(discarded, [], "the cancelled timer never fires");
});

test("two rows count down independently", async () => {
  const { actor, discarded, clock } = list({
    ask: answeringList([{ id: A, title: "A", updatedAt: 10 }, { id: B, title: "B", updatedAt: 20 }]),
  });
  await tick();
  actor.send({ type: "_discard", id: A });
  clock.increment(40);
  actor.send({ type: "_discard", id: B });
  clock.increment(60); // A's window (100) ends, B's (started at 40) has 40 left
  assert.deepEqual(discarded, [A]);
  clock.increment(40); // B's window ends
  assert.deepEqual(discarded, [A, B]);
});

test("_pick on a counting-down row emits nothing: a click there is the undo", async () => {
  const { actor, selected } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "_pick", id: A });
  assert.deepEqual(selected, [], "a discarding row is not picked");
});

test("note.deleted clears the open row and any standing countdown", async () => {
  const { actor, discarded, clock } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "note.opened", id: A });
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "note.deleted", id: A }); // e.g. the same note deleted on another device
  assert.deepEqual(ids(actor), [], "the row is gone");
  assert.equal(actor.getSnapshot().context.open, null, "and no longer the open row");
  assert.equal(discardingHas(actor, A), false, "the countdown is cleared");
  clock.increment(UNDO_MS * 2);
  assert.deepEqual(discarded, [], "the cancelled timer never fires");
});

test("a note.changed for a discarding row keeps it counting down", async () => {
  const { actor, discarded, clock } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "note.changed", id: A, title: "A edited", body: "x", version: 2, pending: true, updatedAt: 50 });
  assert.equal(discardingHas(actor, A), true, "still counting down");
  clock.increment(UNDO_MS);
  assert.deepEqual(discarded, [A], "and it still elapses to a discard");
});

test("a discard of an unknown id does nothing", async () => {
  const { actor, discarded, clock } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_discard", id: C });
  assert.equal(discardingHas(actor, C), false);
  clock.increment(UNDO_MS * 2);
  assert.deepEqual(discarded, []);
});
