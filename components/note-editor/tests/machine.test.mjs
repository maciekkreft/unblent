import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, titleOf, parseBody, serialize, aboutTitleOf, sourceLinksIn, passageOf, isStaged } from "../machine.js";

// The editor's decisions, tested in full. The marker-stripping title and the
// parseBody/serialize transform between the wire markdown and the marker-free document
// the view edits are pure functions, tested at the end.
const HERE = dirname(fileURLToPath(import.meta.url));
const schemaOf = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["note.saved", "note.opened", "pin.toggled", "passage.selected", "note.staged", "note.closed"].map((n) => [n, schemaOf(n)]));
// Every emit of every test, checked against its schema by the last test.
const recorded = [];

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const THROTTLE_MS = 200;
const NOTE = { id: ID, title: "L", body: "L\nloaded", version: 7, pending: false, updatedAt: 9 };

const answering = (replies) => (target, name) => Promise.resolve(replies[name] ?? {});

// A target-aware ask for the follow-the-stage tests: notes: list, notes: read and
// subject: read all matter, and notes: read and subject: read share the name "read", so
// the plain `answering` (keyed on name alone) cannot tell them apart.
const asking =
  ({ list = { notes: [] }, note = { error: "not-found" }, subject = null } = {}) =>
  (target, name) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject });
    if (name === "list") return Promise.resolve(list);
    if (name === "read") return Promise.resolve(note);
    return Promise.resolve({});
  };

function editor({
  ask = answering({ list: { notes: [] } }),
  focus = () => {},
  follows = false,
  mint = () => ID,
  subjecting = false,
  staged = false,
  recall,
  forget,
  recallTitles,
  rememberTitles,
  // The note `pins` holds at start; pins: read is answered here so each test's own ask
  // only answers notes and subject.
  pinned = null,
  pushRegister,
} = {}) {
  const clock = new SimulatedClock();
  const saved = [];
  const opened = [];
  const toggled = [];
  const stagedIds = [];
  const closed = [];
  const asked = (target, name, payload) =>
    target === "pins" ? Promise.resolve({ note: pinned, chat: null, evaluators: null }) : ask(target, name, payload);
  const actor = createActor(machine, {
    input: { ask: asked, mint, focus, follows, subjecting, staged, recall, forget, recallTitles, rememberTitles, pushRegister },
    clock,
  });
  actor.on("note.saved", (e) => saved.push(e));
  actor.on("note.opened", (e) => opened.push(e.id));
  actor.on("pin.toggled", (e) => toggled.push(e.id));
  actor.on("note.staged", (e) => stagedIds.push(e.id));
  actor.on("note.closed", (e) => closed.push(e.id));
  for (const name of Object.keys(SCHEMAS)) actor.on(name, (value) => recorded.push({ value, schema: SCHEMAS[name] }));
  actor.start();
  return { actor, clock, saved, opened, toggled, staged: stagedIds, closed };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
// The follow tests chain two async queries (start's list+subject, then a read) and
// sometimes a second read (a forgotten pin), so drain a few microtask turns to settle.
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

// An editor past its start, in `empty`.
async function started(options) {
  const e = editor(options);
  await tick();
  assert.equal(e.actor.getSnapshot().value, "empty");
  return e;
}

test("typing in an empty editor mints an id and becomes dirty, emitting nothing yet", async () => {
  const { actor, saved } = await started();
  actor.send({ type: "_typed", body: "Hi\nyo" });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "dirty" });
  assert.equal(s.context.id, ID);
  assert.deepEqual(saved, []);
});

test("keystrokes inside the window are coalesced into one save, titled by its first line", async () => {
  const { actor, clock, saved } = await started();
  actor.send({ type: "_typed", body: "a" });
  clock.increment(THROTTLE_MS - 1);
  actor.send({ type: "_typed", body: "ab\nmore" });
  clock.increment(1);
  assert.deepEqual(saved, [{ type: "note.saved", id: ID, title: "ab", body: "ab\nmore", baseVersion: null }]);
  assert.deepEqual(actor.getSnapshot().value, { editing: "clean" });

  actor.send({ type: "_typed", body: "ab\nmore\nagain" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].body, "ab\nmore\nagain");
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
  clock.increment(THROTTLE_MS);
  actor.send({ type: "_typed", body: "T2\nB" });
  actor.send({ type: "note.changed", id: ID, title: "T", body: "T\nB", version: 1, pending: false, updatedAt: 1 });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "dirty" }, "still dirty");
  assert.equal(s.context.body, "T2\nB", "the keystroke made since is not lost");
  assert.equal(s.context.baseVersion, 1);
});

test("a newer change is adopted; an older one and another id are ignored", async () => {
  const { actor } = await started();
  actor.send({ type: "_typed", body: "mine" });
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
      if (target !== "settings") asked.push([target, name, payload]);
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
      ask: (...args) => ((args[0] === "settings" || asked.push(args)), Promise.resolve(args[1] === "list" ? { notes: [] } : reply)),
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
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].baseVersion, 7);
  assert.equal(saved[0].title, "L edited");
});

