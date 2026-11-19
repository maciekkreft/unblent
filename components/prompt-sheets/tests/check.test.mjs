import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, fitsFrom } from "../machine.js";

// How prompt-sheets checks that an answer responds to its prompt: it asks the built-in
// Answers the prompt evaluator's one question through a faked `llm: decide`, found by its
// fixed ids, and writes fits without making a step.

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5PS1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5PS2";
const SET = "01ARZ3NDEKTSV4RRFFQ69G5ST1";
const PROMPT = "0000000000000000000000PRMT";
const ANSWERS = "0000000000000000000000NSWR";
const JOURNAL = "00000000000000000000000JRN";

const evaluator = (question = {}, over = {}) => ({
  id: PROMPT,
  book: JOURNAL,
  name: "Answers the prompt",
  on: true,
  version: 1,
  pending: false,
  removing: false,
  questions: [{ id: ANSWERS, kind: "yesno", text: "Does the answer respond to what the prompt asks?", yes: "About it.", no: "", ...question }],
  ...over,
});

const decideSchema = new Validator(JSON.parse(readFileSync(new URL("../../llm/queries/decide.json", import.meta.url))).payload, "2020-12");
const changedSchema = new Validator(JSON.parse(readFileSync(new URL("../events/prompt-sheet.changed.json", import.meta.url))), "2020-12");

const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, structuredClone(r)), Promise.resolve()),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: () => Promise.resolve(undefined),
    metaPut: () => Promise.resolve(),
  };
}

const yes = (p) => () => ({ answers: [{ id: ANSWERS, p }], inputTokens: 10, ms: 5 });

