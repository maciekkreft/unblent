import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, shown, apart, source, highlights, plain, showing } from "../machine.js";

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

function list({ ask, mint = minter(), undoMs = UNDO_MS, following = false, highlightsOpen = false, tryPage = false } = {}) {
  const selected = [];
  const discarded = [];
  const highlighted = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { ask, mint, undoMs, following, highlightsOpen, tryPage }, clock });
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
      // The Vim keys read (12) and who is signed in are their own concerns.
      if (args[0] !== "settings" && args[0] !== "session") asked.push(args);
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
      if (args[0] !== "settings" && args[0] !== "session") asked.push(args);
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

// --- the open note always has a row (12) --------------------------------

// bk1 is on the stage; A is about bk1, B is about bk2. The editor has B open.
const twoBooks = () =>
  answering({
    notes: [
      { id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] },
      { id: B, title: "B", updatedAt: 20, about: [{ kind: "book", id: "bk2" }] },
    ],
    subject: { kind: "book", id: "bk1", title: "One" },
  });

test("the open note not about the subject leads apart, the shown set unchanged", async () => {
  const { actor } = list({ following: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  assert.equal(apartId(actor), B, "the open note is kept apart");
  assert.deepEqual(shownIds(actor), [A], "the shown set is still only the subject's notes");
});

test("the open note about the subject is not apart", async () => {
  const { actor } = list({ following: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: A });
  assert.equal(apartId(actor), null, "an open note already in the shown set is not doubled");
});

test("subject.changed to the open note's subject folds it back into the list", async () => {
  const { actor } = list({ following: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  assert.equal(apartId(actor), B);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bk2", title: "Two" } });
  assert.equal(apartId(actor), null, "the open note is now about the subject");
  assert.deepEqual(shownIds(actor), [B], "so it is in the shown set");
});

test("deleting the open note leaves nothing apart", async () => {
  const { actor } = list({ following: true, ask: twoBooks() });
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
  const { actor } = list({ following: true, ask: withHighlight() });
  await tick();
  actor.send({ type: "note.opened", id: C });
  assert.equal(apartId(actor), null, "a highlight is hidden even when it is the open note");
});

test("the apart row can be picked like any row", async () => {
  const { actor, selected } = list({ following: true, ask: twoBooks() });
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
  const { actor } = list({ following: true, ask: withHighlight() });
  await tick();
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 }, "one highlight (note C), its time");
});

test("there is no Highlights row while flags hides the feature, or before it answers", async () => {
  const { actor } = list({ following: true, ask: withHighlight() });
  await tick();
  actor.send({ type: "flags.changed", off: ["highlights"], hidden: ["highlights"] });
  assert.equal(hl(actor), null, "hidden");
  actor.send({ type: "flags.changed", off: ["highlights"], hidden: [] });
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 }, "the admin sees it");
  assert.equal(highlights({ ...actor.getSnapshot().context, hidden: null }), null, "no answer yet");
});

test("highlights() is null when not following, or with no subject", async () => {
  const notFollowing = list({ following: false, ask: withHighlight() });
  await tick();
  assert.equal(hl(notFollowing.actor), null, "not following the stage");

  const noSubject = list({
    following: true,
    ask: answering({ notes: [], subject: null }),
  });
  await tick();
  assert.equal(hl(noSubject.actor), null, "no subject on the stage");
});

test("a highlight of another subject is not counted", async () => {
  const { actor } = list({ following: true, ask: withHighlight() });
  await tick();
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 });
  // bk2 has only the plain note B (no place), so nothing is a highlight of it.
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bk2", title: "Two" } });
  assert.equal(hl(actor), null, "the highlight of bk1 is not counted under bk2");
});

test("note.changed raises the count and note.deleted lowers it, to null at zero", async () => {
  const { actor } = list({ following: true, ask: withHighlight() });
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
  const { actor, highlighted } = list({ following: true, ask: withHighlight() });
  await tick();
  actor.send({ type: "_pickHighlights" });
  assert.deepEqual(highlighted, [{ kind: "book", id: "bk1" }], "the gesture carries the subject");
  assert.equal(highlightsOpen(actor), true, "the Highlights row reads as the open one");
});