test("a pause that ends on the text notes already holds saves nothing", async () => {
  const { actor, clock, saved } = await started();
  actor.send({ type: "_typed", body: "T\nB" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  actor.send({ type: "_typed", body: "Tx\nB" });
  actor.send({ type: "_typed", body: "T\nB" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1, "the pause emitted nothing");
  assert.deepEqual(actor.getSnapshot().value, { editing: "clean" });
  actor.send({ type: "_typed", body: "Tx\nB" });
  actor.send({ type: "_typed", body: "T\nB" });
  actor.send({ type: "_blurred" });
  assert.equal(saved.length, 1, "nor the blur");

  const loaded = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  loaded.actor.send({ type: "load", id: ID });
  await tick();
  loaded.actor.send({ type: "_typed", body: "L!\nloaded" });
  loaded.actor.send({ type: "_typed", body: NOTE.body });
  loaded.clock.increment(THROTTLE_MS);
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

test("note.opened is emitted on reopening at start, on load, on a followed selection, on minting, and as null on the empty page", async () => {
  const start = editor({
    ask: (target, name) =>
      name === "list" ? Promise.resolve({ notes: [{ id: ID2, title: "N", updatedAt: 20 }] }) : Promise.resolve({ note: { ...NOTE, id: ID2 } }),
  });
  await tick();
  await tick();
  assert.deepEqual(start.opened, [ID2]);

  const loaded = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  loaded.actor.send({ type: "load", id: ID });
  await tick();
  assert.deepEqual(loaded.opened, [null, ID]);

  const followed = await started({ follows: true, ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  followed.actor.send({ type: "note.selected", id: ID2 });
  await tick();
  assert.deepEqual(followed.opened, [null, ID2]);

  const minted = await started();
  minted.actor.send({ type: "_typed", body: "fresh" });
  assert.deepEqual(minted.opened, [null, ID]);

  // The open note deleted: the empty page is announced, so it is not taken for open (12).
  loaded.actor.send({ type: "note.deleted", id: ID });
  assert.deepEqual(loaded.opened, [null, ID, null]);
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
  clock.increment(THROTTLE_MS);
  assert.deepEqual(saved, [{ type: "note.saved", id: ID2, title: "made", body: "made\nhere", baseVersion: null }]);
});

test("the open note being deleted falls back to the empty page", async () => {
  const { actor } = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  actor.send({ type: "load", id: ID });
  await tick();
  assert.deepEqual(actor.getSnapshot().value, { editing: "clean" });

  actor.send({ type: "note.deleted", id: ID });
  const s = actor.getSnapshot();
  assert.equal(s.value, "empty", "the deleted note is no longer shown");
  assert.equal(s.context.id, null);
  assert.equal(s.context.body, "");
});

test("a deletion of another note leaves the open one alone", async () => {
  const { actor } = await started({ ask: answering({ list: { notes: [] }, read: { note: NOTE } }) });
  actor.send({ type: "load", id: ID });
  await tick();
  actor.send({ type: "note.deleted", id: ID2 });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" }, "still showing the open note");
  assert.equal(s.context.id, ID);
});

// --- Following the stage and the pin (D7) --------------------------------------

const SUBJECT = { kind: "book", id: "bookA", title: "Dune" };
const SUBJECT_B = { kind: "book", id: "bookB", title: "Emma" };
const SUBJECT_C = { kind: "book", id: "bookC", title: "Foundation" };
const LINK_A = { kind: "book", id: "bookA" };
const LINK_B = { kind: "book", id: "bookB" };
const PLACE = { chapter: 0, contentVersion: 1, start: { block: 2, offset: 2 }, end: { block: 2, offset: 15 } };
const noteAbout = (id, link) => ({ id, title: "n", body: "n\nbody", version: 3, pending: false, updatedAt: 1, about: link ? [link] : [] });

test("with the subject attribute, start opens the newest note about the subject and records its title", async () => {
  const list = {
    notes: [
      { id: ID2, title: "unrelated", updatedAt: 20, about: [] },
      { id: ID, title: "about A", updatedAt: 10, about: [LINK_A] },
    ],
  };
  const { actor } = editor({ subjecting: true, ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }) });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID, "the note about the subject, not the newer unrelated one");
  assert.deepEqual(s.context.about, [LINK_A], "the open note's links are held for the About line");
  assert.equal(s.context.titles["book:bookA"], "Dune", "the subject's title is remembered");
});

test("with a subject on the stage but no note about it, start is the empty page", async () => {
  const list = { notes: [{ id: ID2, title: "unrelated", updatedAt: 20, about: [] }] };
  const { actor } = editor({ subjecting: true, ask: asking({ list, subject: SUBJECT }) });
  await settle();
  assert.equal(actor.getSnapshot().value, "empty");
});

test("a note about the subject that arrives on the empty page opens there; others leave it empty", async () => {
  // The empty page was chosen before the pull landed: notes lists nothing yet.
  const list = { notes: [] };
  const { actor, opened } = editor({ subjecting: true, ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }) });
  await settle();
  assert.equal(actor.getSnapshot().value, "empty");

  // An unrelated note and a highlight of the subject arrive: the page stays empty.
  actor.send({ type: "note.changed", ...noteAbout(ID2, LINK_B) });
  actor.send({ type: "note.changed", ...noteAbout(ID2, { ...LINK_A, place: PLACE }) });
  await settle();
  assert.equal(actor.getSnapshot().value, "empty", "neither is a note about the subject");

  // The pull brings a note about the subject: the editor opens it.
  list.notes = [noteAbout(ID, LINK_A)];
  actor.send({ type: "note.changed", ...noteAbout(ID, LINK_A) });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID);
  assert.equal(opened.at(-1), ID, "the note now shown is announced");
});

test("a note arriving once the user has typed leaves the new note on screen", async () => {
  const { actor, clock } = editor({ subjecting: true, mint: () => ID2, ask: asking({ subject: SUBJECT }) });
  await settle();
  actor.send({ type: "_typed", body: "mine" });
  clock.increment(THROTTLE_MS);
  actor.send({ type: "note.changed", ...noteAbout(ID, LINK_A) });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID2, "the note being written stays");
});

