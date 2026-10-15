import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, keyOf, askedOf, CHECK_PAUSE_MS } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, faked asks (session,
// evaluators, choice-points, and llm: decide answered by hand), a fake sync api, and a
// simulated clock for the pause before a check and the network's idle window.
const SYNC_IDLE_MS = 2000;
const DAY = "2026-10-14";
const CP = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const CP2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const Q2 = "01ARZ3NDEKTSV4RRFFQ69G5Q02";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G5PT2";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const checkedSchema = new Validator(schema("../events/lines.checked.json"), "2020-12");
const changedSchema = new Validator(schema("../events/checks.changed.json"), "2020-12");
const readReply = new Validator(schema("../queries/read.json").reply, "2020-12");

const evaluator = (over = {}) => ({
  id: EV,
  book: BOOK,
  name: "Therapy Goal",
  on: true,
  version: 1,
  pending: false,
  removing: false,
  questions: [
    {
      id: Q1,
      kind: "pick",
      text: "What kind of goal is this?",
      yes: "",
      no: "",
      options: [
        { id: O1, name: "Behavioral goal", description: "" },
        { id: O2, name: "Emotional goal", description: "" },
      ],
    },
    { id: Q2, kind: "yesno", text: "Is it overt?", yes: "", no: "", options: [] },
  ],
  ...over,
});

const cp = (over = {}) => ({
  id: CP,
  day: DAY,
  situation: "",
  thoughts: "",
  away: "",
  towards: "Call mum\nGo for a walk",
  createdAt: "2016-07-30T23:54:10.259Z",
  version: 1,
  pending: false,
  removing: false,
  ...over,
});

const edited = (over = {}) => ({
  type: "checks.edited",
  field: "towards",
  evaluator: EV,
  questions: [{ id: Q1, show: true, expect: O1, when: null, icons: {} }],
  ...over,
});

const reply = (o1 = 0.9, yes = 0.8) => ({
  answers: [
    { id: Q1, p: o1, choice: O1 },
    { id: Q2, p: yes },
  ],
  inputTokens: 10,
  ms: 5,
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore() {
  const boxes = new Map();
  const answers = new Map();
  const outbox = new Map();
  const meta = new Map();
  return {
    boxes,
    answers,
    outbox,
    meta,
    boxAll: async () => [...boxes.values()],
    boxPut: async (r) => void boxes.set(r.field, r),
    answerAll: async () => [...answers.values()],
    answerPut: async (r) => void answers.set(r.key, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
  };
}

// The asks, each answered from what the test set up; every decide waits for the test to
// answer it, so how many are open at once is seen.
function fakeAsk({ userId = null, evaluators = [evaluator()], choicePoints = [] } = {}) {
  const decides = [];
  const ask = (target, name, payload) => {
    if (target === "session") return Promise.resolve({ userId, registrationOpen: false });
    if (target === "evaluators") return Promise.resolve({ evaluators });
    if (target === "choice-points") return Promise.resolve({ choicePoints });
    if (target === "llm" && name === "decide") {
      return new Promise((resolve) => decides.push({ payload, answer: resolve }));
    }
    return Promise.resolve({ error: "no-answerer" });
  };
  return { ask, decides };
}

function fakeApi() {
  const puts = [];
  return {
    puts,
    put: async (row) => {
      puts.push(row);
      if (row.kind === "answer") return { key: row.key, answers: row.answers };
      return { field: row.field, evaluator: row.evaluator, questions: row.questions, version: (row.baseVersion ?? 0) + 1 };
    },
    pull: async (since) => ({ boxes: [], answers: [], cursor: since }),
  };
}

async function start({ store = fakeStore(), asks = fakeAsk(), api } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask: asks.ask }, clock });
  const checked = [];
  const changed = [];
  actor.on("lines.checked", (e) => {
    const { type, ...payload } = e;
    assert.ok(checkedSchema.validate(payload).valid, JSON.stringify(e));
    checked.push(payload);
  });
  actor.on("checks.changed", (e) => {
    assert.ok(changedSchema.validate({ settings: e.settings }).valid, JSON.stringify(e));
    changed.push(e.settings);
  });
  actor.start();
  await new Promise((resolve) => {
    const sub = actor.subscribe((snap) => {
      if (snap.matches("ready")) {
        sub.unsubscribe();
        resolve();
      }
    });
    if (actor.getSnapshot().matches("ready")) resolve();
  });
  await flush();
  return { actor, clock, checked, changed, store, decides: asks.decides };
}

const read = (actor, payload = { day: DAY }) =>
  new Promise((reply) => actor.send({ type: "read?", cid: "c", payload, reply })).then((r) => {
    assert.ok(readReply.validate(r).valid, JSON.stringify(r));
    return r;
  });

const statuses = (event) => event.lines.map((l) => [l.text, l.status].join(":"));

// What choice-point-cards sends when the user moves on from lines: the save, with them named.
const saved = (c, finished) => ({ type: "choice-point.saved", id: c.id, day: c.day, situation: c.situation, thoughts: c.thoughts, away: c.away, towards: c.towards, finished });
const finishAll = (c, field = "towards") => saved(c, c[field].split("\n").filter((t) => t.trim()).map((text) => ({ field, text })));

test("a line is checked only once the user has finished it, one line at a time", async () => {
  const { actor, clock, checked, decides } = await start();
  actor.send(edited());
  actor.send({ type: "choice-point.changed", choicePoint: cp({ towards: "Call" }) });
  actor.send({ type: "choice-point.changed", choicePoint: cp({ towards: "Call mu" }) });
  clock.increment(CHECK_PAUSE_MS * 10);
  await flush();
  assert.equal(decides.length, 0, "typing alone, however long the pause, checks nothing");
  assert.equal(checked.length, 0);

  // The save may arrive before the change it leads to: the line waits for its text.
  const typing = cp({ towards: "Call mum\nGo for a walk\nRe" });
  actor.send(saved(typing, [{ field: "towards", text: "Call mum" }]));
  await flush();
  assert.equal(decides.length, 0, "not asked before choice-points holds the line");
  actor.send({ type: "choice-point.changed", choicePoint: typing });
  await flush();
  assert.equal(decides.length, 1, "one request at a time");
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:pending"], "lines not finished are left out");
  actor.send(saved(typing, [{ field: "towards", text: "Go for a walk" }]));
  await flush();
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:pending", "Go for a walk:pending"]);
  assert.deepEqual(decides[0].payload, { state: { text: "Call mum" }, questions: askedOf(evaluator()) });
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:pending", "Go for a walk:pending"]);

  decides[0].answer(reply(0.9, 0.2));
  await flush();
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:done", "Go for a walk:pending"]);
  actor.send(saved(cp({ towards: "Call mum\nGo for a walk\nRe" }), [{ field: "away", text: "Unchecked box" }]));
  await flush();
  assert.equal(decides.length, 2, "a finished line in a box without an evaluator asks nothing");
  assert.deepEqual(checked.at(-1).lines[0].answers, [
    { question: Q1, option: O1, name: "Behavioral goal", p: 0.9 },
    { question: Q2, option: "no", name: "No", p: 0.8 },
  ]);
  assert.equal(decides.length, 2, "the next line follows the answer");
  assert.equal(decides[1].payload.state.text, "Go for a walk");
  decides[1].answer(reply());
  await flush();
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:done", "Go for a walk:done"]);
});

test("a line already answered is never asked again, in any choice point", async () => {
  const { actor, clock, checked, decides } = await start();
  actor.send(edited());
  actor.send({ type: "choice-point.changed", choicePoint: cp({ towards: "Call mum" }) });
  actor.send(finishAll(cp({ towards: "Call mum" })));
  await flush();
  decides[0].answer(reply());
  await flush();
  for (const c of [cp({ towards: "Call mum  \n\nRest" }), cp({ id: CP2, towards: "Call mum" })]) {
    actor.send({ type: "choice-point.changed", choicePoint: c });
    actor.send(finishAll(c));
  }
  await flush();
  assert.deepEqual(decides.map((d) => d.payload.state.text), ["Call mum", "Rest"], "only the new line is asked");
  assert.deepEqual(statuses(checked.find((e) => e.choicePoint === CP2)), ["Call mum:done"]);
});

test("a line edited again while it waited in the queue is not asked about", async () => {
  const { actor, clock, decides } = await start();
  actor.send(edited());
  actor.send({ type: "choice-point.changed", choicePoint: cp({ towards: "One\nTwo" }) });
  actor.send(finishAll(cp({ towards: "One\nTwo" })));
  await flush();
  actor.send({ type: "choice-point.changed", choicePoint: cp({ towards: "One\nTwo!" }) });
  decides[0].answer(reply());
  await flush();
  actor.send(finishAll(cp({ towards: "One\nTwo!" })));
  await flush();
  assert.deepEqual(decides.map((d) => d.payload.state.text), ["One", "Two!"]);
});

test("changing the evaluator's questions checks the day on screen again; the box without an evaluator clears", async () => {
  const asks = fakeAsk({ choicePoints: [cp({ towards: "Call mum" })] });
  const { actor, clock, checked, decides } = await start({ asks });
  actor.send(edited());
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.equal(decides.length, 0, "no day on screen yet");
  actor.send({ type: "day.shown", day: DAY });
  await flush();
  assert.equal(decides.length, 1, "showing a day checks it at once");
  decides[0].answer(reply());
  await flush();

  actor.send({ type: "day.shown", day: DAY });
  await flush();
  assert.equal(decides.length, 1, "showing it again costs nothing");

  const renamed = evaluator({ name: "Goals" });
  actor.send({ type: "evaluator.changed", evaluator: renamed });
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.equal(decides.length, 1, "a new name asks nothing");

  const reworded = evaluator();
  reworded.questions[1] = { ...reworded.questions[1], text: "Can someone see it?" };
  actor.send({ type: "evaluator.changed", evaluator: reworded });
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.equal(decides.length, 2, "new questions are a new check");
  assert.equal(decides[1].payload.questions[1].instructions, "Can someone see it?");
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:pending"]);
  decides[1].answer(reply());
  await flush();

  actor.send(edited({ evaluator: null, questions: [] }));
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.deepEqual(checked.at(-1).lines, [], "the marks go when the box is no longer checked");
});

test("a failure ends the queue and is announced; busy waits and asks again", async () => {
  const { actor, clock, checked, decides } = await start();
  actor.send(edited());
  actor.send({ type: "choice-point.changed", choicePoint: cp() });
  actor.send(finishAll(cp()));
  await flush();
  decides[0].answer({ error: "busy" });
  await flush();
  assert.equal(decides.length, 1);
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.equal(decides.length, 2, "busy asks the same line again after the pause");
  assert.equal(decides[1].payload.state.text, "Call mum");

  decides[1].answer({ error: "no-key" });
  await flush();
  assert.equal(decides.length, 2, "the rest of the queue is not asked");
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:failed", "Go for a walk:failed"]);
  assert.equal(checked.at(-1).error, "no-key");

  const next = cp({ towards: "Call mum\nGo for a walk\nRest" });
  actor.send({ type: "choice-point.changed", choicePoint: next });
  actor.send(saved(next, [{ field: "towards", text: "Rest" }]));
  await flush();
  assert.equal(decides.length, 3, "the next finished line asks again, the failed lines with it");
  assert.deepEqual(statuses(checked.at(-1)), ["Call mum:pending", "Go for a walk:pending", "Rest:pending"]);
  decides[2].answer({ error: "no-answerer" });
  await flush();
  assert.equal(checked.at(-1).error, "unavailable", "a bus refusal is announced as unavailable");
});

test("read answers the settings and the day's checked choice points", async () => {
  const asks = fakeAsk({ choicePoints: [cp({ towards: "Call mum" }), cp({ id: CP2, day: "2026-10-13" })] });
  const { actor, changed, decides } = await start({ asks });
  const empty = await read(actor);
  assert.deepEqual(empty.choicePoints, []);
  assert.deepEqual(empty.settings.towards, { evaluator: null, questions: [] });
  actor.send(edited());
  assert.deepEqual(changed.at(-1).towards, { evaluator: EV, questions: edited().questions });
  actor.send({ type: "day.shown", day: DAY });
  await flush();
  decides[0].answer(reply());
  await flush();
  const r = await read(actor);
  assert.deepEqual(r.choicePoints.map((c) => [c.choicePoint, statuses(c)]), [[CP, ["Call mum:done"]]]);
  assert.deepEqual((await read(actor, {})).choicePoints, [], "no day, only the settings");
});

test("signed out the settings and answers are kept here; signing in uploads them", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, clock, decides } = await start({ store, api });
  actor.send(edited());
  actor.send({ type: "choice-point.changed", choicePoint: cp({ towards: "Call mum" }) });
  actor.send(finishAll(cp({ towards: "Call mum" })));
  await flush();
  decides[0].answer(reply());
  await flush();
  assert.equal(store.boxes.get("towards").version, 1);
  const key = keyOf(EV, askedOf(evaluator()), "Call mum");
  assert.equal(store.answers.get(key).answers.length, 2);
  assert.equal(api.puts.length, 0, "signed out never calls the api");

  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(api.puts.map((r) => r.id).sort(), ["answer:" + key, "box:towards"]);
  assert.equal(store.outbox.size, 0, "acknowledged rows leave the outbox");

  actor.send(edited({ questions: [] }));
  clock.increment(SYNC_IDLE_MS);
  await flush();
  assert.deepEqual([api.puts.at(-1).id, api.puts.at(-1).baseVersion], ["box:towards", 2]);
});
