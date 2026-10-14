import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, isEmpty, duplicateNames } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = { "evaluator.saved": json("evaluator.saved"), "removal.started": json("removal.started") };
const recorded = [];

const P = "01K6TEST000000000000000PA1";
const R = "01K6TEST000000000000000R01";
const R2 = "01K6TEST000000000000000R02";
const NEW = "01K6TEST000000000000000N01";
const Q1 = "01K6TEST000000000000000Q01";
const Q2 = "01K6TEST000000000000000Q02";
const O1 = "01K6TEST000000000000000E01";
const O2 = "01K6TEST000000000000000E02";

const opt = (id, name, description = "", removing = false) => ({ id, name, description, removing });
const EVALUATOR = {
  id: R,
  book: P,
  name: "Goal or value",
  on: true,
  removing: false,
  questions: [
    { id: Q1, kind: "pick", text: "Goal or value?", yes: "", no: "", options: [opt(O1, "Goal"), opt(O2, "Value")], removing: false },
    { id: Q2, kind: "yesno", text: "Is it a goal?", yes: "finished", no: "never", options: [], removing: false },
  ],
};
const OTHER = { ...EVALUATOR, id: R2, name: "Other evaluator", questions: [] };

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async (evaluators = [EVALUATOR, OTHER], vimKeys) => {
  let n = 0;
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target, name, payload) =>
        Promise.resolve(
          target === "settings" ? (vimKeys == null ? { error: "no-answerer" } : { vimKeys }) : { evaluators: payload.book === P ? evaluators : [] },
        ),
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      throttleMs: 200,
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
  return { actor, clock, emitted, ctx: () => actor.getSnapshot().context };
};
// A pick, and the fetch of its book's evaluators when it is not the book held.
const select = async (actor, pick) => {
  actor.send({ type: "evaluator.selected", ...pick });
  await flush();
};
const changed = (evaluator) => ({ type: "evaluator.changed", evaluator: { pending: false, version: 1, ...evaluator } });
const saves = (emitted) => emitted.filter((e) => e.type === "evaluator.saved");

// Every emit of the suite matches its schema.
after(() => {
  for (const { type, ...rest } of recorded) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, JSON.stringify({ type, ...rest }));
});

test("a new evaluator with nothing written is never saved, and its first word is", async () => {
  const { actor, clock, emitted, ctx } = await start();
  await select(actor, { id: NEW, book: P });
  assert.ok(actor.getSnapshot().matches({ ready: "editing" }));
  assert.equal(ctx().draft.book, P);
  assert.equal(ctx().draft.questions.length, 1);
  assert.ok(isEmpty(ctx().draft));
  actor.send({ type: "_kind", id: ctx().draft.questions[0].id, kind: "pick" });
  actor.send({ type: "_blur" });
  actor.send({ type: "_addQuestion" });
  clock.increment(200);
  await select(actor, { id: R, book: P });
  assert.deepEqual(emitted, []);

  await select(actor, { id: NEW, book: P });
  actor.send({ type: "_edit", patch: { name: "Fresh" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).filter((e) => e.id === NEW).map((e) => [e.book, e.name]), [[P, "Fresh"]]);
});

test("a stored evaluator cleared of every word is still saved", async () => {
  const { actor, clock, emitted } = await start([{ ...EVALUATOR, name: "x", questions: [] }]);
  await select(actor, { id: R, book: P });
  actor.send({ type: "_edit", patch: { name: "" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).map((e) => e.name), [""]);
});

test("every edit leaves as the whole evaluator, without on/off or flags, at the throttle or at blur", async () => {
  const { actor, clock, emitted } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_editOption", question: Q1, id: O1, patch: { description: "Done once" } });
  actor.send({ type: "_editQuestion", id: Q2, patch: { yes: "it ends" } });
  clock.increment(199);
  assert.equal(emitted.length, 0);
  clock.increment(1);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    type: "evaluator.saved",
    id: R,
    book: P,
    name: "Goal or value",
    questions: [
      { id: Q1, kind: "pick", text: "Goal or value?", yes: "", no: "", options: [{ id: O1, name: "Goal", description: "Done once" }, { id: O2, name: "Value", description: "" }] },
      { id: Q2, kind: "yesno", text: "Is it a goal?", yes: "it ends", no: "never", options: [] },
    ],
  });
  actor.send({ type: "_edit", patch: { name: "GV" } });
  actor.send({ type: "_blur" });
  assert.equal(saves(emitted).at(-1).name, "GV");
  clock.increment(400);
  assert.equal(emitted.length, 2);
});