test("a highlight of the subject is never the note the editor opens", async () => {
  const list = {
    notes: [
      { id: ID2, title: "", updatedAt: 20, about: [{ ...LINK_A, place: PLACE }] },
      { id: ID, title: "about A", updatedAt: 10, about: [LINK_A] },
    ],
  };
  const { actor } = editor({ subjecting: true, ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }) });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID, "the plain note, not the newer highlight");
});

test("with the attribute on but nothing on the stage, start opens the empty page, not a note that would be pinned", async () => {
  const list = { notes: [{ id: ID2, title: "n", updatedAt: 20, about: [] }, { id: ID, title: "o", updatedAt: 10, about: [] }] };
  const { actor } = editor({ subjecting: true, ask: asking({ list, note: { note: noteAbout(ID2, null) }, subject: null }) });
  await settle();
  assert.equal(actor.getSnapshot().value, "empty");
  assert.equal(actor.getSnapshot().context.id, null);
});

test("a new note written while following carries one link to the subject; later edits leave links alone", async () => {
  const { actor, clock, saved } = editor({ subjecting: true, ask: asking({ subject: SUBJECT }) });
  await settle();
  assert.equal(actor.getSnapshot().value, "empty");
  actor.send({ type: "_typed", body: "fresh" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].about, [LINK_A], "a new note is about what is on the stage");
  actor.send({ type: "note.changed", id: ID, title: "fresh", body: "fresh", version: 1, pending: false, updatedAt: 1, about: [LINK_A] });
  actor.send({ type: "_typed", body: "fresh more" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].baseVersion, 1);
  assert.ok(!("about" in saved[1]), "an edit to an existing note does not touch its links (D2)");
});

test("a new note written with nothing on the stage carries an empty links list", async () => {
  const { actor, clock, saved } = editor({ subjecting: true, ask: asking({ subject: null }) });
  await settle();
  actor.send({ type: "_typed", body: "x" });
  clock.increment(THROTTLE_MS);
  assert.deepEqual(saved[0].about, []);
});

test("changing the subject saves a dirty draft, then opens the new subject's newest note", async () => {
  const list = {
    notes: [
      { id: ID2, title: "about B", updatedAt: 20, about: [LINK_B] },
      { id: ID, title: "about A", updatedAt: 10, about: [LINK_A] },
    ],
  };
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return Promise.resolve(list);
    if (name === "read") return Promise.resolve({ note: noteAbout(payload.id, payload.id === ID2 ? LINK_B : LINK_A) });
    return Promise.resolve({});
  };
  const { actor, saved } = editor({ subjecting: true, ask });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID, "opened A's note");
  actor.send({ type: "_typed", body: "n\nbody edited" });
  assert.deepEqual(actor.getSnapshot().value, { editing: "dirty" });

  actor.send({ type: "subject.changed", subject: SUBJECT_B });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, ID);
  assert.equal(saved[0].baseVersion, 3);
  assert.ok(!("about" in saved[0]));

  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID2, "re-followed to the note about the new subject");
});

test("a title-only subject change keeps the note on screen and updates what it shows", async () => {
  const list = { notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] };
  const { actor } = editor({ subjecting: true, ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }) });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bookA", title: "Dune (2nd ed.)" } });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" }, "the same note stays");
  assert.equal(s.context.id, ID);
  assert.equal(s.context.titles["book:bookA"], "Dune (2nd ed.)", "the new title is remembered for the About line");
});

test("a pinned editor keeps its note when the subject changes, only remembering the new subject", async () => {
  const list = { notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] };
  const { actor } = editor({ subjecting: true, ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }) });
  await settle();
  actor.send({ type: "_togglePin" });
  assert.equal(actor.getSnapshot().context.pinned, true);
  actor.send({ type: "subject.changed", subject: SUBJECT_B });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID, "the note did not change");
  assert.equal(s.context.subject.id, "bookB", "but the new subject is remembered");
});

test("a pinned editor opens a picked note and stays pinned on it, moving the pin to it", async () => {
  const list = { notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] };
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return Promise.resolve(list);
    if (name === "read") return Promise.resolve({ note: noteAbout(payload.id, LINK_A) });
    return Promise.resolve({});
  };
  const { actor, toggled } = editor({ subjecting: true, follows: true, ask });
  await settle();
  actor.send({ type: "_togglePin" });

  actor.send({ type: "note.selected", id: ID2 });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID2, "the pick opened");
  assert.equal(actor.getSnapshot().context.pinned, true, "the pin stays on the editor");
  assert.deepEqual(toggled, [ID, ID2], "the pin now holds the picked note");

  actor.send({ type: "load", id: ID });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID, "load opens too");
  assert.equal(toggled.at(-1), ID);
});

