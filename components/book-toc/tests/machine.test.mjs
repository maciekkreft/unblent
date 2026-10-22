import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, markedChapter, chapterCounts, counts, choiceLabel, markedSummary, showing } from "../machine.js";

// The actor is where the contents' decisions live (3.2): which book it shows, and the
// chapter it marks. The mark is the chapter the user just chose (a jump the fact has
// not confirmed) or, once the fact moves, the saved position. It is driven here with a
// fake `ask` so the logic is checked without a browser; the paint is the view's, tested
// in page.test.mjs.

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await tick();
};

// A book the read reply and book.changed both carry whole (7.1, 4.3 third rule).
const book = (over = {}) => ({
  id: ID,
  title: "T",
  author: "A",
  toc: [{ title: "One", chapter: 0 }, { title: "Two", chapter: 1 }, { title: "Three", chapter: 2 }],
  position: { chapter: 0, block: 0 },
  version: 1,
  ...over,
});

const changed = (over = {}) => ({ type: "book.changed", ...book(over) });

function start({ read, open, list, results } = {}) {
  const asked = [];
  const ask = (target, name, payload) => {
    asked.push(target + ": " + name);
    if (name === "results") return results instanceof Error ? Promise.reject(results) : Promise.resolve(results ?? { error: "no-answerer" });
    if (name === "open") return Promise.resolve(open ?? { id: null });
    if (name === "read") return Promise.resolve(read ?? { book: book() });
    if (name === "list") return Promise.resolve(list ?? { error: "no-answerer" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask } });
  const selected = [];
  actor.on("chapter.selected", (e) => selected.push(e));
  actor.start();
  return { actor, selected, asked };
}

// Open a book and settle in showing, as book-shelf's selection does (4.3, fourth rule).
async function open(opts) {
  const h = start(opts);
  await flush();
  h.actor.send({ type: "book.opened", id: ID });
  await flush();
  return h;
}

const ctx = (actor) => actor.getSnapshot().context;

test("choosing a chapter marks it at once and announces it", async () => {
  const { actor, selected } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  assert.equal(ctx(actor).jump, 2, "the chosen chapter is marked before the fact confirms");
  assert.deepEqual(selected, [{ type: "chapter.selected", id: ID, chapter: 2 }]);
});

test("choosing the current chapter holds no jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 0 });
  await flush();
  assert.equal(ctx(actor).jump, null, "the already-current chapter has nothing to confirm");
});

test("an ack that does not move the chapter keeps the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  // An echo of an earlier turn: the position's chapter is still 0, so the mark must not
  // flick back off the chosen chapter.
  actor.send(changed({ position: { chapter: 0, block: 7 } }));
  await flush();
  assert.equal(ctx(actor).jump, 2, "the jump survives an unrelated book.changed");
});

test("the fact confirming the jump clears it", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  actor.send(changed({ position: { chapter: 2, block: 0 } }));
  await flush();
  assert.equal(ctx(actor).jump, null, "the fact reached the chosen chapter");
  assert.equal(ctx(actor).book.chapter, 2, "the mark now rides the saved position");
});

test("a move to another chapter clears the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  // Another device turned elsewhere before the jump landed: the newer move wins.
  actor.send(changed({ position: { chapter: 1, block: 0 } }));
  await flush();
  assert.equal(ctx(actor).jump, null);
  assert.equal(ctx(actor).book.chapter, 1);
});

test("switching books clears the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  actor.send({ type: "book.opened", id: null });
  await flush();
  assert.equal(ctx(actor).jump, null, "a switch drops the pending jump");
});

test("deletion clears the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  actor.send({ type: "book.deleted", id: ID });
  await flush();
  assert.equal(ctx(actor).jump, null);
});

// A publisher's contents rarely lists every piece, so the entry to mark is the one at
// or before the chapter being read, not only its exact match (A).
test("markedChapter marks the entry the chapter belongs to", () => {
  const toc = [
    { title: "Cover", chapter: 0 },
    { title: "Part", chapter: 3, children: [{ title: "One", chapter: 4 }, { title: "Two", chapter: 6 }] },
    { title: "End", chapter: 9 },
  ];
  assert.equal(markedChapter(toc, 4), 4, "an exact listed chapter marks itself");
  assert.equal(markedChapter(toc, 2), 0, "an unlisted piece marks the entry before it");
  assert.equal(markedChapter(toc, 5), 4, "a nested child wins over its parent");
  assert.equal(markedChapter(toc, 12), 9, "past the last entry the last entry stays lit");
  assert.equal(markedChapter(toc, 0), 0, "the first entry marks itself");
});

test("markedChapter marks nothing before the first entry", () => {
  assert.equal(markedChapter([{ title: "Intro", chapter: 2 }], 1), null);
  assert.equal(markedChapter([], 0), null, "an empty tree marks nothing");
});

// The "Vim keys" preference (12): asked of settings at start, followed after.
const VIM_INPUT = {};
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

