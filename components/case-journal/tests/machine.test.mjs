import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, pieces, rows, onTools, blocked, request } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["case.saved", "case.selected", "passages.requested"].map((n) => [n, schema(n)]));

const id = (tag, n) => `01K6TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const A = id("P", 1);
const B = id("P", 2);
const NEW = id("D", 1);
const [GOAL, VALUE] = [1, 2].map((n) => id("N", n));
const PICK = id("Q", 1);
const YES = id("Q", 2);

const option = (oid, name) => ({ id: oid, name, description: "", removing: false });
const pick = () => ({
  id: PICK, kind: "pick", text: "Goal or value?", yes: "", no: "", options: [option(GOAL, "Goal"), option(VALUE, "Value")], removing: false,
});
const yesno = () => ({ id: YES, kind: "yesno", text: "Is it a goal?", yes: "", no: "", options: [], removing: false });
const rubric = (n, project, { on = true, questions = [pick()] } = {}) => ({ id: id("R", n), project, name: `Tool ${n}`, on, removing: false, questions });
const kase = (n, project, text = `Case ${n}.`) => ({ id: id("C", n), project, text, answers: {}, removing: false });
const LLM = { signedIn: true, jev: { keySet: true } };

const texts = (list) => list.map((p) => [p.text, p.finished]);

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

// --- Pieces -----------------------------------------------------------------------------

test("sentences end at . ! ? or …, with closing quotes or brackets, before a space or the end", () => {
  const text = "I always fail! Do I? He said “never.” (It rained…) Pi is 3.14 today.";
  assert.deepEqual(texts(pieces(text, "sentences", false)), [
    ["I always fail!", true],
    ["Do I?", true],
    ["He said “never.”", true],
    ["(It rained…)", true],
    ["Pi is 3.14 today.", true],
  ]);
});

test("a line break ends a sentence and a paragraph; blank lines make no piece", () => {
  const text = "First line\n\nSecond. Third\n  ";
  assert.deepEqual(texts(pieces(text, "sentences", false)), [["First line", true], ["Second.", true], ["Third", true]]);
  assert.deepEqual(texts(pieces(text, "paragraphs", false)), [["First line", true], ["Second. Third", true]]);
});

test("while typing, the piece at the end is unfinished until its punctuation or a line break", () => {
  assert.deepEqual(texts(pieces("One. Two", "sentences", true)), [["One.", true], ["Two", false]]);
  assert.deepEqual(texts(pieces("One. Two.", "sentences", true)), [["One.", true], ["Two.", true]]);
  assert.deepEqual(texts(pieces("One. Two\n", "sentences", true)), [["One.", true], ["Two", true]]);
  assert.deepEqual(texts(pieces("One. Two.", "paragraphs", true)), [["One. Two.", false]], "a paragraph waits for its line break");
  assert.deepEqual(texts(pieces("One. Two.\nThree", "paragraphs", true)), [["One. Two.", true], ["Three", false]]);
  assert.deepEqual(texts(pieces("One. Two", "sentences", false)), [["One.", true], ["Two", true]], "on blur every piece is finished");
});

test("every piece is a substring of the text", () => {
  const text = "  “Hi.”  Bye!\n\tA paragraph… with more ";
  for (const mode of ["sentences", "paragraphs"]) for (const p of pieces(text, mode, false)) assert.ok(text.includes(p.text), p.text);
});

test("rows: unfinished dimmed, waiting says so, answers per tool, yes / no toned", () => {
  const tools = onTools([rubric(1, A, { questions: [pick(), yesno()] }), rubric(2, A, { on: false })], A);
  const passages = {
    answers: [
      { text: "Done.", rubric: id("R", 1), at: 1, answers: [{ id: PICK, p: 0.58, choice: VALUE, probabilities: [] }, { id: YES, p: 0.3 }] },
    ],
    waiting: ["Asked."],
    error: null,
  };
  const shown = rows(pieces("Done. Asked. New. Typing", "sentences", true), tools, passages);
  assert.deepEqual(shown[0].tools, [
    {
      id: id("R", 1),
      name: "Tool 1",
      entries: [
        { id: PICK, kind: "pick", pick: "Value", sure: 58 },
        { id: YES, kind: "yesno", text: "Is it a goal?", pct: 30, tone: "no" },
      ],
    },
  ]);
  assert.equal(shown[1].waiting, true);
  assert.equal(shown[2].judged, false);
  assert.deepEqual(shown[3], { text: "Typing", finished: false });
});

// --- The actor ------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const start = async ({ cases = [kase(1, A, "One. Two.")], open = { [A]: id("C", 1) }, rubrics = [rubric(1, A)], llm = LLM, mode } = {}) => {
  const replies = { projects: { projects: [], current: A }, cases: { cases, open }, rubrics: { rubrics }, decisions: { decisions: [], run: null }, llm };
  const actor = createActor(machine, { input: { ask: (target) => Promise.resolve(replies[target]), mint: () => NEW, throttleMs: 20, mode } });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await wait(0);
  return { actor, emitted, ctx: () => actor.getSnapshot().context };
};

const asked = (emitted) => emitted.filter((e) => e.type === "passages.requested").map((e) => e.passages);

test("opening a case asks for every piece; typing asks for the finished ones after the save", async () => {
  const { actor, emitted } = await start();
  assert.deepEqual(asked(emitted), [["One.", "Two."]]);
  actor.send({ type: "_edit", text: "One. Two. Thr" });
  await wait(40);
  assert.deepEqual(emitted.slice(1).map((e) => e.type), ["case.saved", "passages.requested"], "the save comes first");
  assert.deepEqual(asked(emitted)[1], ["One.", "Two."], "the sentence being written waits");
  actor.send({ type: "_blur" });
  assert.deepEqual(asked(emitted)[2], ["One.", "Two.", "Thr"], "blur finishes it");
  valid(emitted);
});

test("another case opened, a project switched and a mode switched each ask", async () => {
  const cases = [kase(1, A, "One. Two."), kase(2, A, "Other one."), kase(3, B, "In B.")];
  const { actor, emitted } = await start({ cases, open: { [A]: id("C", 1), [B]: id("C", 3) }, rubrics: [rubric(1, A), rubric(2, B)] });
  actor.send({ type: "case.changed", cases, open: { [A]: id("C", 1), [B]: id("C", 3) } });
  assert.equal(asked(emitted).length, 1, "the same case again asks nothing");
  actor.send({ type: "case.changed", cases, open: { [A]: id("C", 2), [B]: id("C", 3) } });
  actor.send({ type: "_mode", mode: "paragraphs" });
  actor.send({ type: "_mode", mode: "paragraphs" });
  actor.send({ type: "project.changed", projects: [], current: B });
  assert.deepEqual(asked(emitted), [["One.", "Two."], ["Other one."], ["Other one."], ["In B."]]);
  assert.equal(emitted.at(-1).rubrics[0].id, id("R", 2), "the tools of the project switched to");
  valid(emitted);
});

test("nothing is asked while signed out, without a key, with no tool on, or with no text", async () => {
  const { actor, emitted, ctx } = await start({ llm: { error: "no-answerer" } });
  assert.equal(blocked(ctx()), "Sign in to judge.");
  actor.send({ type: "llm.changed", ...LLM, jev: { keySet: false } });
  assert.equal(blocked(ctx()), "Add your Jev key in Settings.");
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted, []);
  actor.send({ type: "llm.changed", ...LLM });
  actor.send({ type: "rubric.changed", rubrics: [rubric(1, A, { on: false })] });
  assert.equal(blocked(ctx()), "Switch on a tool in Tools to judge.");
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted, []);
  actor.send({ type: "rubric.changed", rubrics: [rubric(1, A)] });
  actor.send({ type: "_blur" });
  assert.equal(asked(emitted).length, 1);
  assert.equal(request({ ...ctx(), draft: { ...ctx().draft, text: " " } }, false), null, "no text, no request");
});

test("the mode starts from input, and a mode the machine does not know is Sentences", async () => {
  assert.equal((await start({ mode: "paragraphs" })).ctx().mode, "paragraphs");
  assert.equal((await start({ mode: "words" })).ctx().mode, "sentences");
});

test("a new case is never saved empty, and New case emits case.selected", async () => {
  const { actor, emitted, ctx } = await start({ cases: [], open: {} });
  assert.equal(ctx().draft, null);
  actor.send({ type: "_new" });
  assert.deepEqual(emitted, [{ type: "case.selected", id: NEW, project: A }]);
  actor.send({ type: "case.changed", cases: [], open: { [A]: NEW } });
  actor.send({ type: "_edit", text: " " });
  actor.send({ type: "_blur" });
  assert.equal(emitted.filter((e) => e.type === "case.saved").length, 0);
  valid(emitted);
});
