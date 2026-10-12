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
const SCHEMAS = { "detector.saved": json("detector.saved"), "removal.started": json("removal.started") };
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
const DETECTOR = {
  id: R,
  project: P,
  name: "Goal or value",
  on: true,
  removing: false,
  questions: [
    { id: Q1, kind: "pick", text: "Goal or value?", yes: "", no: "", options: [opt(O1, "Goal"), opt(O2, "Value")], removing: false },
    { id: Q2, kind: "yesno", text: "Is it a goal?", yes: "finished", no: "never", options: [], removing: false },
  ],
};
const OTHER = { ...DETECTOR, id: R2, name: "Other detector", questions: [] };

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async (detectors = [DETECTOR, OTHER]) => {
  let n = 0;
  const clock = new SimulatedClock();
  const replies = { journal: { projects: [{ id: P, name: "A", on: true, version: 1, removing: false }], detectors } };
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target) => Promise.resolve(replies[target]),
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
const saves = (emitted) => emitted.filter((e) => e.type === "detector.saved");

// Every emit of the suite matches its schema.
after(() => {
  for (const { type, ...rest } of recorded) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, JSON.stringify({ type, ...rest }));
});

test("a new detector with nothing written is never saved, and its first word is", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "detector.selected", id: NEW, project: P });
  assert.ok(actor.getSnapshot().matches({ ready: "editing" }));
  assert.equal(ctx().draft.project, P);
  assert.equal(ctx().draft.questions.length, 1);
  assert.ok(isEmpty(ctx().draft));
  actor.send({ type: "_kind", id: ctx().draft.questions[0].id, kind: "pick" });
  actor.send({ type: "_blur" });
  actor.send({ type: "_addQuestion" });
  clock.increment(200);
  actor.send({ type: "detector.selected", id: R, project: P });
  assert.deepEqual(emitted, []);

  actor.send({ type: "detector.selected", id: NEW, project: P });
  actor.send({ type: "_edit", patch: { name: "Fresh" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).filter((e) => e.id === NEW).map((e) => [e.project, e.name]), [[P, "Fresh"]]);
});

test("a stored detector cleared of every word is still saved", async () => {
  const { actor, clock, emitted } = await start([{ ...DETECTOR, name: "x", questions: [] }]);
  actor.send({ type: "detector.selected", id: R, project: P });
  actor.send({ type: "_edit", patch: { name: "" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).map((e) => e.name), [""]);
});

test("every edit leaves as the whole detector, without on/off or flags, at the throttle or at blur", async () => {
  const { actor, clock, emitted } = await start();
  actor.send({ type: "detector.selected", id: R, project: P });
  actor.send({ type: "_editOption", question: Q1, id: O1, patch: { description: "Done once" } });
  actor.send({ type: "_editQuestion", id: Q2, patch: { yes: "it ends" } });
  clock.increment(199);
  assert.equal(emitted.length, 0);
  clock.increment(1);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    type: "detector.saved",
    id: R,
    project: P,
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
  actor.send({ type: "detector.selected", id: R, project: P });
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
  actor.send({ type: "detector.selected", id: R, project: P });
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

test("removing an option, a question or the detector saves first, then emits removal.started and hides it", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "detector.selected", id: R, project: P });
  actor.send({ type: "_editOption", question: Q1, id: O2, patch: { name: "Value " } });
  actor.send({ type: "_removeOption", question: Q1, id: O2 });
  assert.deepEqual(emitted.map((e) => e.type), ["detector.saved", "removal.started"]);
  assert.equal(emitted[0].questions[0].options[1].name, "Value ");
  assert.deepEqual(emitted[1], { type: "removal.started", kind: "option", id: O2, name: "Value" });
  assert.equal(ctx().draft.questions[0].options[1].removing, true);

  actor.send({ type: "_removeQuestion", id: Q2 });
  assert.deepEqual(emitted.at(-1), { type: "removal.started", kind: "question", id: Q2, name: "" });
  // The save before it leaves out what is already flagged; `journal` keeps that in place.
  assert.deepEqual(saves(emitted).at(-1).questions[0].options.map((o) => o.id), [O1]);

  actor.send({ type: "_delete" });
  assert.deepEqual(emitted.at(-1), { type: "removal.started", kind: "rubric", id: R, name: "Goal or value" });
  assert.equal(ctx().draft.removing, true);
  actor.send({ type: "_delete" });
  assert.equal(emitted.filter((e) => e.kind === "rubric").length, 1);
});