// The journal's counts: choice points name their day, the written book's chapters name
// theirs, and the two are joined by date.
const DAY1 = "2026-10-11";
const DAY2 = "2026-10-13";
const CP1 = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const CP2 = "01ARZ3NDEKTSV4RRFFQ69G5FC2";
const CP3 = "01ARZ3NDEKTSV4RRFFQ69G5FC3";
const journal = (over = {}) =>
  book({
    written: true,
    chapters: [{ title: "Sunday 11 October", day: DAY1 }, { title: "Tuesday 13 October", day: DAY2 }],
    toc: [{ title: "Tuesday 13 October", chapter: 1 }, { title: "Sunday 11 October", chapter: 0 }],
    ...over,
  });
const cp = (id, day, over = {}) => ({ id, day, version: 1, removing: false, ...over });
const perChapter = (actor) => chapterCounts(ctx(actor).book, ctx(actor).choicePoints);

test("the journal's days count their choice points from the starting list", async () => {
  const { actor } = await open({ read: { book: journal() }, list: { choicePoints: [cp(CP1, DAY2), cp(CP2, DAY2), cp(CP3, DAY1)] } });
  assert.deepEqual(perChapter(actor), { 0: 1, 1: 2 });
  assert.equal(choiceLabel(1), "1 choice point");
  assert.equal(choiceLabel(2), "2 choice points");
});

test("any other book shows no counts", async () => {
  const { actor } = await open({ list: { choicePoints: [cp(CP1, DAY2)] } });
  assert.deepEqual(perChapter(actor), {});
});

test("an error reply leaves the journal's contents without counts", async () => {
  const { actor } = await open({ read: { book: journal() } });
  assert.ok(actor.getSnapshot().matches("showing"));
  assert.deepEqual(perChapter(actor), {});
});

test("a removing choice point is not counted, and counts again after an undo", async () => {
  const { actor } = await open({ read: { book: journal() }, list: { choicePoints: [cp(CP1, DAY2)] } });
  // The removing flag changes without a new version, so an equal version is taken.
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP1, DAY2, { removing: true }) });
  assert.deepEqual(perChapter(actor), {});
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP1, DAY2) });
  assert.deepEqual(perChapter(actor), { 1: 1 });
  actor.send({ type: "choice-point.deleted", id: CP1, day: DAY2 });
  assert.deepEqual(perChapter(actor), {});
});

test("a choice point older than the one held is ignored", async () => {
  const { actor } = await open({ read: { book: journal() }, list: { choicePoints: [cp(CP1, DAY2, { version: 3 })] } });
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP1, DAY2, { version: 2, removing: true }) });
  assert.deepEqual(perChapter(actor), { 1: 1 });
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP2, DAY1) });
  assert.deepEqual(perChapter(actor), { 0: 1, 1: 1 });
});

test("counts skips choice points being removed", () => {
  assert.deepEqual(counts({ a: { day: DAY1, removing: false }, b: { day: DAY1, removing: true } }), { [DAY1]: 1 });
});

// When yesterday's hour of writing runs out, books adds today's empty page as a new last
// chapter and moves the journal's position onto it; the journal's page keeps showing the
// day picked here, so the contents must keep marking it.
const DAY3 = "2026-10-14";
const grown = () =>
  changed(
    journal({
      chapters: [{ title: "Sunday 11 October", day: DAY1 }, { title: "Tuesday 13 October", day: DAY2 }, { title: "Wednesday 14 October", day: DAY3 }],
      toc: [{ title: "Wednesday 14 October", chapter: 2 }, { title: "Tuesday 13 October", chapter: 1 }, { title: "Sunday 11 October", chapter: 0 }],
      position: { chapter: 2, block: 0 },
      version: 2,
    }),
  );
const mark = (actor) => markedChapter(ctx(actor).book.toc, ctx(actor).jump ?? ctx(actor).book.chapter);

test("in the journal, the picked day stays marked when today's page is added", async () => {
  const { actor, selected } = await open({ read: { book: journal({ position: { chapter: 1, block: 0 } }) } });
  // Yesterday is still open, so it is the last chapter and already current.
  actor.send({ type: "_select", id: ID, chapter: 1 });
  assert.deepEqual(selected, [{ type: "chapter.selected", id: ID, chapter: 1 }]);
  actor.send(grown());
  assert.equal(ctx(actor).book.chapter, 2, "the saved position moved to today's page");
  assert.equal(mark(actor), 1, "yesterday, the day the page shows, stays marked");
});

test("in the journal, an earlier day picked stays marked as the journal grows", async () => {
  const { actor } = await open({ read: { book: journal({ position: { chapter: 1, block: 0 } }) } });
  actor.send({ type: "_select", id: ID, chapter: 0 });
  actor.send(grown());
  assert.equal(mark(actor), 0);
});

test("opening the journal again marks its last chapter, today's page", async () => {
  const { actor } = await open({ read: { book: journal({ position: { chapter: 1, block: 0 } }) } });
  actor.send({ type: "_select", id: ID, chapter: 1 });
  actor.send(grown());
  actor.send({ type: "book.opened", id: ID });
  await flush();
  assert.equal(ctx(actor).jump, null, "the pick ends, so the saved position, today's page, is marked");
});

