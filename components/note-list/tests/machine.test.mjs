import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, shown, plain, showing, chaptered, deletable, typeLabelOf } from "../machine.js";

// A long stretch of simulated time, to show nothing waits on a clock.
const LATER = 10000;

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

function list({ ask, mint = minter(), following = false, tryPage = false } = {}) {
  const selected = [];
  const discarded = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { ask, mint, following, tryPage }, clock });
  actor.on("note.selected", (e) => selected.push(e.id));
  actor.on("note.discarded", (e) => discarded.push(e.id));
  actor.start();
  return { actor, selected, discarded, clock };
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

test("the starting picture is notes: list, sorted newest first", async () => {
  const asked = [];
  const { actor } = list({
    ask: (...args) => {
      // The Vim keys read (12) and who is signed in are their own concerns.
      if (args[0] !== "settings" && args[0] !== "session" && args[0] !== "flags") asked.push(args);
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

// --- Delete (12, Undo) -----------------------------------------------------------

test("a delete happens at once, once; its Undo is a step notes records", async () => {
  const { actor, discarded, clock } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "_discard", id: A });
  assert.deepEqual(discarded, [A]);
  clock.increment(LATER);
  assert.deepEqual(discarded, [A], "no timer follows it");
  actor.send({ type: "note.deleted", id: A });
  assert.deepEqual(ids(actor), [], "the row goes when notes says the note is gone");
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "_discard", id: C });
  assert.deepEqual(discarded, [A], "a note not in the list is not deleted");
});

test("note.deleted clears the open row", async () => {
  const { actor } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10 }]) });
  await tick();
  actor.send({ type: "note.opened", id: A });
  actor.send({ type: "note.deleted", id: A });
  assert.deepEqual(ids(actor), [], "the row is gone");
  assert.equal(actor.getSnapshot().context.open, null, "and no longer the open row");
});

test("an Undo's note.changed brings a deleted row back", async () => {
  const { actor } = list({ ask: answeringList([{ id: A, title: "A", updatedAt: 10, position: "a" }]) });
  await tick();
  actor.send({ type: "note.deleted", id: A });
  actor.send({ type: "note.changed", id: A, title: "A", body: "x", version: 3, pending: false, updatedAt: 10, position: "a" });
  assert.deepEqual(ids(actor), [A]);
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
      if (args[0] !== "settings" && args[0] !== "session" && args[0] !== "flags") asked.push(args);
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

test("the open note not about the subject is not listed: the list shows only the subject's notes", async () => {
  const { actor } = list({ following: true, ask: twoBooks() });
  await tick();
  actor.send({ type: "note.opened", id: B });
  assert.deepEqual(shownIds(actor), [A]);
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "bk2", title: "Two" } });
  assert.deepEqual(shownIds(actor), [B], "about the new subject, it is listed");
});

// --- Highlights are hidden from the list (13) ------------------------------------

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

test("signed out no row can be opened or deleted", async () => {
  const { actor, selected, discarded, clock } = list({ following: true, ask: withSession(SIGNED_OUT) });
  await tick();
  actor.send({ type: "_pick", id: A });
  actor.send({ type: "_discard", id: A });
  clock.increment(LATER);
  assert.deepEqual([selected, discarded], [[], []]);
});

test("signing in brings the notes back without a reload; signing out hides them and forgets the note dd deleted", async () => {
  const { actor, moved } = (() => {
    const out = list({ following: true, ask: withSession(SIGNED_OUT) });
    out.moved = [];
    out.actor.on("note.moved", (e) => out.moved.push(e.id));
    return out;
  })();
  await tick();
  assert.deepEqual(shownIds(actor), [A], "still kept while hidden");
  actor.send({ type: "session.changed", ...SIGNED_IN });
  assert.equal(showing(actor.getSnapshot().context), "show");
  actor.send({ type: "_dd", id: A });
  actor.send({ type: "note.deleted", id: A });
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(actor.getSnapshot().context), "sign-in");
  assert.equal(actor.getSnapshot().context.deleted, null);
  actor.send({ type: "session.changed", ...SIGNED_IN });
  actor.send({ type: "_paste", after: null, before: null });
  assert.deepEqual(moved, [], "p after signing out brings nothing back");
});

