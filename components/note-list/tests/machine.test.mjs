import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, shown, apart, highlights } from "../machine.js";

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

function list({ ask, mint = minter(), undoMs = UNDO_MS, following = false, keepsOpen = false, showsHighlights = false } = {}) {
  const selected = [];
  const discarded = [];
  const highlighted = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { ask, mint, undoMs, following, keepsOpen, showsHighlights }, clock });
  actor.on("note.selected", (e) => selected.push(e.id));
  actor.on("note.discarded", (e) => discarded.push(e.id));
  actor.on("highlights.selected", (e) => highlighted.push(e.about));
  actor.start();
  return { actor, selected, discarded, highlighted, clock };
}

const answeringList = (notes) => (target, name) =>
  Promise.resolve(name === "list" ? { notes } : {});

// Answers both the list and, for a following list, subject: read.
const answering = ({ notes = [], subject = null }) => (target, name) => {
  if (name === "list") return Promise.resolve({ notes });
  if (target === "subject" && name === "read") return Promise.resolve({ subject });
  return Promise.resolve({});
};

const ids = (actor) => actor.getSnapshot().context.notes.map((n) => n.id);
const shownIds = (actor) => shown(actor.getSnapshot().context).map((n) => n.id);
const apartId = (actor) => apart(actor.getSnapshot().context)?.id ?? null;
const hl = (actor) => highlights(actor.getSnapshot().context);
const highlightsOpen = (actor) => actor.getSnapshot().context.highlightsOpen;

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

// --- Following the stage: the subject's notes only (D5, D6) ------------------------

test("following a subject, every note is kept but only those about it are shown", async () => {
  const asked = [];
  const { actor } = list({
    following: true,
    ask: (...args) => {
      asked.push(args);
      return answering({
        notes: [
          { id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] },
          { id: B, title: "B", updatedAt: 20, about: [{ kind: "book", id: "bk2" }] },
          { id: C, title: "C", updatedAt: 30, about: [] },
        ],
        subject: { kind: "book", id: "bk1", title: "Dune" },
      })(...args);
    },
  });
  await tick();
  assert.deepEqual(ids(actor), [C, B, A], "every note is kept, newest first");
  assert.deepEqual(shownIds(actor), [A], "only the note about the subject shows");
  assert.ok(
    asked.some(([t, n]) => t === "subject" && n === "read"),
    "a following list asks the subject",
  );
});

test("with the attribute off, the subject is not asked and every note shows", async () => {
  const asked = [];
  const { actor } = list({
    following: false,
    ask: (...args) => {
      asked.push(args);
      return answeringList([{ id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] }])(...args);
    },
  });
  await tick();
  assert.deepEqual(asked, [["notes", "list", {}]], "only notes: list is asked");
  assert.deepEqual(shownIds(actor), [A], "links are ignored, every note shows");
});

test("following with no subject shows every note", async () => {
  const { actor } = list({
    following: true,
    ask: answering({ notes: [{ id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] }], subject: null }),
  });
  await tick();
  assert.deepEqual(shownIds(actor), [A]);
});

test("a note.changed for another subject is kept but not shown", async () => {
  const { actor } = list({
    following: true,
    ask: answering({ notes: [], subject: { kind: "book", id: "bk1", title: "Dune" } }),
  });
  await tick();
  actor.send({ type: "note.changed", id: B, title: "B", subtitle: "", body: "b", version: 1, pending: false, updatedAt: 30, about: [{ kind: "book", id: "bk2" }] });
  assert.deepEqual(ids(actor), [B], "kept in the full set");
  assert.deepEqual(shownIds(actor), [], "not shown under this subject");
  actor.send({ type: "note.changed", id: A, title: "A", subtitle: "", body: "a", version: 1, pending: false, updatedAt: 40, about: [{ kind: "book", id: "bk1" }] });
  assert.deepEqual(shownIds(actor), [A], "a note about the subject does show");
});

test("subject.changed switches which notes are shown", async () => {
  const { actor } = list({
    following: true,
    ask: answering({
      notes: [
        { id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] },
        { id: B, title: "B", updatedAt: 20, about: [{ kind: "book", id: "bk2" }] },
      ],
      subject: { kind: "book", id: "bk1", title: "One" },
    }),
  });
  await tick();
  assert.deepEqual(shownIds(actor), [A]);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bk2", title: "Two" } });
  assert.deepEqual(shownIds(actor), [B]);
  actor.send({ type: "subject.changed", subject: null });
  assert.deepEqual(shownIds(actor), [B, A], "no subject on the stage shows every note");
});

// --- keeps-open: the open note always has a row (12) --------------------------------