test("in any other book a move of the position still ends a click on the current chapter", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 0 });
  actor.send(changed({ position: { chapter: 1, block: 0 } }));
  assert.equal(mark(actor), 1);
});

// --- Signed out (14) -------------------------------------------------------------------

const SIGNED_IN = { userId: "u1", registrationOpen: false, guest: false, name: "Ann" };
const SIGNED_OUT = { userId: null, registrationOpen: true, guest: false, name: null };

// The contents of an open book; session as given, or missing.
const contents = async (session, tryPage = false) => {
  const ask = (target, name) =>
    Promise.resolve(target === "session" ? (session ?? { error: "no-answerer" }) : name === "open" ? { id: ID } : name === "read" ? { book: book() } : { error: "no-answerer" });
  const actor = createActor(machine, { input: { ask, tryPage } });
  actor.start();
  await flush();
  return { actor, ctx: () => actor.getSnapshot().context };
};

test("signed out the contents ask to sign in; signed in, or with no session to ask, they show", async () => {
  assert.equal(showing({ tryPage: false, signedIn: null }), "wait", "nothing until session answers");
  assert.equal(showing((await contents(SIGNED_OUT)).ctx()), "sign-in");
  assert.equal(showing((await contents(SIGNED_IN)).ctx()), "show");
  assert.equal(showing((await contents()).ctx()), "show", "a page without session counts as signed in");
  assert.equal(showing((await contents(SIGNED_OUT, true)).ctx()), "show", "a try page shows its visitor the contents");
});

test("signing in shows the same book's contents again without a reload, and signing out hides them", async () => {
  const { actor, ctx } = await contents(SIGNED_OUT);
  assert.equal(ctx().book?.id, ID, "still kept while hidden");
  actor.send({ type: "session.changed", ...SIGNED_IN });
  assert.equal(showing(ctx()), "show");
  assert.equal(ctx().book.id, ID);
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(ctx()), "sign-in");
});

// --- The journal's summaries -------------------------------------------------------------

const SRC = "a".repeat(64);
const summary = (day, text, version = 1, generator = "journal-summary") => ({
  id: generator + ":" + day, generator, item: day, text, source: SRC, version,
});
const shownSummary = (actor) => markedSummary(ctx(actor).book, ctx(actor).summaries, mark(actor));

test("the marked journal day shows its summary, and picking another day shows that one", async () => {
  const { actor, asked } = await open({
    read: { book: journal({ position: { chapter: 1, block: 0 } }) },
    results: { results: [summary(DAY1, "A walk by the river."), summary(DAY2, "Planning the week.")] },
  });
  assert.ok(asked.includes("generators: results"));
  assert.equal(shownSummary(actor), "Planning the week.");
  actor.send({ type: "_select", id: ID, chapter: 0 });
  assert.equal(shownSummary(actor), "A walk by the river.");
});

test("a day without a summary shows none", async () => {
  const { actor } = await open({ read: { book: journal({ position: { chapter: 1, block: 0 } }) }, results: { results: [summary(DAY1, "A walk.")] } });
  assert.equal(shownSummary(actor), null, "the marked day has no result");
});

test("a new summary arrives through generation.changed; an older one is ignored, a chat title too", async () => {
  const { actor } = await open({ read: { book: journal({ position: { chapter: 1, block: 0 } }) }, results: { results: [] } });
  assert.equal(shownSummary(actor), null);
  actor.send({ type: "generation.changed", result: summary(DAY2, "First.", 2) });
  assert.equal(shownSummary(actor), "First.");
  actor.send({ type: "generation.changed", result: summary(DAY2, "Stale.", 1) });
  assert.equal(shownSummary(actor), "First.");
  actor.send({ type: "generation.changed", result: summary(DAY2, "Chat name", 3, "chat-title") });
  assert.equal(shownSummary(actor), "First.");
  actor.send({ type: "generation.changed", result: summary(DAY2, "Second.", 3) });
  assert.equal(shownSummary(actor), "Second.");
});

test("any other book asks for no summaries and shows none", async () => {
  const { actor, asked } = await open({ results: { results: [summary(DAY1, "A walk.")] } });
  assert.ok(!asked.includes("generators: results"));
  assert.equal(markedSummary(ctx(actor).book, { [DAY1]: { text: "A walk.", version: 1 } }, 0), null);
});

test("when generators cannot be asked the journal shows no summary and works as before", async () => {
  for (const results of [undefined, { error: "unknown-query" }, new Error("gone")]) {
    const { actor } = await open({ read: { book: journal({ position: { chapter: 1, block: 0 } }) }, results });
    assert.ok(actor.getSnapshot().matches("showing"));
    assert.equal(shownSummary(actor), null);
    actor.send({ type: "_select", id: ID, chapter: 0 });
    assert.equal(mark(actor), 0, "picking a day still works");
  }
});