test("the pin does nothing while the editor holds no note", async () => {
  const { actor } = editor({ subjecting: true, ask: asking({ subject: SUBJECT }) });
  await settle();
  assert.equal(actor.getSnapshot().value, "empty");
  assert.equal(actor.getSnapshot().can({ type: "_togglePin" }), false, "the pin button is disabled with no note");
});

test("unpinning lets the editor follow the next subject change again", async () => {
  const list = {
    notes: [
      { id: ID2, title: "about C", updatedAt: 30, about: [{ kind: "book", id: "bookC" }] },
      { id: ID, title: "about A", updatedAt: 10, about: [LINK_A] },
    ],
  };
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return Promise.resolve(list);
    if (name === "read") return Promise.resolve({ note: noteAbout(payload.id, null) });
    return Promise.resolve({});
  };
  const { actor } = editor({ subjecting: true, follows: true, ask });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID, "started on A's note");
  actor.send({ type: "_togglePin" });
  actor.send({ type: "subject.changed", subject: SUBJECT_B });
  assert.equal(actor.getSnapshot().context.id, ID, "pinned: unchanged while B is on the stage");
  actor.send({ type: "_togglePin" });
  actor.send({ type: "subject.changed", subject: SUBJECT_C });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID2, "following resumed: opened C's note");
});

test("deleting the pinned note falls to the empty page and leaves the pin to pins", async () => {
  const list = { notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] };
  const { actor, toggled: forgot } = editor({
    subjecting: true,
    ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }),
  });
  await settle();
  actor.send({ type: "_togglePin" });
  assert.deepEqual(forgot, [ID], "the pin went to pins");
  actor.send({ type: "note.deleted", id: ID });
  const s = actor.getSnapshot();
  assert.equal(s.value, "empty");
  assert.equal(s.context.pinned, false);
  assert.deepEqual(forgot, [ID], "no press, so no pin.toggled: pins hears the empty page instead");
});

test("the note pins holds reopens and starts pinned, skipping the subject choice", async () => {
  const list = { notes: [{ id: ID2, title: "newest about A", updatedAt: 99, about: [LINK_A] }] };
  const { actor, toggled } = editor({
    subjecting: true,
    pinned: ID,
    ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }),
  });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID, "the pinned note, not the newest about the subject");
  assert.equal(s.context.pinned, true, "restored pinned");
  assert.deepEqual(toggled, [], "nothing to tell pins");
});

test("a pin kept under the editor's old key is handed to pins once, cleared, and reopens pinned", async () => {
  const list = { notes: [{ id: ID2, title: "newest about A", updatedAt: 99, about: [LINK_A] }] };
  let forgotten = 0;
  const { actor, toggled } = editor({
    subjecting: true,
    recall: () => ID,
    forget: () => forgotten++,
    ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }),
  });
  await settle();
  const s = actor.getSnapshot();
  assert.equal(s.context.id, ID, "the old pin's note");
  assert.equal(s.context.pinned, true, "restored pinned");
  assert.deepEqual(toggled, [ID], "pins now holds it");
  assert.equal(forgotten, 1, "the old key is cleared");
});

test("a pin in pins wins over the old key, which is still cleared", async () => {
  const list = { notes: [] };
  let forgotten = 0;
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return Promise.resolve(list);
    return Promise.resolve({ note: noteAbout(payload.id, LINK_A) });
  };
  const { actor, toggled } = editor({ subjecting: true, pinned: ID2, recall: () => ID, forget: () => forgotten++, ask });
  await settle();
  assert.equal(actor.getSnapshot().context.id, ID2);
  assert.deepEqual(toggled, []);
  assert.equal(forgotten, 1);
});

test("a pinned note that is gone is not reopened, and start falls back to the subject's note", async () => {
  const list = { notes: [{ id: ID2, title: "about A", updatedAt: 20, about: [LINK_A] }] };
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return Promise.resolve(list);
    if (name === "read") return Promise.resolve(payload.id === ID2 ? { note: noteAbout(ID2, LINK_A) } : { error: "not-found" });
    return Promise.resolve({});
  };
  const { actor, toggled: forgot } = editor({ subjecting: true, pinned: ID, ask });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID2, "fell back to the newest note about the subject");
  assert.equal(s.context.pinned, false);
  assert.deepEqual(forgot, [], "no press, so no pin.toggled: pins hears the note opened instead");
});

// --- The About line survives a reload, and names a new note (12) ----------------

// A start that stays pending until resolve() is called, so a keystroke can land while
// the editor is still waiting for the subject (the reload race).
const pendingStart = () => {
  let resolve;
  const gate = new Promise((r) => (resolve = r));
  const ask = (target, name) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return gate;
    return Promise.resolve({});
  };
  return { ask, resolve };
};

