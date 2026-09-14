import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, titleOf } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake ask, mint and
// focus, the shapes view.js builds for real. A SimulatedClock drives the debounce
// without waiting real time. By default notes answers list with nothing, so the
// editor starts empty; a test about reopening answers otherwise.
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const DEBOUNCE_MS = 800;
const NOTE = { id: ID, title: "L", body: "L\nloaded", version: 7, pending: false, updatedAt: 9 };

const answering = (replies) => (target, name) => Promise.resolve(replies[name] ?? {});

function editor({ ask = answering({ list: { notes: [] } }), focus = () => {}, follows = false, mint = () => ID } = {}) {
  const clock = new SimulatedClock();
  const saved = [];
  const opened = [];
  const actor = createActor(machine, { input: { ask, mint, focus, follows }, clock });
  actor.on("note.saved", (e) => saved.push(e));
  actor.on("note.opened", (e) => opened.push(e.id));
  actor.start();
  return { actor, clock, saved, opened };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// An editor past its start, in `empty`.
async function started(options) {
  const e = editor(options);
  await tick();
  assert.equal(e.actor.getSnapshot().value, "empty");
  return e;
}

test("the title is the first line that says anything", () => {
  assert.equal(titleOf("Hello\nworld"), "Hello");
  assert.equal(titleOf("\n\n  Second try  \nmore"), "Second try");
  assert.equal(titleOf("   \n \n"), "");
  assert.equal(titleOf(""), "");
});

test("typing in an empty editor mints an id and becomes dirty, emitting nothing yet", async () => {
  const { actor, saved } = await started();
  actor.send({ type: "_typed", body: "Hi\nyo" });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "dirty" });
  assert.equal(s.context.id, ID);
  assert.deepEqual(saved, []);
});

test("after the pause it emits one note.saved, titled by its first line, with a null base; typing restarts the timer", async () => {
  const { actor, clock, saved } = await started();
  actor.send({ type: "_typed", body: "a" });
  clock.increment(DEBOUNCE_MS - 1);
  actor.send({ type: "_typed", body: "ab\nmore" }); // restarts the pause
  clock.increment(DEBOUNCE_MS - 1);
  assert.deepEqual(saved, [], "the earlier timer was cancelled");
  clock.increment(1);
  assert.deepEqual(saved, [{ type: "note.saved", id: ID, title: "ab", body: "ab\nmore", baseVersion: null }]);
  assert.deepEqual(actor.getSnapshot().value, { editing: "clean" });
});

test("a blur while dirty saves at once", async () => {
  const { actor, saved } = await started();
  actor.send({ type: "_typed", body: "quick" });
  actor.send({ type: "_blurred" });
  assert.equal(saved.length, 1);
  assert.deepEqual(actor.getSnapshot().value, { editing: "clean" });
});

test("the echo of our own save bumps baseVersion and leaves a dirty draft untouched", async () => {
  const { actor, clock } = await started();
  actor.send({ type: "_typed", body: "T\nB" });
  clock.increment(DEBOUNCE_MS); // save: sent = T\nB, clean
  actor.send({ type: "_typed", body: "T2\nB" }); // dirty again
  actor.send({ type: "note.changed", id: ID, title: "T", body: "T\nB", version: 1, pending: false, updatedAt: 1 });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "dirty" }, "still dirty");
  assert.equal(s.context.body, "T2\nB", "the keystroke made since is not lost");
  assert.equal(s.context.baseVersion, 1);
});

test("a newer change is adopted; an older one and another id are ignored", async () => {
  const { actor } = await started();
  actor.send({ type: "_typed", body: "mine" }); // dirty, base null
  actor.send({ type: "note.changed", id: ID, title: "theirs", body: "theirs\nnewer", version: 5, pending: false, updatedAt: 2 });
  let s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.body, "theirs\nnewer");
  assert.equal(s.context.baseVersion, 5);

  actor.send({ type: "note.changed", id: ID, title: "stale", body: "old", version: 3, pending: false, updatedAt: 3 });
  assert.equal(actor.getSnapshot().context.body, "theirs\nnewer", "an older version is ignored");

  const other = { type: "note.changed", id: ID2, title: "x", body: "x", version: 9, pending: false, updatedAt: 4 };
  assert.equal(actor.getSnapshot().can(other), false, "a change for another id is not handled");
});

test("on start it reopens the newest note notes lists", async () => {
  const asked = [];
  const { actor } = editor({
    ask: (target, name, payload) => {
      asked.push([target, name, payload]);
      if (name === "list") return Promise.resolve({ notes: [{ id: ID2, title: "N", updatedAt: 20 }, { id: ID, title: "O", updatedAt: 10 }] });
      return Promise.resolve({ note: { ...NOTE, id: ID2 } });
    },
  });
  assert.equal(actor.getSnapshot().value, "starting");
  await tick();
  await tick();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID2, "the first listed, the newest");
  assert.equal(s.context.body, NOTE.body);
  assert.equal(s.context.baseVersion, 7);
  assert.deepEqual(asked, [["notes", "list", {}], ["notes", "read", { id: ID2 }]]);
});

test("on start with no notes, or no answer, it is empty", async () => {
  const none = editor({ ask: answering({ list: { notes: [] } }) });
  await tick();
  assert.equal(none.actor.getSnapshot().value, "empty");
  const unanswered = editor({ ask: answering({ list: { error: "no-answerer" } }) });
  await tick();
  assert.equal(unanswered.actor.getSnapshot().value, "empty");
});