// bk1 is on the stage; A is about bk1, B is about bk2. The editor has B open.
const twoBooks = () =>
  answering({
    notes: [
      { id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] },
      { id: B, title: "B", updatedAt: 20, about: [{ kind: "book", id: "bk2" }] },
    ],
    subject: { kind: "book", id: "bk1", title: "One" },
  });

test("keeps-open: the open note not about the subject leads apart, the shown set unchanged", async () => {
  const { actor } = list({ following: true, keepsOpen: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  assert.equal(apartId(actor), B, "the open note is kept apart");
  assert.deepEqual(shownIds(actor), [A], "the shown set is still only the subject's notes");
});

test("keeps-open: the open note about the subject is not apart", async () => {
  const { actor } = list({ following: true, keepsOpen: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: A });
  assert.equal(apartId(actor), null, "an open note already in the shown set is not doubled");
});

test("with keeps-open off, nothing is apart", async () => {
  const { actor } = list({ following: true, keepsOpen: false, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  assert.equal(apartId(actor), null);
});

test("keeps-open: subject.changed to the open note's subject folds it back into the list", async () => {
  const { actor } = list({ following: true, keepsOpen: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  assert.equal(apartId(actor), B);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bk2", title: "Two" } });
  assert.equal(apartId(actor), null, "the open note is now about the subject");
  assert.deepEqual(shownIds(actor), [B], "so it is in the shown set");
});

test("keeps-open: deleting the open note leaves nothing apart", async () => {
  const { actor } = list({ following: true, keepsOpen: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  assert.equal(apartId(actor), B);
  actor.send({ type: "note.deleted", id: B });
  assert.equal(apartId(actor), null, "the row is gone, so nothing is apart");
});

// --- Highlights are hidden from the list (Decision 2) ------------------------------

// bk1 is on the stage; A is a plain note about it, H is a highlight of it (a placed
// link), B a plain note about another book.
const withHighlight = () =>
  answering({
    notes: [
      { id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] },
      { id: B, title: "B", updatedAt: 20, about: [{ kind: "book", id: "bk2" }] },
      {
        id: C,
        title: "Highlight",
        updatedAt: 30,
        about: [{ kind: "book", id: "bk1", place: { chapter: 0 }, quote: { exact: "x" } }],
      },
    ],
    subject: { kind: "book", id: "bk1", title: "One" },
  });

test("a highlight of the subject is kept but never shown in the list", async () => {
  const { actor } = list({ following: true, ask: withHighlight() });
  await tick();
  assert.deepEqual(ids(actor), [C, B, A], "every note is kept");
  assert.deepEqual(shownIds(actor), [A], "the highlight is hidden; the plain note shows");
});

test("a highlight note open in the editor is not kept apart either", async () => {
  const { actor } = list({ following: true, keepsOpen: true, ask: withHighlight() });
  await tick();
  actor.send({ type: "note.opened", id: C });
  assert.equal(apartId(actor), null, "a highlight is hidden even when it is the open note");
});

test("keeps-open: the apart row can be picked like any row", async () => {
  const { actor, selected } = list({ following: true, keepsOpen: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  actor.send({ type: "_pick", id: B });
  assert.deepEqual(selected, [B], "picking the apart row emits note.selected");
});

// --- The Highlights row (Decision 1, 4, 5, 6, 7) -----------------------------------

// A second highlight of bk1, newer than C in withHighlight (updatedAt 30), so a count of
// two carries the greater time.
const DHIGH = {
  type: "note.changed",
  id: MINTED,
  title: "Second highlight",
  body: "d",
  version: 1,
  pending: false,
  updatedAt: 50,
  about: [{ kind: "book", id: "bk1", place: { chapter: 1 }, quote: { exact: "y" } }],
};

test("highlights() counts the subject's highlights with the latest time", async () => {
  const { actor } = list({ following: true, showsHighlights: true, ask: withHighlight() });
  await tick();
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 }, "one highlight (note C), its time");
});

test("highlights() is null without the attribute, when not following, or with no subject", async () => {
  const off = list({ following: true, showsHighlights: false, ask: withHighlight() });
  await tick();
  assert.equal(hl(off.actor), null, "the attribute is off");

  const notFollowing = list({ following: false, showsHighlights: true, ask: withHighlight() });
  await tick();
  assert.equal(hl(notFollowing.actor), null, "not following the stage");

  const noSubject = list({
    following: true,
    showsHighlights: true,
    ask: answering({ notes: [], subject: null }),
  });
  await tick();
  assert.equal(hl(noSubject.actor), null, "no subject on the stage");
});

test("a highlight of another subject is not counted", async () => {
  const { actor } = list({ following: true, showsHighlights: true, ask: withHighlight() });
  await tick();
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 });
  // bk2 has only the plain note B (no place), so nothing is a highlight of it.
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bk2", title: "Two" } });
  assert.equal(hl(actor), null, "the highlight of bk1 is not counted under bk2");
});

test("note.changed raises the count and note.deleted lowers it, to null at zero", async () => {
  const { actor } = list({ following: true, showsHighlights: true, ask: withHighlight() });
  await tick();
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 });
  actor.send(DHIGH);
  assert.deepEqual(hl(actor), { count: 2, updatedAt: 50 }, "the second highlight raises the count and time");
  actor.send({ type: "note.deleted", id: MINTED });
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 }, "deleting one lowers it");
  actor.send({ type: "note.deleted", id: C });
  assert.equal(hl(actor), null, "no highlights left: the row is gone");
});

test("_pickHighlights emits highlights.selected with the subject and marks the row open", async () => {
  const { actor, highlighted } = list({ following: true, showsHighlights: true, ask: withHighlight() });
  await tick();
  actor.send({ type: "_pickHighlights" });
  assert.deepEqual(highlighted, [{ kind: "book", id: "bk1" }], "the gesture carries the subject");
  assert.equal(highlightsOpen(actor), true, "the Highlights row reads as the open one");
});

test("_pick and note.opened clear the Highlights row's open mark", async () => {
  const picked = list({ following: true, showsHighlights: true, ask: withHighlight() });
  await tick();
  picked.actor.send({ type: "_pickHighlights" });
  picked.actor.send({ type: "_pick", id: A });
  assert.equal(highlightsOpen(picked.actor), false, "picking a note clears it");

  const opened = list({ following: true, showsHighlights: true, ask: withHighlight() });
  await tick();
  opened.actor.send({ type: "_pickHighlights" });
  opened.actor.send({ type: "note.opened", id: A });
  assert.equal(highlightsOpen(opened.actor), false, "the editor announcing a note clears it");
});

test("_pickHighlights with no highlights emits nothing and does not mark the row", async () => {
  const { actor, highlighted } = list({
    following: true,
    showsHighlights: true,
    ask: answering({ notes: [{ id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] }], subject: { kind: "book", id: "bk1", title: "One" } }),
  });
  await tick();
  assert.equal(hl(actor), null, "no highlight, so no row");
  actor.send({ type: "_pickHighlights" });
  assert.deepEqual(highlighted, [], "the guard refused the stale pick");
  assert.equal(highlightsOpen(actor), false);
});