test("a subject.changed before the notes arrive keeps the pin: it reopens pinned", async () => {
  // subject.changed lands while start is still waiting for the notes list. The editor
  // must not re-follow the new subject and skip the pin restore.
  let resolveList;
  const gate = new Promise((r) => (resolveList = r));
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return gate;
    if (name === "read") return Promise.resolve({ note: noteAbout(payload.id, LINK_A) });
    return Promise.resolve({});
  };
  const { actor } = editor({ subjecting: true, pinned: ID, ask });
  actor.send({ type: "subject.changed", subject: SUBJECT_B });
  assert.equal(actor.getSnapshot().value, "starting", "still waiting for the notes");
  assert.equal(actor.getSnapshot().context.subject.id, "bookB", "the new subject was taken");
  resolveList({ notes: [{ id: ID2, title: "newest about B", updatedAt: 99, about: [LINK_B] }] });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID, "the remembered pinned note, not B's note the re-follow would open");
  assert.equal(s.context.pinned, true, "restored pinned despite the racing subject change");
});

test("a subject.changed before the notes arrive, no pin, follows the new subject with one list query", async () => {
  const listCalls = [];
  let resolve;
  const gate = new Promise((r) => (resolve = r));
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") {
      listCalls.push(payload);
      return listCalls.length === 1 ? gate : Promise.resolve({ notes: [{ id: ID2, title: "about B", updatedAt: 20, about: [LINK_B] }] });
    }
    if (name === "read") return Promise.resolve({ note: noteAbout(ID2, LINK_B) });
    return Promise.resolve({});
  };
  const { actor } = editor({ subjecting: true, ask });
  actor.send({ type: "subject.changed", subject: SUBJECT_B });
  resolve({ notes: [{ id: ID2, title: "about B", updatedAt: 20, about: [LINK_B] }] });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: "clean" });
  assert.equal(s.context.id, ID2, "opened the note about the subject now on the stage");
  assert.equal(listCalls.length, 1, "the start's list is reused, not asked a second time");
});

test("a subject.changed while the pinned note is loading keeps it", async () => {
  let resolveRead;
  const list = { notes: [{ id: ID2, title: "about A", updatedAt: 20, about: [LINK_A] }] };
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return Promise.resolve(list);
    if (name === "read") return new Promise((r) => (resolveRead = () => r({ note: noteAbout(payload.id, LINK_A) })));
    return Promise.resolve({});
  };
  const { actor } = editor({ subjecting: true, pinned: ID, ask });
  await settle();
  assert.equal(actor.getSnapshot().value, "loading", "the remembered note is loading");
  actor.send({ type: "subject.changed", subject: SUBJECT_B });
  resolveRead();
  await settle();
  const s = actor.getSnapshot();
  assert.equal(s.context.id, ID, "the pinned note stayed, though the stage moved");
  assert.equal(s.context.subject.id, "bookB", "the new subject was still taken");
});

test("reload race: a slow notes reply does not clobber a subject.changed with the read's null", async () => {
  // subject: read replies null (the book is not open yet), the book comes back on its
  // own while the notes list is still loading, then the slow notes reply lands last.
  // The start reply's null must not overwrite the changed subject.
  let resolveList;
  const gate = new Promise((r) => (resolveList = r));
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: null });
    if (name === "list") return gate;
    if (name === "read") return Promise.resolve({ note: noteAbout(payload.id, LINK_A) });
    return Promise.resolve({});
  };
  const { actor } = editor({ subjecting: true, ask });
  actor.send({ type: "subject.changed", subject: SUBJECT });
  assert.equal(actor.getSnapshot().value, "starting", "still waiting for the notes");
  assert.deepEqual(actor.getSnapshot().context.subject, SUBJECT, "the change was taken");
  resolveList({ notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.context.subject, SUBJECT, "the notes reply left the changed subject in place");
  assert.equal(s.context.id, ID, "and it opened the note about the book, not the newest overall");
});

test("with no later change, the start reply's subject is the starting picture", async () => {
  const list = { notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] };
  const { actor } = editor({ subjecting: true, ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }) });
  await settle();
  const s = actor.getSnapshot();
  assert.deepEqual(s.context.subject, SUBJECT, "the read reply set the subject, no change needed");
  assert.equal(s.context.id, ID, "and opened the note about it");
});

test("a subject.changed clearing the stage to null is not overwritten by the start reply", async () => {
  // The stage held the book at read time, then was cleared while the notes list loaded.
  // The old "subject is non-null" guard let the start reply revive the book; the
  // observed-change flag keeps the cleared null.
  let resolveList;
  const gate = new Promise((r) => (resolveList = r));
  const ask = (target, name, payload) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT });
    if (name === "list") return gate;
    if (name === "read") return Promise.resolve({ note: noteAbout(payload.id, LINK_A) });
    return Promise.resolve({});
  };
  const { actor } = editor({ subjecting: true, ask });
  actor.send({ type: "subject.changed", subject: null });
  assert.equal(actor.getSnapshot().context.subject, null, "the stage was cleared");
  resolveList({ notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] });
  await settle();
  assert.equal(actor.getSnapshot().context.subject, null, "the start reply did not revive the book");
});

test("titles are recalled at start, so the About line names a link the session never saw", () => {
  // The open note is about A; the stage holds B. Only A's title, recalled from storage,
  // lets the About line name it.
  const snapshot = {
    context: { about: [LINK_A], titles: { "book:bookA": "Dune" }, subjecting: true, subject: SUBJECT_B, baseVersion: 3 },
    matches: () => false,
  };
  assert.equal(aboutTitleOf(snapshot), "Dune");
});

