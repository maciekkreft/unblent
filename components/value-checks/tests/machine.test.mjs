import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, keyOf, askedOf, CHECK_PAUSE_MS } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, faked asks (session,
// llm, evaluators, values, and llm: decide answered by hand), a fake sync api, and a
// simulated clock for the pause after a settings change.
const DAY = "2026-10-26";
const PAST = "2026-10-20";
const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const EX = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const Q2 = "01ARZ3NDEKTSV4RRFFQ69G5Q02";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G5PT2";
const V1 = "01ARZ3NDEKTSV4RRFFQ69G5VA1";
const V2 = "01ARZ3NDEKTSV4RRFFQ69G5VA2";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const checkedSchema = new Validator(schema("../events/values.checked.json"), "2020-12");
const changedSchema = new Validator(schema("../events/value-checks.changed.json"), "2020-12");
const readReply = new Validator(schema("../queries/read.json").reply, "2020-12");

// "Is it a value?": a pick question expecting "A value".
const isValue = {
  id: EV,
  book: BOOK,
  name: "Is it a value?",
  on: true,
  version: 1,
  questions: [
    {
      id: Q1,
      kind: "pick",
      text: "What is this?",
      yes: "",
      no: "",
      expect: O1,
      options: [
        { id: O1, name: "A value", description: "" },
        { id: O2, name: "A goal", description: "" },
      ],
    },
  ],
};
// "Does the example fit?": a yes / no question expecting yes.
const fits = {
  id: EX,
  book: BOOK,
  name: "Does the example fit?",
  on: true,
  version: 1,
  questions: [{ id: Q2, kind: "yesno", text: "Is this a way of living the value?", yes: "", no: "", expect: "yes", options: [] }],
};

const val = (id, name, meaning = "") => ({ id, name, meaning });

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore() {
  const answers = new Map();
  const outbox = new Map();
  const meta = new Map();
  let settings = null;
  return {
    answers,
    outbox,
    meta,
    settingsGet: async () => settings,
    settingsPut: async (r) => void (settings = r),
    answerAll: async () => [...answers.values()],
    answerPut: async (r) => void answers.set(r.key, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
  };
}

// `days` maps a day to the values as they stood on it; every decide waits for the test.
function fakeAsk({ keySet = true, userId = null, days = { [DAY]: [] } } = {}) {
  const decides = [];
  const reads = [];
  const ask = (target, name, payload) => {
    if (target === "session") return Promise.resolve({ userId, registrationOpen: false });
    if (target === "llm" && name === "read") return Promise.resolve({ jev: { keySet } });
    if (target === "evaluators") return Promise.resolve({ evaluators: [isValue, fits] });
    if (target === "values") {
      reads.push(payload.day);
      return Promise.resolve({ day: payload.day, values: days[payload.day] ?? [], changedSince: false });
    }
    if (target === "llm" && name === "decide") return new Promise((resolve) => decides.push({ payload, answer: resolve }));
    return Promise.resolve({ error: "no-answerer" });
  };
  return { ask, decides, reads };
}

async function start({ store = fakeStore(), asks = fakeAsk(), api } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask: asks.ask }, clock });
  const checked = [];
  const changed = [];
  actor.on("values.checked", (e) => {
    const { type, ...payload } = e;
    assert.ok(checkedSchema.validate(payload).valid, JSON.stringify(e));
    checked.push(payload);
  });
  actor.on("value-checks.changed", (e) => {
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
  return { actor, clock, checked, changed, store, decides: asks.decides, reads: asks.reads };
}

const read = (actor, payload = { day: DAY }) =>
  new Promise((reply) => actor.send({ type: "read?", cid: "c", payload, reply })).then((r) => {
    assert.ok(readReply.validate(r).valid, JSON.stringify(r));
    return r;
  });

const choose = (values = EV, examples = EX) => ({ type: "value-checks.edited", values, examples });
const changedTo = (values) => ({ type: "values.changed", day: DAY, values });
const saved = (values, finished) => ({ type: "values.saved", day: DAY, values, finished });
const pick = (choice, p = 0.9) => ({ answers: [{ id: Q1, p, choice }], inputTokens: 1, ms: 1 });
const yes = (p = 0.8) => ({ answers: [{ id: Q2, p }], inputTokens: 1, ms: 1 });
const lines = (event) => event.values.flatMap((v) => v.lines.map((l) => `${l.line}:${l.text}:${l.status}`));

test("without a Jev key nothing is asked and nothing is reported", async () => {
  const { actor, clock, checked, decides } = await start({ asks: fakeAsk({ keySet: false }) });
  actor.send(choose());
  actor.send({ type: "day.shown", day: DAY });
  const values = [val(V1, "Honesty", "Telling a friend the truth")];
  actor.send(changedTo(values));
  actor.send(saved(values, [V1]));
  clock.increment(CHECK_PAUSE_MS * 2);
  await flush();
  assert.equal(decides.length, 0);
  assert.equal(checked.length, 0);
  const reply = await read(actor);
  assert.deepEqual(reply, { keySet: false, settings: { values: EV, examples: EX }, values: [] });

  // The key saved: the day on screen is checked.
  actor.send({ type: "llm.changed", jev: { keySet: true } });
  await flush();
  assert.equal(decides.length, 1);
});

test("a finished row is asked once per line; the row being typed is not asked", async () => {
  const { actor, clock, checked, decides } = await start();
  actor.send(choose());
  actor.send({ type: "day.shown", day: DAY });
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  actor.send(changedTo([val(V1, "Hones")]));
  await flush();
  assert.equal(decides.length, 0, "typing asks nothing");

  // The save may arrive before the change it leads to: the row waits for its text.
  const values = [val(V1, "Honesty", "Telling a friend the truth"), val(V2, "Kin")];
  actor.send(saved(values, [V1]));
  await flush();
  assert.equal(decides.length, 0);
  actor.send(changedTo(values));
  await flush();
  assert.equal(decides.length, 1, "one request at a time");
  assert.deepEqual(decides[0].payload, { state: { text: "Honesty" }, questions: askedOf(isValue) });
  assert.deepEqual(lines(checked.at(-1)), ["value:Honesty:pending", "example:Telling a friend the truth:pending"], "the row typed in is left out");

  decides[0].answer(pick(O2));
  await flush();
  assert.equal(decides.length, 2);
  assert.deepEqual(decides[1].payload, {
    state: { text: "Honesty. For example: Telling a friend the truth" },
    questions: askedOf(fits),
  });
  decides[1].answer(yes());
  await flush();
  assert.deepEqual(lines(checked.at(-1)), ["value:Honesty:done", "example:Telling a friend the truth:done"]);
  assert.deepEqual(checked.at(-1).values[0].lines[0].answers, [{ question: Q1, option: O2, name: "A goal", p: 0.9 }]);
  assert.deepEqual(checked.at(-1).values[0].lines[0].unexpected, ["A goal"], "not the expected answer");
  assert.deepEqual(checked.at(-1).values[0].lines[1].unexpected, []);

  // Finishing the same row again asks nothing.
  actor.send(saved(values, [V1]));
  await flush();
  assert.equal(decides.length, 2);
  // Showing the day checks all of it: only the line never asked is asked.
  actor.send({ type: "day.shown", day: DAY });
  await flush();
  assert.deepEqual(decides.map((d) => d.payload.state.text).slice(2), ["Kin"]);
});

test("editing only the example keeps the value line's answers; a line without words is never asked", async () => {
  const days = { [DAY]: [val(V1, "Honesty", "Telling the truth")] };
  const { actor, decides, checked } = await start({ asks: fakeAsk({ days }) });
  actor.send(choose());
  actor.send({ type: "day.shown", day: DAY });
  await flush();
  decides[0].answer(pick(O1));
  await flush();
  decides[1].answer(yes());
  await flush();
  const values = [val(V1, "Honesty", "Owning up at work"), val(V2, " - ", "…")];
  actor.send(changedTo(values));
  actor.send(saved(values, [V1, V2]));
  await flush();
  assert.equal(decides.length, 3);
  assert.equal(decides[2].payload.state.text, "Honesty. For example: Owning up at work");
  decides[2].answer(yes(0.2));
  await flush();
  assert.equal(decides.length, 3, "nothing else is asked");
  const last = checked.at(-1);
  assert.deepEqual(lines(last), ["value:Honesty:done", "example:Owning up at work:done"]);
  assert.deepEqual(last.values[0].lines[1].unexpected, ["No"]);
});

test("a settings change asks the day on screen again, after a pause; Not checked clears the marks", async () => {
  const days = { [DAY]: [val(V1, "Honesty", "Telling the truth")] };
  const { actor, clock, decides, checked, changed } = await start({ asks: fakeAsk({ days }) });
  actor.send(choose(EV, null));
  actor.send({ type: "day.shown", day: DAY });
  await flush();
  assert.equal(decides.length, 1, "only the value line has an evaluator");
  decides[0].answer(pick(O1));
  await flush();
  assert.deepEqual(changed, [{ values: EV, examples: null }]);

  actor.send(choose(EV, EX));
  await flush();
  assert.equal(decides.length, 1, "the change waits for the pause");
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.equal(decides.length, 2);
  assert.equal(decides[1].payload.state.text, "Honesty. For example: Telling the truth");
  decides[1].answer(yes());
  await flush();

  actor.send(choose(null, null));
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.deepEqual(checked.at(-1).values, [], "no evaluator, no marks");
  const reply = await read(actor);
  assert.deepEqual(reply.settings, { values: null, examples: null });
});

test("a failure ends the queue and is announced; busy waits and asks again", async () => {
  const days = { [DAY]: [val(V1, "Honesty"), val(V2, "Kindness")] };
  const { actor, clock, decides, checked } = await start({ asks: fakeAsk({ days }) });
  actor.send(choose(EV, null));
  actor.send({ type: "day.shown", day: DAY });
  await flush();
  decides[0].answer({ error: "busy" });
  await flush();
  assert.equal(decides.length, 1, "busy waits");
  clock.increment(CHECK_PAUSE_MS);
  await flush();
  assert.equal(decides.length, 2);
  assert.equal(decides[1].payload.state.text, "Honesty");
  decides[1].answer({ error: "rate-limited" });
  await flush();
  assert.equal(decides.length, 2, "the queue ended");
  assert.deepEqual(lines(checked.at(-1)), ["value:Honesty:failed", "value:Kindness:failed"]);
  assert.equal(checked.at(-1).error, "rate-limited");

  // The next finished row retries what failed.
  actor.send(saved(days[DAY], [V2]));
  await flush();
  assert.equal(decides.length, 3);
});

test("a past day is checked with that day's values when it is shown, and read waits for them", async () => {
  const days = { [DAY]: [val(V1, "Honesty")], [PAST]: [val(V2, "Courage")] };
  const { actor, decides, reads } = await start({ asks: fakeAsk({ days }) });
  actor.send(choose(EV, null));
  const pending = read(actor, { day: PAST });
  await flush();
  assert.deepEqual(reads, [PAST]);
  assert.deepEqual((await pending).values, [], "nothing is checked on a day not shown");
  actor.send({ type: "day.shown", day: PAST });
  await flush();
  assert.deepEqual(reads, [PAST], "a day held is not asked again");
  assert.equal(decides[0].payload.state.text, "Courage");
  decides[0].answer(pick(O1));
  await flush();
  const reply = await read(actor, { day: PAST });
  assert.deepEqual(reply.values.map((v) => v.id), [V2]);
  // Today's change does not reach the past day.
  actor.send(changedTo([val(V1, "Honesty, always")]));
  assert.deepEqual((await read(actor, { day: PAST })).values.map((v) => v.id), [V2]);
});

test("signed out the settings and answers are kept here; signing in uploads them", async () => {
  const puts = [];
  const api = {
    put: async (row) => {
      puts.push(row);
      return row.kind === "answer" ? { key: row.key, answers: row.answers } : { values: row.values, examples: row.examples, version: (row.baseVersion ?? 0) + 1 };
    },
    pull: async (since) => ({ settings: null, answers: [], cursor: since }),
  };
  const days = { [DAY]: [val(V1, "Honesty")] };
  const { actor, decides, store } = await start({ asks: fakeAsk({ days }), api });
  actor.send(choose(EV, null));
  actor.send({ type: "day.shown", day: DAY });
  await flush();
  decides[0].answer(pick(O1));
  await flush();
  assert.equal(store.outbox.size, 0, "nothing queued while signed out");
  const key = keyOf(EV, [askedOf(isValue)[0]], "Honesty");
  assert.ok(store.answers.has(key));
  actor.send({ type: "session.changed", userId: "u1", registrationOpen: false });
  await flush(30);
  assert.deepEqual(puts.map((r) => r.id).sort(), [`answer:${key}`, "settings"]);
  assert.deepEqual(puts.find((r) => r.id === "settings"), { id: "settings", kind: "settings", values: EV, examples: null, baseVersion: 1 });
});