test("_pick and note.selected clear the Highlights row's open mark; the editor's note.opened does not", async () => {
  const picked = list({ following: true, ask: withHighlight() });
  await tick();
  picked.actor.send({ type: "_pickHighlights" });
  picked.actor.send({ type: "_pick", id: A });
  assert.equal(highlightsOpen(picked.actor), false, "picking a note clears it");

  const opened = list({ following: true, ask: withHighlight() });
  await tick();
  opened.actor.send({ type: "_pickHighlights" });
  opened.actor.send({ type: "note.opened", id: A });
  assert.equal(highlightsOpen(opened.actor), true, "the editor announcing the note it holds leaves it");
  assert.equal(opened.actor.getSnapshot().context.open, A, "while that note is the open note");
  opened.actor.send({ type: "note.selected", id: B });
  assert.equal(highlightsOpen(opened.actor), false, "a note put in the panel from anywhere clears it");

  const empty = list({ following: true, ask: withHighlight() });
  await tick();
  empty.actor.send({ type: "note.opened", id: A });
  empty.actor.send({ type: "_pickHighlights" });
  empty.actor.send({ type: "note.opened", id: null });
  assert.equal(highlightsOpen(empty.actor), true, "the empty page is not a note opened (12)");
  assert.equal(empty.actor.getSnapshot().context.open, null, "and no row reads as the open note");
});

test("_pickHighlights with no highlights emits nothing and does not mark the row", async () => {
  const { actor, highlighted } = list({
    following: true,
    ask: answering({ notes: [{ id: A, title: "A", updatedAt: 10, about: [{ kind: "book", id: "bk1" }] }], subject: { kind: "book", id: "bk1", title: "One" } }),
  });
  await tick();
  assert.equal(hl(actor), null, "no highlight, so no row");
  actor.send({ type: "_pickHighlights" });
  assert.deepEqual(highlighted, [], "the guard refused the stale pick");
  assert.equal(highlightsOpen(actor), false);
});