test("every subject taken is written back through rememberTitles", async () => {
  const written = [];
  const list = { notes: [{ id: ID, title: "about A", updatedAt: 10, about: [LINK_A] }] };
  const { actor } = editor({
    subjecting: true,
    recallTitles: () => ({}),
    rememberTitles: (t) => written.push({ ...t }),
    ask: asking({ list, note: { note: noteAbout(ID, LINK_A) }, subject: SUBJECT }),
  });
  await settle();
  assert.equal(written.at(-1)["book:bookA"], "Dune", "the start subject's title was stored");
  actor.send({ type: "subject.changed", subject: SUBJECT_B });
  await settle();
  assert.equal(written.at(-1)["book:bookB"], "Emma", "the changed subject's title was stored too");
});

test("with subjecting, a keystroke before the subject is known is held, then saved with the link", async () => {
  const { ask, resolve } = pendingStart();
  const { actor, clock, saved, opened } = editor({ subjecting: true, ask });
  actor.send({ type: "_typed", body: "held" });
  assert.equal(actor.getSnapshot().value, "starting", "the keystroke did not leave starting");
  assert.equal(actor.getSnapshot().context.body, "held", "the text is on screen");
  assert.deepEqual(opened, [ID], "the minted id was announced once");
  resolve({ notes: [] });
  await settle();
  assert.deepEqual(actor.getSnapshot().value, { editing: "dirty" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].about, [LINK_A], "the first save carries the link the subject named");
});

test("with subjecting, a keystroke before start fails still saves, with an empty link list", async () => {
  let reject;
  const ask = (target, name) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: null });
    if (name === "list") return new Promise((_, r) => (reject = r));
    return Promise.resolve({});
  };
  const { actor, clock, saved } = editor({ subjecting: true, ask });
  actor.send({ type: "_typed", body: "x" });
  reject(new Error("offline"));
  await settle();
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].about, [], "no subject was known, so no link");
});

test("aboutTitleOf names the stage subject on a new note only with no links", () => {
  const fresh = (level, extra = {}) => ({
    context: { about: [], titles: {}, subjecting: true, subject: SUBJECT, baseVersion: null, ...extra },
    matches: (v) => v === level,
  });
  // A new note: the stage's subject.
  assert.equal(aboutTitleOf(fresh("empty")), "Dune");
  assert.equal(aboutTitleOf(fresh("editing")), "Dune", "a dirty draft with no version yet still counts as new");
  // No subject on the stage: nothing to name.
  assert.equal(aboutTitleOf({ context: { about: [], titles: {}, subjecting: true, subject: null, baseVersion: null }, matches: (v) => v === "empty" }), null);
  // While a note may still arrive (loading/starting), the line stays quiet.
  assert.equal(aboutTitleOf({ context: { about: [], titles: {}, subjecting: true, subject: SUBJECT, baseVersion: null }, matches: () => false }), null);
});

test("with the attribute off, no subject is asked and saves carry no links (today's behaviour)", async () => {
  const asked = [];
  const { actor, clock, saved } = editor({
    ask: (target, name, payload) => {
      asked.push([target, name]);
      return Promise.resolve(name === "list" ? { notes: [] } : {});
    },
  });
  await settle();
  assert.ok(!asked.some(([t]) => t === "subject"), "subject is never asked when the attribute is off");
  actor.send({ type: "_typed", body: "plain" });
  clock.increment(THROTTLE_MS);
  assert.ok(!("about" in saved[0]), "no links ride a save when not following the stage");
});

// --- The marker-stripping title and the wire<->doc transform ----------------------

test("the title is the first line, with its level marker stripped", () => {
  assert.equal(titleOf("# Hello\nworld"), "Hello");
  assert.equal(titleOf("## Section\nbody"), "Section");
  assert.equal(titleOf("### Small\nbody"), "Small");
  assert.equal(titleOf("plain\nworld"), "plain");
  assert.equal(titleOf("\n\n  # Second  \nmore"), "Second");
  assert.equal(titleOf("#no-space stays"), "#no-space stays"); // a hashtag is not a marker
  assert.equal(titleOf(""), "");
  // A list item's bullet is not part of the title.
  assert.equal(titleOf("- Groceries\n- milk"), "Groceries");
  assert.equal(titleOf("  * Starred"), "Starred");
});

test("parseBody splits markers into a marker-free doc plus per-line levels", () => {
  assert.deepEqual(parseBody("# T\n## H\nbody\n### S"), {
    doc: "T\nH\nbody\nS",
    levels: ["title", "heading", "body", "subheading"],
  });
  assert.deepEqual(parseBody("just text"), { doc: "just text", levels: ["body"] });
});

test("an empty note starts as a Body first line and serializes back to empty", () => {
  assert.deepEqual(parseBody(""), { doc: "", levels: ["body"] });
  assert.equal(serialize("", ["body"]), ""); // opening a blank note never mints a "# "
});

test("parseBody and serialize round-trip every level", () => {
  for (const md of ["# T\n## H\n### S\nbody", "plain only", "# a\nb\n\n## c", "line\nline2"]) {
    const { doc, levels } = parseBody(md);
    assert.equal(serialize(doc, levels), md, md);
  }
});

