import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine } from "../machine.js";

// The fade window, driven by a SimulatedClock so a passing notice is tested without
// waiting real time (the view reads the value from --duration-undo).
const FADE_MS = 100;

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const tick = () => new Promise((r) => setTimeout(r, 0));

function start({ fadeMs = FADE_MS } = {}) {
  const saved = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { fadeMs }, clock });
  actor.on("note.saved", (e) => saved.push(e));
  actor.start();
  return { actor, saved, clock };
}

const notices = (actor) => actor.getSnapshot().context.notices;
const notice = (actor, key) => notices(actor).get(key);

const conflict = (id = ID, mine = { title: "Mine", body: "mine", baseVersion: 1 }, theirs = { title: "Theirs", body: "theirs", version: 3, updatedAt: 9 }) =>
  ({ type: "note.conflicted", id, mine, theirs });

// --- Conflicts stand and keep the user's copy -----------------------------------

test("a conflict becomes a standing notice with one keep-mine action, and never fades", () => {
  const { actor, clock } = start();
  actor.send(conflict());
  const n = notice(actor, `note.conflicted:${ID}`);
  assert.ok(n, "a notice for the note");
  assert.equal(n.standing, true, "a conflict stands until dismissed");
  assert.equal(n.actions.length, 1);
  assert.equal(n.actions[0].label, "keep-mine");
  clock.increment(FADE_MS * 5);
  assert.ok(notice(actor, `note.conflicted:${ID}`), "still there long after any fade window");
});

test("keep mine emits note.saved based on theirs, once, and clears the notice", async () => {
  const { actor, saved } = start();
  actor.send(conflict());
  actor.send({ type: "_act", key: `note.conflicted:${ID}`, index: 0 });
  await tick();
  assert.deepEqual(saved, [
    { type: "note.saved", id: ID, title: "Mine", body: "mine", baseVersion: 3 },
  ]);
  assert.equal(notices(actor).size, 0, "the notice is done");
});

test("a second conflict on the same id replaces the first: one notice, newest copy", () => {
  const { actor } = start();
  actor.send(conflict());
  actor.send(conflict(ID, { title: "Mine2", body: "mine2", baseVersion: 3 }, { title: "T", body: "t", version: 4, updatedAt: 20 }));
  assert.equal(notices(actor).size, 1, "coalesced by id");
  assert.equal(notice(actor, `note.conflicted:${ID}`).actions[0].emit.baseVersion, 4, "the newer conflict's copy");
});

test("dismissing a conflict emits nothing: keeping theirs is already the state", async () => {
  const { actor, saved } = start();
  actor.send(conflict());
  actor.send({ type: "_dismiss", key: `note.conflicted:${ID}` });
  await tick();
  assert.equal(notices(actor).size, 0);
  assert.deepEqual(saved, []);
});

// --- A deleted note strips a dead action ----------------------------------------

test("note.deleted for a conflicted id strips the action and marks it gone", async () => {
  const { actor, saved } = start();
  actor.send(conflict());
  actor.send({ type: "note.deleted", id: ID });
  const n = notice(actor, `note.conflicted:${ID}`);
  assert.equal(n.gone, true, "the note is gone");
  assert.deepEqual(n.actions, [], "no action to keep a copy the server tombstoned");
  actor.send({ type: "_act", key: `note.conflicted:${ID}`, index: 0 });
  await tick();
  assert.deepEqual(saved, [], "a keep-mine onto a tombstone emits nothing");
});

test("note.deleted for an id with no notice does nothing", () => {
  const { actor } = start();
  actor.send({ type: "note.deleted", id: ID });
  assert.equal(notices(actor).size, 0);
});

// --- Refusals: some stand, some pass --------------------------------------------

test("a cancelled sign-in passes: gone after the window, not before", () => {
  const { actor, clock } = start();
  actor.send({ type: "session.refused", reason: "cancelled" });
  assert.ok(notice(actor, "session.refused:cancelled"), "shown at once");
  clock.increment(FADE_MS - 1);
  assert.ok(notice(actor, "session.refused:cancelled"), "still there a tick before the window ends");
  clock.increment(1);
  assert.equal(notices(actor).size, 0, "and gone when it elapses");
});

test("hold stops the fade; release starts a whole window again", () => {
  const { actor, clock } = start();
  actor.send({ type: "session.refused", reason: "unavailable" });
  const key = "session.refused:unavailable";
  clock.increment(FADE_MS - 1);
  actor.send({ type: "_hold", key });
  clock.increment(FADE_MS * 3);
  assert.ok(notice(actor, key), "a held notice never vanishes");
  actor.send({ type: "_release", key });
  clock.increment(FADE_MS - 1);
  assert.ok(notice(actor, key), "the window restarted in full");
  clock.increment(1);
  assert.equal(notices(actor).size, 0, "then it elapses");
});

test("registration-closed stands; dismiss removes it and emits nothing", async () => {
  const { actor, saved, clock } = start();
  actor.send({ type: "session.refused", reason: "registration-closed" });
  const key = "session.refused:registration-closed";
  assert.equal(notice(actor, key).standing, true);
  clock.increment(FADE_MS * 5);
  assert.ok(notice(actor, key), "a standing refusal does not fade");
  actor.send({ type: "_dismiss", key });
  await tick();
  assert.equal(notices(actor).size, 0);
  assert.deepEqual(saved, []);
});

test("an unknown refusal reason still shows without throwing", () => {
  const { actor } = start();
  actor.send({ type: "session.refused", reason: "some-future-reason" });
  assert.ok(notice(actor, "session.refused:some-future-reason"), "the table never throws on a new reason");
});

test("two distinct notices stack independently", () => {
  const { actor } = start();
  actor.send(conflict());
  actor.send({ type: "session.refused", reason: "cancelled" });
  assert.equal(notices(actor).size, 2, "one key each");
});
