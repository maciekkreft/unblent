import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, shownOf, stopKey, boxEdge, JOURNAL, isEmpty } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = { "evaluator.saved": json("evaluator.saved"), "removal.started": json("removal.started") };
const recorded = [];

const BOOK = "01K6TEST000000000000000PA1";
const A = "01K6TEST000000000000000R01";
const B = "01K6TEST000000000000000R02";
const YOURS = "01K6TEST000000000000000Y01";
const Q1 = "01K6TEST000000000000000Q01";
const Q2 = "01K6TEST000000000000000Q02";
const O1 = "01K6TEST000000000000000E01";
const O2 = "01K6TEST000000000000000E02";

const opt = (id, name, description = "") => ({ id, name, description, removing: false });
const yesno = (id, text) => ({ id, kind: "yesno", text, yes: "", no: "", options: [], removing: false });
const EV_A = {
  id: A,
  book: BOOK,
  name: "Goal or value",
  on: true,
  position: "b",
  removing: false,
  questions: [{ id: Q1, kind: "pick", text: "Goal or value?", yes: "", no: "", options: [opt(O1, "Goal"), opt(O2, "Value")], removing: false }],
};
// Kept with the Journal and switched off: the tab shows it all the same, before A by place.
const EV_B = { id: B, book: JOURNAL, name: "Kind", on: false, position: "a", removing: false, questions: [yesno(Q2, "Is it kind?")] };
const EV_YOURS = { id: YOURS, book: JOURNAL, name: "Your values", on: true, removing: false, derivedFrom: "values", questions: [] };

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ evaluators = [EV_A, EV_B, EV_YOURS], session = { userId: "u1" }, vimKeys, folded } = {}) => {
  let n = 0;
  const clock = new SimulatedClock();
  const asked = [];
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target, name) => {
        asked.push(`${target}: ${name}`);
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        if (target === "session") return Promise.resolve(session);
        return Promise.resolve({ evaluators });
      },
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      throttleMs: 200,
      folded,
    },
  });
  const emitted = [];
  for (const name of Object.keys(SCHEMAS))
    actor.on(name, (e) => {
      emitted.push(e);
      recorded.push(e);
    });
  actor.start();
  await flush();
  return { actor, clock, emitted, asked, ctx: () => actor.getSnapshot().context };
};
const saves = (emitted) => emitted.filter((e) => e.type === "evaluator.saved");
const changed = (evaluator) => ({ type: "evaluator.changed", evaluator: { pending: false, version: 2, ...evaluator } });

// Every emit of the suite matches its schema.
after(() => {
  for (const { type, ...rest } of recorded) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, JSON.stringify({ type, ...rest }));
});

test("every evaluator of the account is shown, whichever book it is kept with and switched on or not, in the order set", async () => {
  const { asked, ctx } = await start();
  assert.ok(asked.includes("evaluators: list"));
  assert.deepEqual(shownOf(ctx()).map((d) => d.id), [B, A, YOURS]);
});

test("each evaluator folds and unfolds on its own; the folds come back from input, and a new one is open", async () => {
  const { actor, ctx } = await start({ folded: [B] });
  assert.deepEqual([...ctx().folded], [B], "kept folds come back");
  actor.send({ type: "_fold", id: A });
  assert.deepEqual([...ctx().folded].sort(), [A, B].sort());
  actor.send({ type: "_fold", id: B });
  assert.deepEqual([...ctx().folded], [A], "folding again unfolds");
  actor.send({ type: "_new" });
  const fresh = shownOf(ctx())[0];
  assert.equal(ctx().folded.has(fresh.id), false, "a new evaluator starts open");
});

test("signed out the tab knows it, so it shows only the sign-in line", async () => {
  const { ctx } = await start({ session: { userId: null } });
  assert.equal(ctx().signedIn, false);
});