// --- Order and the Vim list keys (12) ---------------------------------------------

function keyed(notes) {
  const out = list({ ask: answeringList(notes) });
  out.moved = [];
  out.actor.on("note.moved", (e) => out.moved.push({ id: e.id, after: e.after, before: e.before }));
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

test("dd deletes the row at once and remembers it; p or P brings it back with note.moved", async () => {
  const { actor, moved, discarded } = keyed(placed);
  await tick();
  // Nothing deleted yet: p does nothing.
  actor.send({ type: "_paste", after: null, before: B });
  assert.deepEqual(moved, []);
  actor.send({ type: "_dd", id: A });
  assert.deepEqual(discarded, [A], "no countdown");
  actor.send({ type: "note.deleted", id: A });
  assert.equal(actor.getSnapshot().context.deleted, A);
  actor.send({ type: "_paste", after: C, before: null });
  assert.deepEqual(moved, [{ id: A, after: C, before: null }]);
  assert.equal(actor.getSnapshot().context.deleted, null);
  // Once brought back, a second p does nothing.
  actor.send({ type: "_paste", after: null, before: B });
  assert.equal(moved.length, 1);
});

test("a second dd replaces the note p brings back", async () => {
  const { actor, moved, discarded } = keyed(placed);
  await tick();
  actor.send({ type: "_dd", id: A });
  actor.send({ type: "note.deleted", id: A });
  actor.send({ type: "_dd", id: B });
  actor.send({ type: "note.deleted", id: B });
  assert.deepEqual(discarded, [A, B]);
  actor.send({ type: "_paste", after: null, before: C });
  assert.deepEqual(moved, [{ id: B, after: null, before: C }]);
});

test("the deleted note coming back another way (an Undo) is no longer one p brings back", async () => {
  const { actor, moved } = keyed(placed);
  await tick();
  actor.send({ type: "_dd", id: A });
  actor.send({ type: "note.deleted", id: A });
  actor.send({ type: "note.changed", id: A, title: "A", body: "A", version: 2, pending: false, updatedAt: 10, position: "a" });
  assert.equal(actor.getSnapshot().context.deleted, null);
  actor.send({ type: "_paste", after: C, before: null });
  assert.deepEqual(moved, []);
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

test("dd does nothing on the New note row", async () => {
  const { actor, discarded } = keyed(placed);
  await tick();
  actor.send({ type: "_dd", id: MINTED });
  assert.deepEqual(discarded, []);
  assert.equal(actor.getSnapshot().context.deleted, null);
});

// --- A note as the subject, and the Slip-Box (Slip-Box shown) -------------------------

const SLIPBOX = "00000000000000000000000SBX";
const PARENT = { kind: "note", id: A };
const DUNE = { kind: "book", id: "dune", chapter: "one", chapterTitle: "One" };

// A following list that answers flags: read with Slip-Box shown or hidden.
function tree({ notes, subject, hidden = [] }) {
  const ask = (target, name) => {
    if (target === "flags") return Promise.resolve({ hidden });
    return answering({ notes, subject })(target, name);
  };
  const out = list({ ask, following: true });
  out.moved = [];
  out.actor.on("note.moved", ({ type, ...e }) => out.moved.push(e));
  return out;
}

test("a note as the subject lists the notes under it, with no chapter switch", async () => {
  const { actor } = tree({
    subject: { kind: "note", id: A, title: "Parent", view: "book-stage" },
    notes: [
      { id: A, title: "Parent", updatedAt: 10, about: [] },
      { id: B, title: "Child", updatedAt: 20, about: [PARENT] },
      { id: C, title: "Beside Dune", updatedAt: 30, about: [DUNE] },
    ],
  });
  await tick();
  assert.deepEqual(shownIds(actor), [B]);
  assert.equal(chaptered(actor.getSnapshot().context), null);
});

test("a note with notes under it cannot be deleted, by the trash, a swipe or dd", async () => {
  const { actor, discarded } = tree({
    subject: null,
    notes: [
      { id: A, title: "Parent", updatedAt: 10, about: [] },
      { id: B, title: "Child", updatedAt: 20, about: [PARENT] },
    ],
  });
  await tick();
  assert.equal(deletable(actor.getSnapshot().context, A), false);
  actor.send({ type: "_discard", id: A });
  actor.send({ type: "_dd", id: A });
  assert.deepEqual(discarded, []);
  assert.equal(actor.getSnapshot().context.deleted, null);
  // Once the child is gone, the parent can be deleted.
  actor.send({ type: "note.deleted", id: B });
  assert.equal(deletable(actor.getSnapshot().context, A), true);
  actor.send({ type: "_dd", id: A });
  assert.deepEqual(discarded, [A]);
});

test("the Slip-Box note is never listed, from the list or a change", async () => {
  const { actor } = tree({
    subject: null,
    notes: [{ id: SLIPBOX, title: "How it is arranged", updatedAt: 10, about: [] }, { id: A, title: "A", updatedAt: 5, about: [] }],
  });
  await tick();
  assert.deepEqual(ids(actor), [A]);
  actor.send({ type: "note.changed", id: SLIPBOX, title: "Again", body: "Again", version: 2, pending: false, updatedAt: 40 });
  assert.deepEqual(ids(actor), [A]);
  assert.equal(deletable(actor.getSnapshot().context, SLIPBOX), false);
});

test("p in a list about another thing brings the note back under it; in its own list it keeps its links", async () => {
  const notes = [
    { id: A, title: "Parent", updatedAt: 10, about: [] },
    { id: B, title: "Beside Dune", updatedAt: 20, about: [DUNE] },
  ];
  const { actor, moved } = tree({ subject: { kind: "book", id: "dune", title: "Dune", view: "book-stage", ...{ chapter: "one", chapterTitle: "One" } }, notes });
  await tick();
  actor.send({ type: "_dd", id: B });
  actor.send({ type: "note.deleted", id: B });
  actor.send({ type: "_paste", after: null, before: null });
  assert.deepEqual(moved.at(-1), { id: B, after: null, before: null }, "the same book: no link");
  actor.send({ type: "note.changed", id: B, title: "Beside Dune", body: "x", version: 3, pending: false, updatedAt: 20, about: [DUNE] });
  actor.send({ type: "_dd", id: B });
  actor.send({ type: "note.deleted", id: B });
  actor.send({ type: "subject.changed", subject: { kind: "note", id: A, title: "Parent", view: "book-stage" } });
  actor.send({ type: "_paste", after: null, before: null });
  assert.deepEqual(moved.at(-1), { id: B, after: null, before: null, about: { kind: "note", id: A } });
});

test("with Slip-Box hidden p brings the note back with its links, as before", async () => {
  const { actor, moved } = tree({
    hidden: ["slip-box"],
    subject: { kind: "book", id: "emma", title: "Emma", view: "book-stage" },
    notes: [{ id: B, title: "Beside Dune", updatedAt: 20, about: [DUNE] }],
  });
  await tick();
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "dune", title: "Dune", view: "book-stage" } });
  actor.send({ type: "_dd", id: B });
  actor.send({ type: "note.deleted", id: B });
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "emma", title: "Emma", view: "book-stage" } });
  actor.send({ type: "_paste", after: null, before: null });
  assert.deepEqual(moved.at(-1), { id: B, after: null, before: null });
});

test("while Slip-Box shows a row names the note's type, fleeting without one; hidden, none, the type kept", async () => {
  const notes = [
    { id: A, title: "A", updatedAt: 10, about: [], noteType: "permanent" },
    { id: B, title: "B", updatedAt: 20, about: [] },
  ];
  const label = (actor, id) => typeLabelOf(actor.getSnapshot().context.hidden, shown(actor.getSnapshot().context).find((n) => n.id === id));
  const { actor } = tree({ subject: null, notes });
  await tick();
  assert.equal(label(actor, A), "Permanent");
  assert.equal(label(actor, B), "Fleeting");
  actor.send({ type: "note.changed", id: B, title: "B", body: "B", version: 2, pending: false, updatedAt: 30, noteType: "literature" });
  assert.equal(label(actor, B), "Literature");
  actor.send({ type: "flags.changed", off: [], hidden: ["slip-box"], released: [], shown: [] });
  assert.equal(label(actor, B), null);
  assert.equal(shown(actor.getSnapshot().context).find((n) => n.id === B).noteType, "literature");
});