test("Undo from the fact brings an item back; a settled removal drops it, even while typing", async () => {
  const { actor, ctx } = await start();
  actor.send({ type: "detector.selected", id: R, project: P });
  actor.send({ type: "_removeOption", question: Q1, id: O2 });
  const flagged = { ...DETECTOR, questions: [{ ...DETECTOR.questions[0], options: [opt(O1, "Goal"), opt(O2, "Value", "", true)] }, DETECTOR.questions[1]] };
  actor.send({ type: "journal.changed", detectors: [flagged, OTHER] });
  actor.send({ type: "_editQuestion", id: Q2, patch: { text: "Typing" } });
  actor.send({ type: "journal.changed", detectors: [DETECTOR, OTHER] });
  assert.equal(ctx().draft.questions[0].options[1].removing, false);
  assert.equal(ctx().draft.questions[1].text, "Typing");

  actor.send({ type: "_removeOption", question: Q1, id: O2 });
  actor.send({ type: "_editQuestion", id: Q2, patch: { text: "Typing more" } });
  const gone = { ...DETECTOR, questions: [{ ...DETECTOR.questions[0], options: [opt(O1, "Goal")] }, DETECTOR.questions[1]] };
  actor.send({ type: "journal.changed", detectors: [gone, OTHER] });
  assert.deepEqual(ctx().draft.questions[0].options.map((o) => o.id), [O1]);
  assert.equal(ctx().draft.questions[1].text, "Typing more");
});

test("a deleted detector says so, Undo brings it back, and a settled delete keeps saying so", async () => {
  const { actor, ctx } = await start();
  actor.send({ type: "detector.selected", id: R, project: P });
  actor.send({ type: "_delete" });
  actor.send({ type: "journal.changed", detectors: [{ ...DETECTOR, removing: true }, OTHER] });
  assert.equal(ctx().draft.removing, true);
  actor.send({ type: "journal.changed", detectors: [DETECTOR, OTHER] });
  assert.equal(ctx().draft.removing, false);
  actor.send({ type: "_delete" });
  actor.send({ type: "journal.changed", detectors: [OTHER] });
  assert.equal(ctx().draft.removing, true);
});

test("in a detector never saved, a removal just drops the item and emits nothing", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "detector.selected", id: NEW, project: P });
  actor.send({ type: "_addQuestion" });
  actor.send({ type: "_removeQuestion", id: ctx().draft.questions[1].id });
  actor.send({ type: "_delete" });
  assert.equal(ctx().draft.questions.length, 1);
  assert.equal(ctx().draft.removing, false);
  assert.deepEqual(emitted, []);
});

test("moving to another detector saves the one being left at once", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "detector.selected", id: R, project: P });
  actor.send({ type: "_edit", patch: { name: "Half typed" } });
  actor.send({ type: "detector.selected", id: R2, project: P });
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
  actor.send({ type: "detector.selected", id: R, project: P });
  resolve({ projects: [], detectors: [DETECTOR] });
  await flush();
  assert.equal(actor.getSnapshot().context.draft.name, "Goal or value");
  actor.send({ type: "journal.changed", detectors: [{ ...DETECTOR, name: "Renamed elsewhere" }] });
  assert.equal(actor.getSnapshot().context.draft.name, "Renamed elsewhere");
  actor.send({ type: "_edit", patch: { name: "Mine" } });
  actor.send({ type: "journal.changed", detectors: [{ ...DETECTOR, name: "Elsewhere again" }] });
  assert.equal(actor.getSnapshot().context.draft.name, "Mine");
  actor.stop();
});

test("the detector open before a reload opens again while it exists, and a pick is remembered", async () => {
  const kept = [];
  const boot = async (open) => {
    const actor = createActor(machine, {
      input: {
        ask: () => Promise.resolve({ projects: [], detectors: [DETECTOR] }),
        mint: () => NEW,
        open,
        remember: (id) => kept.push(id),
      },
    });
    actor.start();
    await flush();
    return actor;
  };
  const again = await boot(R);
  assert.equal(again.getSnapshot().context.draft.id, R);
  again.send({ type: "detector.selected", id: NEW, project: P });
  assert.deepEqual(kept, [NEW]);
  const gone = await boot(R2);
  assert.ok(gone.getSnapshot().matches({ ready: "choosing" }));
});

test("a new detector joins the project its pick named", async () => {
  const { actor, clock, emitted } = await start();
  const Q = "01K6TEST000000000000000PC1";
  actor.send({ type: "detector.selected", id: NEW, project: Q });
  actor.send({ type: "_edit", patch: { name: "Kindness" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).map((e) => [e.id, e.project, e.name]), [[NEW, Q, "Kindness"]]);
});

test("rewording a question leaves as detector.saved with the new wording, under the same question id", async () => {
  const { actor, clock, emitted } = await start();
  actor.send({ type: "detector.selected", id: R, project: P });
  actor.send({ type: "_editQuestion", id: Q2, patch: { text: "Is it something to finish?" } });
  clock.increment(200);
  assert.deepEqual(saves(emitted).at(-1).questions.map((q) => [q.id, q.text]), [[Q1, "Goal or value?"], [Q2, "Is it something to finish?"]]);
});