test("typing in one evaluator and then another saves the first before the second", async () => {
  const { actor, clock, emitted } = await start();
  actor.send({ type: "_edit", evaluator: A, patch: { name: "Goal or not" } });
  actor.send({ type: "_editQuestion", evaluator: B, id: Q2, patch: { text: "Is it kind to you?" } });
  assert.deepEqual(saves(emitted).map((e) => [e.id, e.name]), [[A, "Goal or not"]], "moving on saves what was typed");
  clock.increment(200);
  assert.deepEqual(saves(emitted).at(-1).questions[0].text, "Is it kind to you?");
  assert.equal(saves(emitted).at(-1).book, JOURNAL, "a save keeps the evaluator's own book");
  assert.equal("on" in saves(emitted).at(-1), false, "the tab never sends the evaluator's switch");
});

test("a gesture on an evaluator while nothing waits saves nothing extra", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_expect", evaluator: A, question: Q1, expect: O1 });
  assert.deepEqual(saves(emitted).map((e) => [e.id, e.questions[0].expect]), [[A, O1]]);
  actor.send({ type: "_expect", evaluator: B, question: Q2, expect: "yes" });
  assert.deepEqual(saves(emitted).map((e) => e.id), [A, B], "A was clean, so only the press saves");
});

test("New evaluator is at the top, kept with the Journal, and saved only once something is written", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "_new" });
  const fresh = ctx().draft;
  assert.equal(fresh.book, JOURNAL);
  assert.ok(isEmpty(fresh));
  assert.equal(shownOf(ctx())[0].id, fresh.id);
  actor.send({ type: "_new" });
  assert.equal(ctx().draft.id, fresh.id, "pressed again while empty, it stays the one");
  assert.equal(ctx().news, 1);
  actor.send({ type: "_blur" });
  clock.increment(400);
  actor.send({ type: "_edit", evaluator: A, patch: { name: "A2" } });
  assert.equal(shownOf(ctx()).some((d) => d.id === fresh.id), false, "left empty, it goes");
  assert.equal(saves(emitted).some((e) => e.id === fresh.id), false);

  actor.send({ type: "_new" });
  const next = ctx().draft.id;
  actor.send({ type: "_edit", evaluator: next, patch: { name: "Fresh" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).filter((e) => e.id === next).map((e) => [e.book, e.name]), [[JOURNAL, "Fresh"]]);
});

test("a change from the fact while typing keeps what is typed; once saved it is taken as it is", async () => {
  const { actor, clock, ctx } = await start();
  actor.send({ type: "_edit", evaluator: A, patch: { name: "Typing" } });
  actor.send(changed({ ...EV_A, name: "From elsewhere" }));
  assert.equal(shownOf(ctx()).find((d) => d.id === A).name, "Typing");
  clock.increment(200);
  actor.send(changed({ ...EV_A, name: "From elsewhere" }));
  assert.equal(shownOf(ctx()).find((d) => d.id === A).name, "From elsewhere");
});

test("delete saves, starts the undo window and hides the evaluator; Undo brings it back", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "_delete", evaluator: A });
  assert.deepEqual(emitted.map((e) => e.type), ["evaluator.saved", "removal.started"]);
  assert.deepEqual(emitted[1], { type: "removal.started", kind: "evaluator", id: A, name: "Goal or value" });
  assert.equal(shownOf(ctx()).some((d) => d.id === A), false);
  actor.send(changed({ ...EV_A, removing: true }));
  assert.equal(shownOf(ctx()).some((d) => d.id === A), false);
  actor.send(changed({ ...EV_A, removing: false }));
  assert.equal(shownOf(ctx()).some((d) => d.id === A), true, "the way back");
  actor.send({ type: "evaluator.deleted", id: B, book: JOURNAL });
  assert.equal(shownOf(ctx()).some((d) => d.id === B), false);
});

test("removing a question or a cleared option waits out its undo window; a written option is not removed", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "_removeOption", evaluator: A, question: Q1, id: O1 });
  assert.equal(emitted.length, 0, "an option with words is kept");
  actor.send({ type: "_editOption", evaluator: A, question: Q1, id: O1, patch: { name: "" } });
  actor.send({ type: "_removeOption", evaluator: A, question: Q1, id: O1 });
  assert.deepEqual(emitted.map((e) => [e.type, e.kind]), [["evaluator.saved", undefined], ["removal.started", "option"]]);
  actor.send({ type: "_removeQuestion", evaluator: B, id: Q2 });
  assert.deepEqual(emitted.at(-1), { type: "removal.started", kind: "question", id: Q2, name: "" });
  assert.equal(ctx().draft.questions[0].removing, true);
});