test("the Highlights row's open mark comes back from input after a reload", async () => {
  const { actor } = list({ following: true, ask: withHighlight(), highlightsOpen: true });
  await tick();
  actor.send({ type: "note.opened", id: A });
  assert.equal(highlightsOpen(actor), true);
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

// The "Vim keys" preference (12): asked of settings at start, followed after.
const VIM_INPUT = { mint: () => "01ARZ3NDEKTSV4RRFFQ69G5FZZ", undoMs: 100, following: false };
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

test("a source link shows as its label alone, unescaped", () => {
  const link = (label) => `[${label}](note:${A})`;
  assert.equal(plain(`See ${link("the first words…")} here`), "See the first words… here");
  assert.equal(plain(link("a \\[b\\] c\\\\d")), "a [b] c\\d");
  assert.equal(plain(`${link("one")} and ${link("two")}`), "one and two");
  assert.equal(plain("[not a link](https://x.y) and [x](note:short)"), "[not a link](https://x.y) and [x](note:short)");
  assert.equal(plain(undefined), undefined);
});

test("the rows from notes: list and note.changed show link labels", async () => {
  const notes = [{ id: A, title: `Title [t](note:${B})`, subtitle: `[q\\]r](note:${B}) more`, updatedAt: 1 }];
  const { actor } = list({ ask: answeringList(notes) });
  await tick();
  assert.equal(actor.getSnapshot().context.notes[0].title, "Title t");
  assert.equal(actor.getSnapshot().context.notes[0].subtitle, "q]r more");
  actor.send({ type: "note.changed", id: C, title: "x", subtitle: `[z](note:${A})`, updatedAt: 2, about: [] });
  assert.equal(actor.getSnapshot().context.notes.find((n) => n.id === C).subtitle, "z");
});

// --- Signed out (14) -------------------------------------------------------------------

const SIGNED_IN = { userId: "u1", registrationOpen: false, guest: false, name: "Ann" };
const SIGNED_OUT = { userId: null, registrationOpen: true, guest: false, name: null };

// A list of two notes about bk1 and a highlight of it; session as given, or missing.
const withSession = (session) => (target, name) => {
  if (target === "session") return Promise.resolve(session ?? { error: "no-answerer" });
  return withHighlight()(target, name);
};

test("signed out the list asks to sign in; signed in, or with no session to ask, it shows", async () => {
  assert.equal(showing({ tryPage: false, signedIn: null }), "wait", "nothing until session answers");
  const out = list({ following: true, ask: withSession(SIGNED_OUT) });
  await tick();
  assert.equal(showing(out.actor.getSnapshot().context), "sign-in");
  const inside = list({ following: true, ask: withSession(SIGNED_IN) });
  await tick();
  assert.equal(showing(inside.actor.getSnapshot().context), "show");
  const none = list({ following: true, ask: withSession() });
  await tick();
  assert.equal(showing(none.actor.getSnapshot().context), "show", "a page without session counts as signed in");
});

test("on a try page a visitor not yet signed in sees the list", async () => {
  const { actor } = list({ following: true, tryPage: true, ask: withSession(SIGNED_OUT) });
  await tick();
  assert.equal(showing(actor.getSnapshot().context), "show");
});

test("signed out no row can be opened, deleted or the Highlights picked", async () => {
  const { actor, selected, highlighted, discarded, clock } = list({ following: true, ask: withSession(SIGNED_OUT) });
  await tick();
  actor.send({ type: "_pick", id: A });
  actor.send({ type: "_pickHighlights" });
  actor.send({ type: "_discard", id: A });
  clock.increment(UNDO_MS * 2);
  assert.deepEqual([selected, highlighted, discarded], [[], [], []]);
});

test("signing in brings the notes back without a reload; signing out hides them and takes back a delete", async () => {
  const { actor, discarded, clock } = list({ following: true, ask: withSession(SIGNED_OUT) });
  await tick();
  assert.deepEqual(shownIds(actor), [A], "still kept while hidden");
  actor.send({ type: "session.changed", ...SIGNED_IN });
  assert.equal(showing(actor.getSnapshot().context), "show");
  assert.deepEqual(hl(actor), { count: 1, updatedAt: 30 });
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(actor.getSnapshot().context), "sign-in");
  clock.increment(UNDO_MS * 2);
  assert.deepEqual(discarded, [], "the delete the user can no longer see is taken back");
  assert.equal(discardingHas(actor, A), false);
  assert.deepEqual(ids(actor).includes(A), true);
});

// --- Order and the Vim list keys (12) ---------------------------------------------

function keyed(notes) {
  const out = list({ ask: answeringList(notes) });
  out.moved = [];
  out.started = [];
  out.actor.on("note.moved", (e) => out.moved.push({ id: e.id, after: e.after, before: e.before }));
  out.actor.on("removal.started", (e) => out.started.push({ kind: e.kind, id: e.id, name: e.name }));
  return out;
}
const placed = [
  { id: A, title: "A", updatedAt: 10, position: "a" },
  { id: B, title: "B", updatedAt: 30, position: "b" },
  { id: C, title: "C", updatedAt: 20, position: "c" },
];

test("rows follow the place notes gives each note, and an edit does not move one", async () => {
  const { actor } = keyed(placed);
  await tick();
  assert.deepEqual(ids(actor), [A, B, C]);
  actor.send({ type: "note.changed", id: C, title: "C2", body: "c", version: 2, pending: false, updatedAt: 99, position: "c" });
  assert.deepEqual(ids(actor), [A, B, C]);
});

test("dd cuts a row with no countdown; p or P places it and emits note.moved", async () => {
  const { actor, moved, discarded, clock } = keyed(placed);
  await tick();
  actor.send({ type: "_cut", id: A });
  assert.equal(actor.getSnapshot().context.cut, A);
  clock.increment(UNDO_MS * 5);
  assert.deepEqual(discarded, [], "a cut has no clock");
  actor.send({ type: "_paste", after: C, before: null });
  assert.deepEqual(moved, [{ id: A, after: C, before: null }]);
  assert.equal(actor.getSnapshot().context.cut, null);
  // Nothing cut: p does nothing.
  actor.send({ type: "_paste", after: null, before: B });
  assert.equal(moved.length, 1);
});

test("u on the cut row puts it back; a second dd deletes the first cut with its countdown", async () => {
  const { actor, moved, discarded, clock } = keyed(placed);
  await tick();
  actor.send({ type: "_cut", id: A });
  actor.send({ type: "_uncut" });
  assert.equal(actor.getSnapshot().context.cut, null);
  actor.send({ type: "_cut", id: A });
  actor.send({ type: "_cut", id: B });
  assert.equal(actor.getSnapshot().context.cut, B);
  assert.ok(actor.getSnapshot().context.discarding.has(A));
  clock.increment(UNDO_MS);
  assert.deepEqual(discarded, [A]);
  assert.deepEqual(moved, []);
});

test("Escape on a cut turns it into the ordinary delete, which u (an undo) takes back", async () => {
  const { actor, discarded, clock } = keyed(placed);
  await tick();
  actor.send({ type: "_cut", id: B });
  actor.send({ type: "_escape" });
  assert.equal(actor.getSnapshot().context.cut, null);
  assert.ok(actor.getSnapshot().context.discarding.has(B));
  actor.send({ type: "_undo", id: B });
  clock.increment(UNDO_MS);
  assert.deepEqual(discarded, []);
});

test("leaving the list hands a cut or counting-down row to the corner notice, hidden until it ends", async () => {
  const { actor, started, discarded, clock } = keyed(placed);
  await tick();
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "_cut", id: B });
  actor.send({ type: "_left" });
  assert.deepEqual(started, [
    { kind: "note", id: A, name: "A" },
    { kind: "note", id: B, name: "B" },
  ]);
  clock.increment(UNDO_MS * 2);
  assert.deepEqual(discarded, [], "the notice settles it now, not the row's timer");
  assert.deepEqual(shownIds(actor), [C]);
  // Undo in the notice brings the row back; the notice's settle deletes the other in notes.
  actor.send({ type: "removal.undone", kind: "note", id: A });
  assert.deepEqual(shownIds(actor), [A, C]);
  actor.send({ type: "note.deleted", id: B });
  assert.deepEqual(ids(actor), [A, C]);
  assert.equal(actor.getSnapshot().context.handed.size, 0);
});

