import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, keyOf, askedOf, shortName, hashtagScopes, CHECK_PAUSE_MS } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, faked asks (session,
// evaluators, llm: read, and llm: decide answered by hand), a fake sync api, and a
// simulated clock for a busy line's pause and the network's idle window.
const SYNC_IDLE_MS = 2000;
const NOTE = "01ARZ3NDEKTSV4RRFFQ69G5NT1";
const TODAY = "01ARZ3NDEKTSV4RRFFQ69G5DY2";
const PAST = "01ARZ3NDEKTSV4RRFFQ69G5DY1";
const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const EV2 = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const Q2 = "01ARZ3NDEKTSV4RRFFQ69G5Q02";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G5PT2";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const checkedSchema = new Validator(schema("../events/text.checked.json"), "2020-12");
const readReply = new Validator(schema("../queries/read.json").reply, "2020-12");

// A pick question with icons and a yes / no question with a short name.
const control = (over = {}) => ({
  id: EV,
  book: BOOK,
  name: "In my control",
  on: true,
  version: 1,
  questions: [
    {
      id: Q1,
      kind: "pick",
      text: "Is this in my control?",
      yes: "",
      no: "",
      options: [
        { id: O1, name: "In my control", description: "", icon: "check" },
        { id: O2, name: "Not in my control", description: "" },
      ],
    },
    { id: Q2, kind: "yesno", text: "Is it a worry about the future?", name: "Worry", yes: "", no: "", options: [] },
  ],
  ...over,
});

const reply = (choice = O1, yes = 0.8) => ({ answers: [{ id: Q1, p: 0.9, choice }, { id: Q2, p: yes }], inputTokens: 1, ms: 1 });

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore() {
  const answers = new Map();
  const outbox = new Map();
  const meta = new Map();
  return {
    answers,
    outbox,
    meta,
    answerAll: async () => [...answers.values()],
    answerPut: async (r) => void answers.set(r.key, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
    empty: async () => {
      answers.clear();
      outbox.clear();
      meta.clear();
    },
  };
}

// Every decide waits for the test to answer it, so how many are open at once is seen.
function fakeAsk({ userId = null, evaluators = [control()], decider = true } = {}) {
  const decides = [];
  const ask = (target, name, payload) => {
    if (target === "session") return Promise.resolve({ userId, registrationOpen: false });
    if (target === "evaluators") return Promise.resolve({ evaluators });
    if (target === "llm" && name === "read") return Promise.resolve({ decider: { ready: decider } });
    if (target === "llm" && name === "decide") return new Promise((resolve) => decides.push({ payload, answer: resolve }));
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
      return { key: row.key, answers: row.answers };
    },
    pull: async (since) => ({ answers: [], cursor: since }),
  };
}

async function start({ store = fakeStore(), asks = fakeAsk(), api } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask: asks.ask }, clock });
  const checked = [];
  actor.on("text.checked", (e) => {
    const { type, ...payload } = e;
    assert.ok(checkedSchema.validate(payload).valid, JSON.stringify(e));
    checked.push(payload);
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
  return { actor, clock, checked, store, decides: asks.decides };
}

const read = (actor, payload) =>
  new Promise((reply) => actor.send({ type: "read?", cid: "c", payload, reply })).then((r) => {
    assert.ok(readReply.validate(r).valid, JSON.stringify(r));
    return r;
  });

const note = (body, finished) => ({ type: "note.saved", id: NOTE, title: "", body, baseVersion: null, ...(finished ? { finished } : {}) });
const day = (id, text, finished) => ({ type: "day.saved", id, text, ...(finished ? { finished } : {}) });
const journal = (open, ids = [PAST, TODAY]) => ({ type: "journal.changed", days: ids.map((id) => ({ id })), projects: [], detectors: [], answers: [], open, reason: null });
const statuses = (event) => event.lines.map((l) => `${l.text}:${l.status}`);

test("the hashtag parse is the kit's: a gap ends a scope and a later hashtag line starts its own", () => {
  assert.deepEqual(hashtagScopes("Tonight #in-my-control\n- Rent\n  \n\nAfter\n#a #b\n* x\n#a"), [
    { tags: ["in-my-control"], lines: ["- Rent"] },
    { tags: ["a", "b"], lines: ["* x"] },
    { tags: ["a"], lines: [] },
  ]);
  assert.equal(shortName("Łódź Trips!"), "lodz-trips");
});

test("only finished lines in a hashtag scope are asked, one at a time; the hashtag line is not", async () => {
  const { actor, checked, decides } = await start();
  const body = "Things on my mind #in-my-control\nRent is due\nThe weather\n\nNot in scope";
  actor.send(note(body, ["Things on my mind #in-my-control", "Rent is due", "Not in scope"]));
  await flush();
  assert.equal(decides.length, 1, "one request at a time");
  assert.deepEqual(decides[0].payload, { state: { text: "Rent is due" }, questions: askedOf(control()) });
  assert.deepEqual(checked.at(-1).tags, [{ tag: "in-my-control", evaluator: EV }]);
  assert.deepEqual(statuses(checked.at(-1)), ["Rent is due:pending"], "an unfinished line is left out");
  decides[0].answer(reply(O1, 0.8));
  await flush();
  assert.equal(decides.length, 1, "nothing else was finished in the scope");
  assert.deepEqual(checked.at(-1).lines, [
    {
      text: "Rent is due",
      status: "done",
      marks: [
        { evaluator: EV, question: Q1, option: O1, name: "In my control", icon: "check", p: 0.9 },
        { evaluator: EV, question: Q2, option: "yes", name: "Worry", p: 0.8 },
      ],
    },
  ]);
});

test("a yes / no answered no has no mark, and an option without an icon has none", async () => {
  const { actor, checked, decides } = await start();
  actor.send(note("#in-my-control\nThe weather", ["The weather"]));
  await flush();
  decides[0].answer(reply(O2, 0.1));
  await flush();
  assert.deepEqual(checked.at(-1).lines[0].marks, [{ evaluator: EV, question: Q1, option: O2, name: "Not in my control", p: 0.9 }]);
});

test("a tag no evaluator has checks nothing and names no evaluator", async () => {
  const { actor, checked, decides } = await start();
  actor.send(note("#foo\nRent is due", ["Rent is due"]));
  await flush();
  assert.equal(decides.length, 0);
  assert.deepEqual(checked.at(-1), { source: { kind: "note", id: NOTE }, tags: [{ tag: "foo", evaluator: null }], lines: [] });
});

test("a line already answered is never asked again, in any text", async () => {
  const { actor, checked, decides } = await start();
  actor.send(note("#in-my-control\nRent is due", ["Rent is due"]));
  await flush();
  decides[0].answer(reply());
  await flush();
  actor.send(day(TODAY, "#In-My-Control\n  Rent is due  ", ["Rent is due"]));
  actor.send(journal(TODAY));
  await flush();
  assert.equal(decides.length, 1, "the kept answer is reused");
  const forDay = checked.filter((e) => e.source.kind === "day").at(-1);
  assert.deepEqual(statuses(forDay), ["Rent is due:done"]);
});

test("a journal day asks only while it is the open day; a past day never asks", async () => {
  const { actor, checked, decides } = await start();
  actor.send(day(PAST, "#in-my-control\nOld worry", ["Old worry"]));
  await flush();
  assert.equal(decides.length, 0, "the day waits for the journal to say which day is open");
  actor.send(journal(TODAY));
  await flush();
  assert.equal(decides.length, 0, "a past day never asks");
  assert.deepEqual(statuses(checked.at(-1)), []);
  actor.send(day(TODAY, "#in-my-control\nNew worry", ["New worry"]));
  await flush();
  assert.deepEqual(decides.map((d) => d.payload.state.text), ["New worry"]);
});

test("read answers from kept answers only and never asks", async () => {
  const store = fakeStore();
  const [q] = askedOf(control()).filter((x) => x.id === Q1);
  const key = keyOf(EV, [q], "Rent is due");
  store.answers.set(key, { key, answers: [{ question: Q1, option: O1, name: "In my control", p: 0.7 }] });
  const { actor, decides } = await start({ store });
  const r = await read(actor, { kind: "day", id: PAST, text: "#in-my-control\nRent is due\nNever answered" });
  assert.equal(decides.length, 0);
  assert.deepEqual(r.tags, [{ tag: "in-my-control", evaluator: EV }]);
  assert.deepEqual(r.lines, [
    { text: "Rent is due", status: "done", marks: [{ evaluator: EV, question: Q1, option: O1, name: "In my control", icon: "check", p: 0.7 }] },
  ]);
});

test("without a decider nothing is asked, but the tags are still reported", async () => {
  const { actor, checked, decides } = await start({ asks: fakeAsk({ decider: false }) });
  actor.send(note("#in-my-control\nRent is due", ["Rent is due"]));
  await flush();
  assert.equal(decides.length, 0);
  assert.deepEqual(checked.at(-1).tags, [{ tag: "in-my-control", evaluator: EV }]);
  actor.send({ type: "llm.changed", decider: { ready: true } });
  actor.send(note("#in-my-control\nRent is due", ["Rent is due"]));
  await flush();
  assert.equal(decides.length, 1, "a decider made ready asks at the next finished line");
});

test("busy waits and asks again; another failure is kept and retried at the next finish", async () => {
  const { actor, clock, checked, decides } = await start();
  actor.send(note("#in-my-control\nOne", ["One"]));
  await flush();
  decides[0].answer({ error: "busy" });
  await flush();
  assert.equal(decides.length, 1);
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.equal(decides.length, 2, "the busy line is asked again after the pause");
  decides[1].answer({ error: "rate-limited" });
  await flush();
  assert.deepEqual(statuses(checked.at(-1)), ["One:failed"]);
  assert.equal(checked.at(-1).error, "rate-limited");
  actor.send(note("#in-my-control\nOne\nTwo", ["Two"]));
  await flush();
  decides[2].answer(reply());
  await flush();
  assert.deepEqual(decides.map((d) => d.payload.state.text), ["One", "One", "One", "Two"], "the failed line is retried at the next finish");
});

test("renaming an evaluator changes what its tag names, asking nothing", async () => {
  const { actor, checked, decides } = await start();
  actor.send(note("#in-my-control\nOne", ["One"]));
  await flush();
  decides[0].answer(reply());
  await flush();
  actor.send({ type: "evaluator.changed", evaluator: control({ name: "Control" }) });
  await flush();
  assert.deepEqual(checked.at(-1), { source: { kind: "note", id: NOTE }, tags: [{ tag: "in-my-control", evaluator: null }], lines: [] });
  actor.send({ type: "evaluator.changed", evaluator: { ...control({ id: EV2, name: "In my control" }) } });
  await flush();
  assert.equal(checked.at(-1).tags[0].evaluator, EV2);
  assert.equal(decides.length, 1, "a rename never asks by itself");
});

test("an answer made signed in is queued and uploaded once the network is idle", async () => {
  const api = fakeApi();
  const { actor, clock, decides, store } = await start({ api, asks: fakeAsk({ userId: "u1" }) });
  actor.send(note("#in-my-control\nOne", ["One"]));
  await flush();
  decides[0].answer(reply());
  await flush();
  assert.equal(store.outbox.size, 2, "one row per question");
  clock.increment(SYNC_IDLE_MS);
  await flush();
  assert.equal(api.puts.length, 2);
  assert.equal(store.outbox.size, 0);
});
