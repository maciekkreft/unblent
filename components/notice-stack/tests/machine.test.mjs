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

// --- Book refusals: one passing notice per reason -------------------------------

for (const reason of ["signed-out", "unreadable", "unavailable"]) {
  test(`a book.refused (${reason}) passes and is keyed by its reason`, () => {
    const { actor, clock } = start();
    actor.send({ type: "book.refused", id: ID, reason });
    const key = `book.refused:${reason}`;
    assert.ok(notice(actor, key), "shown at once");
    assert.equal(notice(actor, key).standing, false, "a book refusal is only news");
    clock.increment(FADE_MS);
    assert.equal(notices(actor).size, 0, "and gone when its window elapses");
  });
}

test("a repeated book.refused of the same reason replaces rather than piles up", () => {
  const { actor } = start();
  actor.send({ type: "book.refused", id: ID, reason: "unreadable" });
  actor.send({ type: "book.refused", id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", reason: "unreadable" });
  assert.equal(notices(actor).size, 1, "coalesced by reason");
});

// --- Removals: Undo, or settle when the window ends -------------------------------

const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function startRemovals() {
  const s = start();
  const out = [];
  s.actor.on("removal.undone", (e) => out.push(e));
  s.actor.on("removal.settled", (e) => out.push(e));
  return { ...s, out };
}

const rkey = (kind, id) => "removal:" + kind + ":" + id;
const removal = (kind = "option", id = ID, name = "Goal") => ({ type: "removal.started", kind, id, name });

test("a removal shows a passing notice with one Undo action", () => {
  const { actor, out } = startRemovals();
  actor.send(removal());
  const n = notice(actor, rkey("option", ID));
  assert.ok(n, "shown at once");
  assert.equal(n.standing, false);
  assert.deepEqual(n.actions.map((a) => a.label), ["undo"]);
  assert.deepEqual(out, [], "nothing is final yet");
});

test("Undo emits removal.undone, closes the notice, and never settles", () => {
  const { actor, out, clock } = startRemovals();
  actor.send(removal());
  actor.send({ type: "_act", key: rkey("option", ID), index: 0 });
  clock.increment(FADE_MS * 3);
  assert.deepEqual(out, [{ type: "removal.undone", kind: "option", id: ID }]);
  assert.equal(notices(actor).size, 0);
});

test("the window running out settles the removal, not before", () => {
  const { actor, out, clock } = startRemovals();
  actor.send(removal("case", ID, ""));
  clock.increment(FADE_MS - 1);
  assert.deepEqual(out, []);
  clock.increment(1);
  assert.deepEqual(out, [{ type: "removal.settled", kind: "case", id: ID }]);
  assert.equal(notices(actor).size, 0);
});

test("dismissing a removal settles it at once, once", () => {
  const { actor, out, clock } = startRemovals();
  actor.send(removal("project"));
  actor.send({ type: "_dismiss", key: rkey("project", ID) });
  clock.increment(FADE_MS * 3);
  assert.deepEqual(out, [{ type: "removal.settled", kind: "project", id: ID }]);
});

test("hovering holds a removal's window; leaving starts a whole one", () => {
  const { actor, out, clock } = startRemovals();
  actor.send(removal());
  const key = rkey("option", ID);
  clock.increment(FADE_MS - 1);
  actor.send({ type: "_hold", key });
  clock.increment(FADE_MS * 5);
  assert.deepEqual(out, [], "held: not settled");
  actor.send({ type: "_release", key });
  clock.increment(FADE_MS - 1);
  assert.deepEqual(out, []);
  clock.increment(1);
  assert.deepEqual(out, [{ type: "removal.settled", kind: "option", id: ID }]);
});

test("several removals stack, each with its own window", () => {
  const { actor, out, clock } = startRemovals();
  actor.send(removal("question", ID, ""));
  clock.increment(FADE_MS / 2);
  actor.send(removal("rubric", ID2, "Replyability"));
  assert.equal(notices(actor).size, 2);
  clock.increment(FADE_MS / 2);
  assert.deepEqual(out, [{ type: "removal.settled", kind: "question", id: ID }], "the first ends on its own clock");
  actor.send({ type: "_act", key: rkey("rubric", ID2), index: 0 });
  clock.increment(FADE_MS * 2);
  assert.deepEqual(out.slice(1), [{ type: "removal.undone", kind: "rubric", id: ID2 }], "the second is undone, not settled");
});

test("leaving the page settles every open removal and keeps other notices", () => {
  const { actor, out, clock } = startRemovals();
  actor.send(conflict());
  actor.send(removal("case", ID));
  actor.send(removal("option", ID2, "Value"));
  actor.send({ type: "_leave" });
  assert.deepEqual(out, [
    { type: "removal.settled", kind: "case", id: ID },
    { type: "removal.settled", kind: "option", id: ID2 },
  ]);
  assert.deepEqual([...notices(actor).keys()], ["note.conflicted:" + ID]);
  clock.increment(FADE_MS * 3);
  assert.equal(out.length, 2, "no second settle from a cancelled timer");
});

// --- The admin's actions on a guest (12) ------------------------------------------

function startGuestActions() {
  const out = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { fadeMs: FADE_MS }, clock });
  actor.on("use.reset", (e) => out.push(e));
  actor.on("guest.blocked", (e) => out.push(e));
  actor.on("removal.settled", (e) => out.push(e));
  actor.start();
  return { actor, out, clock };
}

test("Reset use shows a dark notice whose Undo brings the use back, and nothing settles", () => {
  const { actor, out, clock } = startGuestActions();
  actor.send({ type: "use.reset", user: "g14" });
  const n = notice(actor, "use.reset:g14");
  assert.equal(n.undo, true, "drawn like a removal, with Undo");
  actor.send({ type: "_act", key: "use.reset:g14", index: 0 });
  clock.increment(FADE_MS * 3);
  assert.deepEqual(out, [{ type: "use.reset", user: "g14", undone: true }]);
  assert.equal(notices(actor).size, 0);
  actor.send({ type: "use.reset", user: "g14", undone: true });
  assert.equal(notices(actor).size, 0, "an Undo is no news to show");
});

test("Block and Unblock each offer an Undo that does the opposite, and pass on their own", () => {
  const { actor, out, clock } = startGuestActions();
  actor.send({ type: "guest.blocked", user: "g9", blocked: true });
  actor.send({ type: "_act", key: "guest.blocked:g9", index: 0 });
  actor.send({ type: "guest.blocked", user: "g9", blocked: false });
  assert.ok(notice(actor, "guest.blocked:g9"));
  clock.increment(FADE_MS);
  assert.equal(notices(actor).size, 0);
  assert.deepEqual(out, [{ type: "guest.blocked", user: "g9", blocked: false }]);
});