test("opening a row while one is cut hands the cut to the corner notice", async () => {
  const { actor, started, selected } = keyed(placed);
  await tick();
  actor.send({ type: "_cut", id: A });
  actor.send({ type: "_pick", id: C });
  assert.deepEqual(started.map((s) => s.id), [A]);
  assert.deepEqual(selected, [C]);
});

test("o opens a new note and moves it to its place once the user writes in it", async () => {
  const { actor, moved, selected } = keyed(placed);
  await tick();
  actor.send({ type: "_place", after: A, before: B });
  assert.deepEqual(selected, [MINTED]);
  // The editor's first save: the new note sorts first, then is moved to where o was.
  actor.send({ type: "note.changed", id: MINTED, title: "N", body: "N", version: 1, pending: false, updatedAt: 50, position: "0V" });
  assert.deepEqual(moved, [{ id: MINTED, after: A, before: B }]);
  actor.send({ type: "note.changed", id: MINTED, title: "N2", body: "N2", version: 1, pending: false, updatedAt: 51, position: "0V" });
  assert.equal(moved.length, 1, "only once");
});

test("dd does nothing on a row that is not a note (New note, Highlights)", async () => {
  const { actor } = keyed(placed);
  await tick();
  actor.send({ type: "_cut", id: MINTED });
  actor.send({ type: "_cut", id: "highlights" });
  assert.equal(actor.getSnapshot().context.cut, null);
});

// --- Where the row listed apart is from (12) --------------------------------------

test("the row listed apart is tagged with its first book, Not linked, or Pinned", () => {
  const row = (about) => ({ id: "x", about });
  const books = { [A]: "Journal", [B]: "ACT made simple" };
  assert.equal(source(row([{ kind: "book", id: B }, { kind: "book", id: A }]), books), "From ACT made simple", "the first book");
  assert.equal(source(row([]), books), "Not linked", "no link");
  assert.equal(source(row(undefined), books), "Not linked", "no links at all");
  assert.equal(source(row([{ kind: "book", id: A }]), null), "Pinned", "titles not read");
  assert.equal(source(row([{ kind: "book", id: C }]), books), "Pinned", "a book not among them");
});

test("the book titles come from books: list and follow a rename and a delete", async () => {
  const asked = [];
  const ask = (target, name) => {
    asked.push(`${target}: ${name}`);
    if (target === "books" && name === "list") return Promise.resolve({ books: [{ id: A, title: "Journal" }] });
    if (name === "list") return Promise.resolve({ notes: [] });
    return Promise.resolve({});
  };
  const { actor } = list({ ask, following: true });
  await tick();
  assert.ok(asked.includes("books: list"));
  const tag = () => source({ about: [{ kind: "book", id: A }] }, actor.getSnapshot().context.books);
  assert.equal(tag(), "From Journal");
  actor.send({ type: "book.changed", id: A, title: "My journal" });
  assert.equal(tag(), "From My journal", "a rename shows at once");
  actor.send({ type: "book.deleted", id: A });
  assert.equal(tag(), "Pinned", "a book gone");
});

test("without an answer from books the titles stay unread and events do not fill them", async () => {
  const ask = (target, name) =>
    Promise.resolve(target === "books" ? { error: "no-answerer" } : name === "list" ? { notes: [] } : {});
  const { actor } = list({ ask, following: true });
  await tick();
  actor.send({ type: "book.changed", id: A, title: "Journal" });
  assert.equal(actor.getSnapshot().context.books, null);
});