test("a blank line is a paragraph gap, never a marker, and typed blank lines round-trip unchanged", () => {
  assert.equal(serialize("T\n\nbody", ["title", "heading", "body"]), "# T\n\nbody");
  const md = "## Title\n\nPara one\n\nPara two\n\n";
  const { doc, levels } = parseBody(md);
  assert.equal(doc, "Title\n\nPara one\n\nPara two\n\n");
  assert.deepEqual(levels, ["heading", "body", "body", "body", "body", "body", "body"]);
  assert.equal(serialize(doc, levels), md);
});

test("known edge: a Body line whose text begins with a marker re-parses as a heading", () => {
  assert.equal(serialize("# typed as body", ["body"]), "# typed as body");
  assert.deepEqual(parseBody("# typed as body"), { doc: "typed as body", levels: ["title"] });
});

test("a save carries the stripped title and the markdown body verbatim", async () => {
  const { actor, clock, saved } = editor();
  await tick();
  actor.send({ type: "_typed", body: "# Kickoff\n## Agenda\nnotes" });
  clock.increment(THROTTLE_MS);
  assert.deepEqual(saved, [
    { type: "note.saved", id: ID, title: "Kickoff", body: "# Kickoff\n## Agenda\nnotes", baseVersion: null },
  ]);
});

// The "Vim keys" preference (12): asked of settings at start, followed after.
const withSettings = (reply) => (target, name) => {
  if (target === "settings" && name === "read") return Promise.resolve(reply);
  if (name === "list") return Promise.resolve({ notes: [] });
  return Promise.resolve({});
};

test("Vim keys start from settings: read, and are off until it answers", async () => {
  const { actor } = editor({ ask: withSettings({ vimKeys: true, profile: "workshop" }) });
  assert.equal(actor.getSnapshot().context.vimKeys, false, "off before the reply");
  await settle();
  assert.equal(actor.getSnapshot().context.vimKeys, true);
});

test("Vim keys follow settings.changed, in any state", async () => {
  const { actor } = await started({ ask: withSettings({ vimKeys: false }) });
  actor.send({ type: "settings.changed", vimKeys: true });
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "_typed", body: "x" });
  actor.send({ type: "settings.changed", vimKeys: false });
  const s = actor.getSnapshot();
  assert.equal(s.context.vimKeys, false);
  assert.deepEqual(s.value, { editing: "dirty" }, "the switch never moves the editor");
  assert.equal(s.context.body, "x", "and never touches the draft");
});

test("an error reply, or a reply without the field, leaves Vim keys off", async () => {
  for (const reply of [{ error: "no-answerer" }, { profile: "product" }]) {
    const { actor } = editor({ ask: withSettings(reply) });
    await settle();
    assert.equal(actor.getSnapshot().context.vimKeys, false, JSON.stringify(reply));
  }
});

// Source links: the stored form book-reader's Copy link writes, `[label](note:<id>)`.
const HL = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FD0";
const PASSAGE = { chapter: 2, contentVersion: 1, start: { block: 3, offset: 4 }, end: { block: 3, offset: 20 } };
const HIGHLIGHT = {
  note: {
    id: HL, title: "", body: "", version: 1, pending: false, updatedAt: 1,
    about: [{ kind: "book", id: BOOK, place: PASSAGE, quote: { exact: "The quote", prefix: "", suffix: "" } }],
  },
};

test("source links are found by their range, with the label's escapes off", () => {
  const link = `[A \\[b\\] c…](note:${HL})`;
  const text = `before ${link} after [plain](https://x.y) [x](note:short)`;
  assert.deepEqual(sourceLinksIn(text), [{ from: 7, to: 7 + link.length, id: HL, label: "A [b] c…" }]);
  assert.deepEqual(sourceLinksIn(`[a](note:${HL})[b](note:${ID})`).map((l) => l.label), ["a", "b"]);
  assert.deepEqual(sourceLinksIn("no links\n[a\nb](note:" + HL + ")"), [], "a label never spans lines");
});

test("a source link goes to the passage the highlight's link to its book carries", () => {
  assert.deepEqual(passageOf(HIGHLIGHT, HL), { book: BOOK, id: HL, place: PASSAGE });
  assert.equal(passageOf({ error: "not-found" }, HL), null);
  assert.equal(passageOf({ note: { ...HIGHLIGHT.note, about: [{ kind: "book", id: BOOK }] } }, HL), null, "a note marking no passage");
  assert.equal(passageOf(null, HL), null);
});

const reading = (reply) => (target, name, payload) =>
  name === "read" && payload.id === HL ? Promise.resolve(reply) : Promise.resolve(name === "list" ? { notes: [] } : {});

test("following a source link announces the passage and leaves the draft alone", async () => {
  const { actor } = await started({ ask: reading(HIGHLIGHT) });
  const selected = [];
  actor.on("passage.selected", (e) => { selected.push(e); recorded.push({ value: e, schema: SCHEMAS["passage.selected"] }); });
  actor.send({ type: "_typed", body: "draft" });
  actor.send({ type: "_follow", id: HL });
  await settle();
  assert.deepEqual(selected, [{ type: "passage.selected", book: BOOK, id: HL, place: PASSAGE }]);
  assert.deepEqual(actor.getSnapshot().value, { editing: "dirty" });
  assert.equal(actor.getSnapshot().context.body, "draft");
});

