import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is driven with a fake ask and mint, the shapes view.js builds for real.
const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const C = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const MINTED = "01ARZ3NDEKTSV4RRFFQ69G5FD2";

const tick = () => new Promise((r) => setTimeout(r, 0));

function list({ ask, mint = () => MINTED } = {}) {
  const selected = [];
  const actor = createActor(machine, { input: { ask, mint } });
  actor.on("note.selected", (e) => selected.push(e.id));
  actor.start();
  return { actor, selected };
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
  actor.send({ type: "note.changed", id: B, title: "B", body: "b", version: 1, pending: false, updatedAt: 30 });
  assert.deepEqual(ids(actor), [B, A], "the newer note leads");
  // The same id again replaces its row rather than doubling it.
  actor.send({ type: "note.changed", id: A, title: "A2", body: "a", version: 2, pending: false, updatedAt: 40 });
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

test("_new mints an id, holds it as the draft, and selects it; note.changed for it clears the draft", async () => {
  const { actor, selected } = list({ ask: answeringList([]) });
  await tick();
  actor.send({ type: "_new" });
  assert.equal(actor.getSnapshot().context.draft, MINTED);
  assert.deepEqual(selected, [MINTED]);
  // The draft can be picked while it has no row.
  actor.send({ type: "_pick", id: MINTED });
  assert.deepEqual(selected, [MINTED, MINTED]);
  // The real row arrives: the placeholder is dropped.
  actor.send({ type: "note.changed", id: MINTED, title: "Made", body: "m", version: 1, pending: false, updatedAt: 50 });
  assert.equal(actor.getSnapshot().context.draft, null);
  assert.deepEqual(ids(actor), [MINTED]);
});

test("opening a different note clears a pending draft", async () => {
  const { actor } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_new" });
  assert.equal(actor.getSnapshot().context.draft, MINTED);
  actor.send({ type: "note.opened", id: A });
  assert.equal(actor.getSnapshot().context.draft, null);
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