test("a keystroke before the start reply is the user's answer: it mints and the reply is dropped", async () => {
  let resolveList;
  const { actor } = editor({
    ask: (target, name) =>
      name === "list" ? new Promise((r) => (resolveList = r)) : Promise.resolve({ note: NOTE }),
  });
  actor.send({ type: "_typed", body: "first" });
  assert.deepEqual(actor.getSnapshot().value, { editing: "dirty" });
  assert.equal(actor.getSnapshot().context.id, ID);
  resolveList({ notes: [{ id: ID2, title: "N", updatedAt: 20 }] });
  await tick();
  await tick();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "dirty" });
  assert.equal(s.context.body, "first");
});

test("load asks notes: read and lands per the reply", async () => {
  const asked = [];
  const withReply = async (reply) => {
    const { actor } = await started({
      ask: (...args) => (asked.push(args), Promise.resolve(args[1] === "list" ? { notes: [] } : reply)),
    });
    actor.send({ type: "load", id: ID });
    return actor;
  };

  const found = await withReply({ note: NOTE });
  await tick();
  let s = found.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.body, NOTE.body);
  assert.equal(s.context.baseVersion, 7);
  assert.deepEqual(asked[1], ["notes", "read", { id: ID }]);

  const blank = await withReply({ error: "not-found" });
  await tick();
  assert.equal(blank.getSnapshot().value, "blank");

  const failed = await withReply({ error: "no-answerer" });
  await tick();
  assert.equal(failed.getSnapshot().value, "failed");
});

test("focus calls the focus callback", async () => {
  let focused = 0;
  const { actor } = await started({ focus: () => focused++ });
  actor.send({ type: "focus" });
  assert.equal(focused, 1);
});

test("a save after a load carries the loaded version as its base", async () => {
  const { actor, clock, saved } = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  actor.send({ type: "load", id: ID });
  await tick();
  actor.send({ type: "_typed", body: "L edited\nloaded" });
  clock.increment(DEBOUNCE_MS);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].baseVersion, 7);
  assert.equal(saved[0].title, "L edited");
});

test("a pause that ends on the text notes already holds saves nothing", async () => {
  const { actor, clock, saved } = await started();
  actor.send({ type: "_typed", body: "T\nB" });
  clock.increment(DEBOUNCE_MS); // first save
  assert.equal(saved.length, 1);
  actor.send({ type: "_typed", body: "Tx\nB" });
  actor.send({ type: "_typed", body: "T\nB" }); // undone within the pause
  clock.increment(DEBOUNCE_MS);
  assert.equal(saved.length, 1, "the pause emitted nothing");
  assert.deepEqual(actor.getSnapshot().value, { editing: "clean" });
  actor.send({ type: "_typed", body: "Tx\nB" });
  actor.send({ type: "_typed", body: "T\nB" });
  actor.send({ type: "_blurred" });
  assert.equal(saved.length, 1, "nor the blur");

  // The same after a load: the loaded text is what notes holds.
  const loaded = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  loaded.actor.send({ type: "load", id: ID });
  await tick();
  loaded.actor.send({ type: "_typed", body: "L!\nloaded" });
  loaded.actor.send({ type: "_typed", body: NOTE.body });
  loaded.clock.increment(DEBOUNCE_MS);
  assert.deepEqual(loaded.saved, []);
});

test("note.selected loads the note when the editor follows, and is ignored when it does not", async () => {
  const following = await started({ follows: true, ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  following.actor.send({ type: "note.selected", id: ID });
  await tick();
  assert.deepEqual(following.actor.getSnapshot().value, { editing: "clean" });
  assert.equal(following.actor.getSnapshot().context.id, ID);

  const plain = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  assert.equal(plain.actor.getSnapshot().can({ type: "note.selected", id: ID }), false, "unfollowing editor ignores it");
});

test("note.opened is emitted on reopening at start, on load, on a followed selection, and on minting", async () => {
  // On start with notes: reopens ID2 and announces it.
  const start = editor({
    ask: (target, name) =>
      name === "list" ? Promise.resolve({ notes: [{ id: ID2, title: "N", updatedAt: 20 }] }) : Promise.resolve({ note: { ...NOTE, id: ID2 } }),
  });
  await tick();
  await tick();
  assert.deepEqual(start.opened, [ID2]);

  // On load.
  const loaded = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  loaded.actor.send({ type: "load", id: ID });
  await tick();
  assert.deepEqual(loaded.opened, [ID]);

  // On a followed selection.
  const followed = await started({ follows: true, ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  followed.actor.send({ type: "note.selected", id: ID2 });
  await tick();
  assert.deepEqual(followed.opened, [ID2]);

  // On minting from a keystroke into an editor holding no note.
  const minted = await started();
  minted.actor.send({ type: "_typed", body: "fresh" });
  assert.deepEqual(minted.opened, [ID]);
});

test("typing in blank saves under the loaded id with a null base", async () => {
  const { actor, clock, saved } = await started({
    follows: true,
    ask: answering({ list: { notes: [] }, read: { error: "not-found" } }),
  });
  actor.send({ type: "note.selected", id: ID2 });
  await tick();
  assert.equal(actor.getSnapshot().value, "blank");
  actor.send({ type: "_typed", body: "made\nhere" });
  clock.increment(DEBOUNCE_MS);
  assert.deepEqual(saved, [{ type: "note.saved", id: ID2, title: "made", body: "made\nhere", baseVersion: null }]);
});