// `answer(payload)` stands in for llm: decide: by default a sure yes.
async function start({ store = fakeStore(), listed = evaluator(), answer = yes(0.9), today = DAY } = {}) {
  const asked = [];
  let open = 0;
  const ask = async (target, name, payload) => {
    if (target === "session") return { userId: null };
    if (target === "journal") return today ? { today } : { error: "no-answerer" };
    if (target === "evaluators") return { evaluators: listed ? [listed] : [] };
    if (target === "llm" && name === "decide") {
      assert.ok(decideSchema.validate(payload).valid, JSON.stringify(payload));
      assert.equal(open, 0, "one decision at a time");
      asked.push(payload);
      open += 1;
      try {
        return await answer(payload);
      } finally {
        open -= 1;
      }
    }
    return { error: "no-answerer" };
  };
  let minted = 0;
  const waits = [];
  const actor = createActor(machine, {
    input: { store, ask, wait: (ms) => (waits.push(ms), Promise.resolve()), mint: () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}` },
  });
  const steps = [];
  actor.on("step.recorded", (e) => steps.push(e));
  actor.on("prompt-sheet.changed", (e) => assert.ok(changedSchema.validate({ sheet: e.sheet }).valid, JSON.stringify(e)));
  actor.start();
  await flush();
  const save = (texts, over = {}) =>
    actor.send({
      type: "prompt-sheet.saved",
      id: ID,
      day: DAY,
      setId: SET,
      setName: "Evening review",
      basedOn: "",
      answers: texts.map((answer, i) => ({ prompt: `Prompt ${i + 1}?`, answer })),
      ...over,
    });
  const held = async (id = ID) => (await new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: { id }, reply }))).sheet;
  const fits = async (id) => (await held(id)).answers.map((a) => a.fits);
  return { actor, asked, steps, save, held, fits, store, waits };
}

test("fits is true from 75% yes, false from 75% no, and none in between", () => {
  const at = (p) => fitsFrom([{ id: ANSWERS, p }]);
  assert.deepEqual([at(0.9), at(0.75), at(0.5), at(0.26), at(0.25), at(0.1)], [true, true, null, null, false, false]);
  assert.equal(fitsFrom([]), null);
});

test("nothing is asked while the user is typing; a finished stretch asks about each answer with words, one at a time", async () => {
  const s = await start();
  s.save(["A walk", "", "Too much phone"]);
  await flush();
  assert.equal(s.asked.length, 0, "the sheet typed in waits for its stretch to end");
  s.save(["A walk", "", "Too much phone"], { finished: true });
  await flush();
  assert.deepEqual(s.asked, [
    {
      state: { prompt: "Prompt 1?", answer: "A walk" },
      questions: [{ id: ANSWERS, instructions: "Does the answer respond to what the prompt asks?", yes: "About it." }],
    },
    {
      state: { prompt: "Prompt 3?", answer: "Too much phone" },
      questions: [{ id: ANSWERS, instructions: "Does the answer respond to what the prompt asks?", yes: "About it." }],
    },
  ]);
  assert.deepEqual(await s.fits(), [true, null, true]);
  assert.equal(s.steps.length, 1, "writing fits is not a step");
});

test("an answer that does not respond is false, an unsure one stays none, and neither is asked again", async () => {
  const s = await start({ answer: (p) => yes(p.state.answer === "Pizza" ? 0.1 : 0.5)() });
  s.save(["Pizza", "Maybe"], { finished: true });
  await flush();
  assert.deepEqual(await s.fits(), [false, null]);
  s.save(["Pizza", "Maybe"], { finished: true });
  s.actor.send({ type: "journal.changed", today: DAY });
  await flush();
  assert.equal(s.asked.length, 2, "asked once a page load");
});

test("new words drop the judgement and are asked again; the same words to the same prompt are asked once", async () => {
  const s = await start();
  s.save(["A walk"], { finished: true });
  await flush();
  assert.deepEqual(await s.fits(), [true]);
  s.save(["A run"]);
  assert.deepEqual(await s.fits(), [null], "changing the words drops it");
  s.save(["A run"], { finished: true });
  await flush();
  assert.deepEqual(s.asked.map((p) => p.state.answer), ["A walk", "A run"]);
  s.save(["A walk"], { finished: true });
  s.save(["A walk"], { id: ID2, finished: true });
  await flush();
  assert.equal(s.asked.length, 2, "words judged before are not asked again");
  assert.deepEqual([await s.fits(), await s.fits(ID2)], [[true], [true]]);
});

test("Undo keeps the judgement of an answer whose words come back the same", async () => {
  const s = await start();
  s.save(["A walk"], { finished: true });
  await flush();
  s.save(["A walk, then tea"], { finished: true });
  await flush();
  const edit = s.steps.at(-1);
  s.actor.send({ type: "step.undone", id: edit.id, owner: "prompt-sheets", payload: edit.undo });
  await flush();
  assert.deepEqual(await s.fits(), [true]);
  assert.equal(s.asked.length, 2);
});

test("a failure leaves fits none without a word and is asked again only at the next load; busy is waited out", async () => {
  for (const error of ["unavailable", "no-key", "local-off", "no-model"]) {
    const store = fakeStore();
    const s = await start({ store, answer: () => ({ error }) });
    s.save(["A walk"], { finished: true });
    await flush();
    s.save(["A walk"], { finished: true });
    await flush();
    assert.equal(s.asked.length, 1, error);
    assert.deepEqual(await s.fits(), [null]);
    s.actor.stop();
    const again = await start({ store });
    await flush();
    assert.equal(again.asked.length, 1, "the next load asks again");
    assert.deepEqual(await again.fits(), [true]);
    again.actor.stop();
  }
  let calls = 0;
  const busy = await start({ answer: () => (++calls < 3 ? { error: "busy" } : yes(0.1)()) });
  busy.save(["Pizza"], { finished: true });
  await flush(20);
  assert.deepEqual([busy.asked.length, busy.waits], [3, [1500, 1500]]);
  assert.deepEqual(await busy.fits(), [false]);
});

test("nothing is asked while the evaluator is not listed, switched off or its question cannot be asked, nor about an earlier day", async () => {
  for (const listed of [null, evaluator({}, { on: false }), evaluator({ on: false }), evaluator({ text: " " }), evaluator({ kind: "pick" })]) {
    const s = await start({ listed });
    s.save(["A walk"], { finished: true });
    await flush();
    assert.deepEqual(s.asked, [], JSON.stringify(listed));
    s.actor.stop();
  }
  const s = await start({ listed: null });
  s.save(["A walk"], { finished: true });
  s.save(["Old"], { id: ID2, day: "2026-10-13", finished: true });
  await flush();
  s.actor.send({ type: "evaluator.changed", evaluator: evaluator() });
  await flush();
  assert.deepEqual(s.asked.map((p) => p.state.answer), ["A walk"], "asked once announced, and only about today");
  s.actor.send({ type: "evaluator.deleted", id: PROMPT, book: JOURNAL });
  s.save(["A walk", "More"], { finished: true });
  await flush();
  assert.equal(s.asked.length, 1, "not after it goes");
  const unknown = await start({ today: null });
  unknown.save(["A walk"], { finished: true });
  await flush();
  assert.deepEqual(unknown.asked, [], "nor while today is not known");
});