test("adding a question, switching its kind and switching it off change only the draft until saved", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "_addQuestion", evaluator: B });
  const added = ctx().draft.questions[1].id;
  actor.send({ type: "_kind", evaluator: B, id: added, kind: "pick" });
  assert.equal(ctx().draft.questions[1].options.length, 2, "Pick one starts with two empty options");
  actor.send({ type: "_switchQuestion", evaluator: B, id: Q2, on: false });
  actor.send({ type: "_addOption", evaluator: B, question: added });
  clock.increment(200);
  const last = saves(emitted).at(-1);
  assert.deepEqual([last.id, last.questions[0].on, last.questions[1].options.length], [B, false, 3]);
});

test("Your values is read only: nothing of it is saved or removed from here", async () => {
  const { actor, clock, emitted } = await start();
  actor.send({ type: "_edit", evaluator: YOURS, patch: { name: "Mine" } });
  actor.send({ type: "_delete", evaluator: YOURS });
  clock.increment(400);
  assert.deepEqual(emitted, []);
});

test("the keys of the path: arrows always, Vim's letters only with Vim keys and never while typing", () => {
  const k = (key, more = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...more });
  const button = { tag: "BUTTON", type: "button" };
  const field = { tag: "INPUT", type: "text" };
  const radio = { tag: "INPUT", type: "radio" };
  const select = { tag: "SELECT", type: "select-one" };
  assert.equal(stopKey(k("ArrowDown"), { ...button, vim: false }), "down");
  assert.equal(stopKey(k("ArrowUp"), { ...field, vim: true }), "up", "an arrow leaves a one-line field");
  assert.equal(stopKey(k("j"), { ...button, vim: false }), null);
  assert.equal(stopKey(k("j"), { ...button, vim: true }), "down");
  assert.equal(stopKey(k("k"), { ...button, vim: true }), "up", "the way back");
  assert.equal(stopKey(k("j"), { ...field, vim: true }), null, "typed in a field");
  assert.equal(stopKey(k("g"), { ...button, vim: true }), "g");
  assert.equal(stopKey(k("g"), { ...button, vim: true, afterG: true }), "first");
  assert.equal(stopKey(k("G"), { ...button, vim: true }), "last");
  assert.equal(stopKey(k("l"), { ...radio, vim: true }), "next");
  assert.equal(stopKey(k("h"), { ...radio, vim: true }), "prev");
  assert.equal(stopKey(k("ArrowDown"), { ...radio, vim: false }), "down", "up and down are the path's, not the choice's");
  assert.equal(stopKey(k("ArrowLeft"), { ...radio, vim: false }), null, "the radios' own left and right");
  assert.equal(stopKey(k("ArrowRight"), { ...select, vim: false }), "next");
  assert.equal(stopKey(k("ArrowDown", { ctrlKey: true }), { ...button, vim: true }), null);

  const normal = { insertMode: false, visualMode: false, inputState: {} };
  assert.equal(boxEdge(k("j"), normal, 3, 3, true), "down");
  assert.equal(boxEdge(k("j"), normal, 2, 3, true), null);
  assert.equal(boxEdge(k("k"), normal, 1, 3, true), "up");
  assert.equal(boxEdge(k("j"), { ...normal, insertMode: true }, 3, 3, true), null, "typed in insert mode");
  assert.equal(boxEdge(k("j"), { ...normal, inputState: { operator: "d" } }, 3, 3, true), null, "dj stays Vim's");
  assert.equal(boxEdge(k("ArrowDown"), null, 1, 1, false), "down");
  assert.equal(boxEdge(k("ArrowUp"), null, 2, 2, false), null);
  assert.equal(boxEdge(k("j"), null, 1, 1, false), null);
});