// --- The stage survives a reload: the subject race (3.5) ----------------------------

const SUBJECT_BK1 = { kind: "book", id: "bk1", title: "Dune" };

test("reload race: a slow notes reply does not clobber a subject.changed with the read's null", async () => {
  // subject: read replies null (the book is not open yet), the book comes back on its
  // own (subject.changed) while the notes list is still loading, then the slow notes
  // reply lands last. It must not re-apply the read's stale null over the book.
  let resolveList;
  const gate = new Promise((r) => (resolveList = r));
  const ask = (target, name) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: null });
    if (name === "list") return gate;
    return Promise.resolve({});
  };
  const { actor } = list({ following: true, ask });
  await tick();
  assert.equal(actor.getSnapshot().value, "loading", "the notes list is still loading");
  actor.send({ type: "subject.changed", subject: SUBJECT_BK1 });
  assert.deepEqual(actor.getSnapshot().context.subject, SUBJECT_BK1, "the change was taken");
  resolveList({ notes: [{ id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] }] });
  await tick();
  const s = actor.getSnapshot();
  assert.equal(s.value, "ready");
  assert.deepEqual(s.context.subject, SUBJECT_BK1, "the notes reply left the changed subject in place");
  assert.deepEqual(shownIds(actor), [A], "so the list scopes to the book on the stage, not every note");
});

test("with no later change, the subject read's reply is the starting picture and survives the notes reply", async () => {
  let resolveList;
  const gate = new Promise((r) => (resolveList = r));
  const ask = (target, name) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject: SUBJECT_BK1 });
    if (name === "list") return gate;
    return Promise.resolve({});
  };
  const { actor } = list({ following: true, ask });
  await tick();
  assert.deepEqual(actor.getSnapshot().context.subject, SUBJECT_BK1, "the read reply set the subject on its own");
  resolveList({ notes: [{ id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] }] });
  await tick();
  assert.deepEqual(actor.getSnapshot().context.subject, SUBJECT_BK1, "the split did not lose the starting picture");
  assert.deepEqual(shownIds(actor), [A]);
});