test("switching kind keeps the yes / no wording and the options both ways", async () => {
  const { actor, clock, emitted, ctx } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_kind", id: Q2, kind: "pick" });
  actor.send({ type: "_kind", id: Q1, kind: "yesno" });
  clock.increment(200);
  const [q1, q2] = saves(emitted).at(-1).questions;
  assert.equal(q1.kind, "yesno");
  assert.deepEqual(q1.options.map((o) => o.name), ["Goal", "Value"]);
  assert.equal(q2.kind, "pick");
  assert.deepEqual([q2.yes, q2.no], ["finished", "never"]);
  actor.send({ type: "_kind", id: Q1, kind: "pick" });
  actor.send({ type: "_kind", id: Q2, kind: "yesno" });
  assert.deepEqual(ctx().draft.questions[0].options.map((o) => o.name), ["Goal", "Value"]);
  assert.deepEqual([ctx().draft.questions[1].yes, ctx().draft.questions[1].no], ["finished", "never"]);
});

test("Pick one with no options starts with two empty ones; Add an option adds one more", async () => {
  const { actor, ctx } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_kind", id: Q2, kind: "pick" });
  const options = () => ctx().draft.questions[1].options;
  assert.deepEqual(options().map((o) => [o.name, o.description]), [["", ""], ["", ""]]);
  actor.send({ type: "_kind", id: Q2, kind: "yesno" });
  actor.send({ type: "_kind", id: Q2, kind: "pick" });
  assert.equal(options().length, 2);
  actor.send({ type: "_addOption", question: Q2 });
  assert.equal(options().length, 3);
});

test("two options of one question named alike are noticed", () => {
  const q = (names) => ({ options: names.map((n, i) => opt(`${i}`, n)) });
  assert.equal(duplicateNames(q(["Goal", "Value"])), false);
  assert.equal(duplicateNames(q(["Goal", " goal "])), true);
  assert.equal(duplicateNames(q(["", ""])), false);
  assert.equal(duplicateNames({ options: [opt("a", "Goal"), opt("b", "Goal", "", true)] }), false);
});

test("removing an option, a question or the evaluator saves first, then emits removal.started and hides it", async () => {
  const { actor, emitted, ctx } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_editOption", question: Q1, id: O2, patch: { name: "Value " } });
  actor.send({ type: "_removeOption", question: Q1, id: O2 });
  assert.deepEqual(emitted.map((e) => e.type), ["evaluator.saved", "removal.started"]);
  assert.equal(emitted[0].questions[0].options[1].name, "Value ");
  assert.deepEqual(emitted[1], { type: "removal.started", kind: "option", id: O2, name: "Value" });
  assert.equal(ctx().draft.questions[0].options[1].removing, true);

  actor.send({ type: "_removeQuestion", id: Q2 });
  assert.deepEqual(emitted.at(-1), { type: "removal.started", kind: "question", id: Q2, name: "" });
  // The save before it leaves out what is already flagged; `evaluators` keeps that in place.
  assert.deepEqual(saves(emitted).at(-1).questions[0].options.map((o) => o.id), [O1]);

  actor.send({ type: "_delete" });
  assert.deepEqual(emitted.at(-1), { type: "removal.started", kind: "evaluator", id: R, name: "Goal or value" });
  assert.equal(ctx().draft.removing, true);
  actor.send({ type: "_delete" });
  assert.equal(emitted.filter((e) => e.kind === "evaluator").length, 1);
});

test("Undo from the fact brings an item back; a settled removal drops it, even while typing", async () => {
  const { actor, ctx } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_removeOption", question: Q1, id: O2 });
  const flagged = { ...EVALUATOR, questions: [{ ...EVALUATOR.questions[0], options: [opt(O1, "Goal"), opt(O2, "Value", "", true)] }, EVALUATOR.questions[1]] };
  actor.send(changed(flagged));
  actor.send({ type: "_editQuestion", id: Q2, patch: { text: "Typing" } });
  actor.send(changed(EVALUATOR));
  assert.equal(ctx().draft.questions[0].options[1].removing, false);
  assert.equal(ctx().draft.questions[1].text, "Typing");

  actor.send({ type: "_removeOption", question: Q1, id: O2 });
  actor.send({ type: "_editQuestion", id: Q2, patch: { text: "Typing more" } });
  const gone = { ...EVALUATOR, questions: [{ ...EVALUATOR.questions[0], options: [opt(O1, "Goal")] }, EVALUATOR.questions[1]] };
  actor.send(changed(gone));
  assert.deepEqual(ctx().draft.questions[0].options.map((o) => o.id), [O1]);
  assert.equal(ctx().draft.questions[1].text, "Typing more");
});

test("a deleted evaluator says so, Undo brings it back, and a settled delete keeps saying so", async () => {
  const { actor, ctx } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_delete" });
  actor.send(changed({ ...EVALUATOR, removing: true }));
  assert.equal(ctx().draft.removing, true);
  actor.send(changed(EVALUATOR));
  assert.equal(ctx().draft.removing, false);
  actor.send({ type: "_delete" });
  actor.send({ type: "evaluator.deleted", id: R, book: P });
  assert.equal(ctx().draft.removing, true);
});

test("in an evaluator never saved, a removal just drops the item and emits nothing", async () => {
  const { actor, emitted, ctx } = await start();
  await select(actor, { id: NEW, book: P });
  actor.send({ type: "_addQuestion" });
  actor.send({ type: "_removeQuestion", id: ctx().draft.questions[1].id });
  actor.send({ type: "_delete" });
  assert.equal(ctx().draft.questions.length, 1);
  assert.equal(ctx().draft.removing, false);
  assert.deepEqual(emitted, []);
});