test("following a link to a removed highlight marks it removed and announces nothing", async () => {
  const { actor } = await started({ ask: reading({ error: "not-found" }) });
  const selected = [];
  actor.on("passage.selected", (e) => selected.push(e));
  actor.send({ type: "_follow", id: HL });
  await settle();
  assert.deepEqual(selected, []);
  assert.deepEqual(actor.getSnapshot().context.removed, [HL]);
});

test("a copied link goes into Vim's register", async () => {
  const pushed = [];
  const { actor } = await started({ pushRegister: (text) => pushed.push(text) });
  actor.send({ type: "link.copied", id: HL, text: `[q](note:${HL})` });
  assert.deepEqual(pushed, [`[q](note:${HL})`]);
});

// Open on stage: the panel editor asks the stage to show its note, and the stage's own
// editor shows what the stage names without ever announcing it.
test("Open on stage, or :tab split, asks the stage to show the open note; never with no note", async () => {
  const { actor, staged } = editor({ subjecting: true, ask: asking({ note: { note: NOTE } }) });
  await settle();
  actor.send({ type: "_stage" });
  assert.deepEqual(staged, [], "no note is open yet");
  actor.send({ type: "load", id: ID });
  await settle();
  actor.send({ type: "_stage" });
  actor.send({ type: "_stage" });
  assert.deepEqual(staged, [ID, ID], "pressed again, it asks again, so the stage brings the tab forward");
});

test("an editor without `subject` offers no Open on stage", async () => {
  const { actor, staged } = editor({ ask: asking({ note: { note: NOTE } }) });
  await settle();
  actor.send({ type: "load", id: ID });
  await settle();
  actor.send({ type: "_stage" });
  assert.deepEqual(staged, []);
});

test("the open note is staged while any stage's tabs name it", async () => {
  const { actor } = editor({ subjecting: true, ask: asking({ note: { note: NOTE } }) });
  await settle();
  actor.send({ type: "load", id: ID });
  await settle();
  assert.equal(isStaged(actor.getSnapshot().context), false);
  const tab = (id) => ({ id, label: "x", closable: true });
  actor.send({ type: "tabs.shown", view: "book-stage", tabs: [tab(ID2), tab(ID)], active: ID2 });
  assert.equal(isStaged(actor.getSnapshot().context), true);
  actor.send({ type: "tabs.shown", view: "other-stage", tabs: [], active: null });
  assert.equal(isStaged(actor.getSnapshot().context), true, "another view's tabs leave this one's alone");
  actor.send({ type: "tabs.shown", view: "book-stage", tabs: [tab(ID2)], active: ID2 });
  assert.equal(isStaged(actor.getSnapshot().context), false);
});

test("a new desk layout tells the view to point the arrow again", async () => {
  const { actor } = editor({ subjecting: true, ask: asking({ note: { note: NOTE } }) });
  await settle();
  const before = actor.getSnapshot().context.layouts;
  actor.send({ type: "dock.changed", stage: "book-stage", docks: {} });
  assert.equal(actor.getSnapshot().context.layouts, before + 1);
});

test("the stage's editor shows what load names and never announces it", async () => {
  const notes = { notes: [{ id: ID2, title: "Newest", updatedAt: 10, about: [] }] };
  const { actor, opened, toggled } = editor({ staged: true, ask: asking({ list: notes, note: { note: NOTE } }) });
  await settle();
  assert.equal(actor.getSnapshot().value, "empty", "it opens nothing by itself");
  actor.send({ type: "load", id: ID });
  await settle();
  assert.deepEqual(actor.getSnapshot().value, { editing: "clean" });
  assert.equal(actor.getSnapshot().context.body, NOTE.body);
  actor.send({ type: "note.deleted", id: ID });
  assert.deepEqual(opened, [], "`pins` never takes a note on the stage for the pinned one");
  assert.deepEqual(toggled, []);
});

test("the stage's editor ignores the list's selection, the subject and the pin", async () => {
  const { actor } = editor({ staged: true, ask: asking({ note: { note: NOTE } }) });
  await settle();
  actor.send({ type: "load", id: ID });
  await settle();
  actor.send({ type: "note.selected", id: ID2 });
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "b", title: "B" } });
  actor.send({ type: "_togglePin" });
  actor.send({ type: "_stage" });
  const { context } = actor.getSnapshot();
  assert.equal(context.id, ID);
  assert.equal(context.pinned, false);
});

test(":q or :tabc in the stage's editor closes its tab; elsewhere it does nothing", async () => {
  const stage = editor({ staged: true, ask: asking({ note: { note: NOTE } }) });
  await settle();
  stage.actor.send({ type: "_quit" });
  assert.deepEqual(stage.closed, [], "no note on the stage yet");
  stage.actor.send({ type: "load", id: ID });
  await settle();
  stage.actor.send({ type: "_quit" });
  assert.deepEqual(stage.closed, [ID]);
  const panel = editor({ subjecting: true, ask: asking({ note: { note: NOTE } }) });
  await settle();
  panel.actor.send({ type: "load", id: ID });
  await settle();
  panel.actor.send({ type: "_quit" });
  assert.deepEqual(panel.closed, []);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