test("moving to another evaluator saves the one being left at once", async () => {
  const { actor, clock, emitted, ctx } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_edit", patch: { name: "Half typed" } });
  await select(actor, { id: R2, book: P });
  assert.deepEqual(saves(emitted).map((e) => [e.id, e.name]), [[R, "Half typed"]]);
  assert.equal(ctx().draft.id, R2);
  clock.increment(400);
  assert.equal(emitted.length, 1);
});

test("a pick before the starting picture opens once it lands; a change elsewhere reaches a clean draft only", async () => {
  let resolve;
  const actor = createActor(machine, {
    input: {
      ask: () => new Promise((r) => (resolve = r)),
      mint: () => NEW,
    },
  });
  actor.start();
  await select(actor, { id: R, book: P });
  resolve({ evaluators: [EVALUATOR] });
  await flush();
  assert.equal(actor.getSnapshot().context.draft.name, "Goal or value");
  actor.send(changed({ ...EVALUATOR, name: "Renamed elsewhere" }));
  assert.equal(actor.getSnapshot().context.draft.name, "Renamed elsewhere");
  actor.send({ type: "_edit", patch: { name: "Mine" } });
  actor.send(changed({ ...EVALUATOR, name: "Elsewhere again" }));
  assert.equal(actor.getSnapshot().context.draft.name, "Mine");
  actor.stop();
});

test("the evaluator open before a reload opens again while it exists, and a pick is remembered", async () => {
  const kept = [];
  const boot = async (open) => {
    const actor = createActor(machine, {
      input: {
        ask: () => Promise.resolve({ evaluators: [EVALUATOR] }),
        mint: () => NEW,
        open,
        remember: (id) => kept.push(id),
      },
    });
    actor.start();
    await flush();
    return actor;
  };
  const again = await boot({ id: R, book: P });
  assert.equal(again.getSnapshot().context.draft.id, R);
  again.send({ type: "evaluator.selected", id: NEW, book: P });
  assert.deepEqual(kept, [{ id: NEW, book: P }]);
  const gone = await boot({ id: R2, book: P });
  assert.ok(gone.getSnapshot().matches({ ready: "choosing" }));
});

test("a new evaluator joins the book its pick named", async () => {
  const { actor, clock, emitted } = await start();
  const Q = "01K6TEST000000000000000PC1";
  await select(actor, { id: NEW, book: Q });
  actor.send({ type: "_edit", patch: { name: "Kindness" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).map((e) => [e.id, e.book, e.name]), [[NEW, Q, "Kindness"]]);
});

test("rewording a question leaves as evaluator.saved with the new wording, under the same question id", async () => {
  const { actor, clock, emitted } = await start();
  await select(actor, { id: R, book: P });
  actor.send({ type: "_editQuestion", id: Q2, patch: { text: "Is it something to finish?" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).at(-1).questions.map((q) => [q.id, q.text]), [[Q1, "Goal or value?"], [Q2, "Is it something to finish?"]]);
});

test("an evaluator of another book is fetched with that book; a change to another book leaves the draft alone", async () => {
  const B = "01K6TEST000000000000000PB1";
  const theirs = { ...OTHER, id: "01K6TEST000000000000000R03", book: B, name: "Theirs" };
  const asked = [];
  const actor = createActor(machine, {
    input: {
      ask: (target, name, payload) => {
        if (target === "settings") return Promise.resolve({ vimKeys: false });
        asked.push([target, name, payload]);
        return Promise.resolve({ evaluators: payload.book === P ? [EVALUATOR] : [theirs] });
      },
      mint: () => NEW,
    },
  });
  actor.start();
  await select(actor, { id: R, book: P });
  await select(actor, { id: theirs.id, book: B });
  assert.equal(actor.getSnapshot().context.draft.name, "Theirs");
  assert.deepEqual(asked, [["evaluators", "list", { book: P }], ["evaluators", "list", { book: B }]]);
  actor.send(changed({ ...EVALUATOR, name: "Elsewhere" }));
  assert.equal(actor.getSnapshot().context.draft.name, "Theirs");
  assert.ok(!actor.getSnapshot().context.evaluators.some((e) => e.id === R));
  actor.stop();
});

test("a fact that cannot answer is an honest failure", async () => {
  const actor = createActor(machine, { input: { ask: () => Promise.resolve({ error: "no-answerer" }), mint: () => NEW } });
  actor.start();
  await select(actor, { id: R, book: P });
  assert.ok(actor.getSnapshot().matches("failed"));
});

test("the Vim keys preference is read at start and followed after; without settings it is off", async () => {
  assert.equal((await start()).ctx().vimKeys, false);
  const { actor, ctx } = await start(undefined, true);
  assert.equal(ctx().vimKeys, true);
  await select(actor, { id: R, book: P });
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(ctx().vimKeys, false);
  assert.equal(ctx().draft.id, R);
});
