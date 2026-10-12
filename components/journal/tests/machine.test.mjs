import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, openDay, paragraphs, wordingOf, dateOf, catchUp, SEED, SEED_VERSION, IDS, HOUR } from "../machine.js";

// The actor is where the journal's decisions live (3.2): it is driven with a fake store,
// a clock the test sets, and a SimulatedClock for the timer that closes the open day.
// Times are built with the local Date constructor, so the midnight cases hold in any
// time zone.

const HERE = dirname(fileURLToPath(import.meta.url));
// Schemas are read, never imported (11.2); the gestures' schemas live with their emitters.
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "journal.changed.json");
const READ = json("queries", "read.json").reply;
const DAY_SAVED = json("..", "journal-entry", "events", "day.saved.json");
const PROJECT_SAVED = json("..", "detector-projects", "events", "detector-project.saved.json");
const PROJECT_SWITCHED = json("..", "detector-projects", "events", "detector-project.switched.json");
const DETECTOR_SAVED = json("..", "detector-editor", "events", "detector.saved.json");
const DETECTOR_SWITCHED = json("..", "detector-list", "events", "detector.switched.json");
const STARTED = json("..", "detector-editor", "events", "removal.started.json");
const UNDONE = json("..", "notice-stack", "events", "removal.undone.json");
const SETTLED = json("..", "notice-stack", "events", "removal.settled.json");
const LLM_CHANGED = json("..", "llm", "events", "llm.changed.json");
const recorded = [];

const D1 = "01K7TEST00000000000000DA01";
const D2 = "01K7TEST00000000000000DA02";
const P = "01K7TEST00000000000000PR01";
const T = "01K7TEST00000000000000DT01";
const Q1 = "01K7TEST00000000000000QQ01";
const Q2 = "01K7TEST00000000000000QQ02";
const O1 = "01K7TEST00000000000000CP01";
const O2 = "01K7TEST00000000000000CP02";
const O3 = "01K7TEST00000000000000CP03";

const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();
const MIN = 60 * 1000;

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore({ days = [], projects = [], detectors = [], answers = [], seed } = {}) {
  const tables = {
    days: new Map(days.map((r) => [r.id, r])),
    projects: new Map(projects.map((r) => [r.id, r])),
    detectors: new Map(detectors.map((r) => [r.id, r])),
    answers: new Map(answers.map((r) => [r.key, r])),
  };
  const meta = new Map(seed === undefined ? [] : [["seed", seed]]);
  const puts = [];
  return {
    tables,
    meta,
    puts,
    all: (t) => Promise.resolve([...tables[t].values()]),
    put: (t, r) => (puts.push([t, r.id]), tables[t].set(r.id, r), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

async function start({ store = fakeStore(), time = at(12, 10), ask } = {}) {
  let now = time;
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, now: () => now, ask }, clock });
  const emitted = [];
  actor.on("journal.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.start();
  await flush();
  const send = (event, schema) => {
    recorded.push({ value: event, schema });
    actor.send(event);
  };
  const read = () => {
    let reply;
    actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
    recorded.push({ value: reply, schema: READ });
    return reply;
  };
  // The wall clock and the timers move together, as they do in a browser.
  const advance = (ms) => {
    now += ms;
    clock.increment(ms);
  };
  const setNow = (t) => (now = t);
  return { actor, store, emitted, send, read, advance, setNow };
}

const write = (s, id, text) => s.send({ type: "day.saved", id, text }, DAY_SAVED);
const remove = (s, kind, id) => s.send({ type: "removal.started", kind, id, name: "" }, STARTED);
const undo = (s, kind, id) => s.send({ type: "removal.undone", kind, id }, UNDONE);
const settle = (s, kind, id) => s.send({ type: "removal.settled", kind, id }, SETTLED);
const opt = (id, name) => ({ id, name, description: "" });
const yn = (id, text) => ({ id, kind: "yesno", text, yes: "", no: "", options: [] });
const pick = (id, text, options) => ({ id, kind: "pick", text, yes: "", no: "", options });
const saveDetector = (s, questions, name = "Tone", project = IDS.goals) =>
  s.send({ type: "detector.saved", id: T, project, name, questions }, DETECTOR_SAVED);
const detector = (s, id) => s.read().detectors.find((d) => d.id === id);

// --- Pure functions -------------------------------------------------------------------

test("a day is open while its date is today, or for an hour after its last edit", () => {
  const day = (d, editedAt) => ({ id: D1, day: d, text: "x", editedAt, version: 1 });
  const lateNight = day("2026-10-11", at(11, 23, 40));
  assert.equal(openDay([lateNight], at(11, 23, 59))?.id, D1, "still its own day");
  assert.equal(openDay([lateNight], at(12, 0, 30))?.id, D1, "just past midnight, edited 50 minutes ago");
  assert.equal(openDay([lateNight], at(12, 0, 39))?.id, D1);
  assert.equal(openDay([lateNight], at(12, 0, 40)), null, "an hour after the last edit, past its date");
  const morning = day("2026-10-12", at(12, 8));
  assert.equal(openDay([morning], at(12, 23, 59))?.id, D1, "an hour gone but its date is today");
  assert.equal(openDay([morning], at(13, 0, 0)), null, "closes at its midnight once the hour is long gone");
  const pastMidnight = day("2026-10-11", at(12, 0, 30));
  assert.equal(openDay([pastMidnight], at(12, 1, 29))?.id, D1, "an edit after midnight keeps it open another hour");
  assert.equal(openDay([pastMidnight], at(12, 1, 30)), null);
  assert.equal(openDay([], at(12, 10)), null);
  assert.equal(dateOf(at(12, 0, 0)), "2026-10-12");
  assert.equal(dateOf(at(11, 23, 59)), "2026-10-11");
});

test("paragraphs end at a line break; the last one is unfinished only while typing", () => {
  const text = "  First one. \n\nSecond\n  third";
  assert.deepEqual(paragraphs(text, false), [
    { text: "First one.", finished: true },
    { text: "Second", finished: true },
    { text: "third", finished: true },
  ]);
  assert.deepEqual(paragraphs(text, true).map((p) => p.finished), [true, true, false]);
  assert.deepEqual(paragraphs("Done\n", true), [{ text: "Done", finished: true }]);
  assert.deepEqual(paragraphs("", true), []);
});

test("a question's wording is what Jev is asked: yes and no words, or the live options", () => {
  const options = [opt(O1, "A"), { ...opt(O2, "B"), removing: true }, opt(O3, "C")];
  assert.deepEqual(wordingOf({ ...yn(Q1, "Kind?"), yes: "warm", no: "cold", options }), { text: "Kind?", yes: "warm", no: "cold", options: [] });
  assert.deepEqual(wordingOf({ ...pick(Q1, "Which?", options), yes: "left over" }), {
    text: "Which?",
    yes: "",
    no: "",
    options: [{ id: O1, name: "A" }, { id: O3, name: "C" }],
  });
});

// --- Days -----------------------------------------------------------------------------

test("a new day is dated at its first character; an empty one is not a day yet", async () => {
  const s = await start({ time: at(12, 23, 50) });
  assert.deepEqual([s.read().days, s.read().open], [[], null], "no day open: an empty page for today");
  write(s, D1, "");
  assert.equal(s.emitted.length, 0);
  write(s, D1, "H");
  const [day] = s.read().days;
  assert.deepEqual({ ...day }, { id: D1, day: "2026-10-12", text: "H", editedAt: at(12, 23, 50), version: 1, waiting: [], unanswered: [] });
  assert.equal(s.read().open, D1);
  assert.deepEqual(s.emitted.at(-1), { type: "journal.changed", ...s.read() });
  assert.deepEqual(s.store.tables.days.get(D1).text, "H", "stored");
  s.advance(15 * MIN);
  write(s, D1, "Hello\nPast midnight");
  assert.equal(s.read().days[0].day, "2026-10-12", "the date never changes");
  assert.equal(s.read().days[0].version, 2, "a version minted locally");
  const n = s.emitted.length;
  write(s, D1, "Hello\nPast midnight");
  assert.equal(s.emitted.length, n, "a repeat announces nothing");
});

test("a save to a day that is not open is refused, and a second day cannot start beside the open one", async () => {
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-10", text: "Old", editedAt: at(10, 21), version: 3 }], seed: SEED_VERSION });
  const s = await start({ store, time: at(12, 9) });
  assert.equal(s.read().open, null);
  write(s, D1, "Old, rewritten");
  assert.equal(s.read().days[0].text, "Old", "a closed day keeps its text");
  assert.equal(s.emitted.length, 0);
  assert.ok(!s.store.puts.some(([t]) => t === "days"), "nothing stored");
  write(s, D2, "Today");
  assert.equal(s.read().open, D2);
  write(s, D1, "Old, again");
  write(s, "01K7TEST00000000000000DA03", "A second today");
  assert.deepEqual(s.read().days.map((d) => [d.id, d.text]), [[D1, "Old"], [D2, "Today"]], "oldest first");
});

test("the open day closes by time alone and the journal says so", async () => {
  const s = await start({ time: at(12, 23, 30) });
  write(s, D1, "Late");
  s.advance(40 * MIN); // 00:10, edited 40 minutes ago
  write(s, D1, "Late\nStill going");
  const n = s.emitted.length;
  s.advance(59 * MIN); // 01:09
  assert.equal(s.emitted.length, n, "still open: nothing to announce");
  assert.equal(s.read().open, D1);
  s.advance(1 * MIN); // 01:10, an hour after the last edit
  assert.equal(s.emitted.length, n + 1);
  assert.equal(s.emitted.at(-1).open, null);
  assert.deepEqual(s.emitted.at(-1), { type: "journal.changed", ...s.read() });
  s.advance(5 * HOUR);
  assert.equal(s.emitted.length, n + 1, "no timer is left running");
  write(s, D1, "Too late");
  assert.equal(s.read().days[0].text, "Late\nStill going");
});

test("a day written in the morning closes at its midnight", async () => {
  const s = await start({ time: at(12, 9) });
  write(s, D1, "Morning");
  const n = s.emitted.length;
  s.advance(at(13, 0) - at(12, 9) - 1);
  assert.equal(s.emitted.length, n);
  s.advance(1);
  assert.equal(s.emitted.length, n + 1);
  assert.equal(s.read().open, null);
});

test("a day loaded while it is still open closes on time", async () => {
  const s = await start({ store: fakeStore({ days: [{ id: D1, day: "2026-10-11", text: "x", editedAt: at(11, 23, 50), version: 1 }] }), time: at(12, 0, 20) });
  assert.equal(s.read().open, D1);
  s.advance(30 * MIN);
  assert.equal(s.read().open, null);
  assert.equal(s.emitted.at(-1).open, null);
});

// --- Projects and detectors -----------------------------------------------------------

test("a first visit starts with the two example projects and their detectors, stored at once", async () => {
  const s = await start();
  const { projects, detectors } = s.read();
  assert.deepEqual(projects.map((p) => [p.id, p.name, p.on, p.version]), [
    [IDS.distortion, "Cognitive Distortion", true, 1],
    [IDS.goals, "Goals and values", true, 1],
  ]);
  assert.deepEqual(detectors.map((d) => [d.project, d.name, d.on]), [
    [IDS.distortion, "Cognitive Distortion", true],
    [IDS.goals, "Goal or value", true],
    [IDS.goals, "Goal or value (yes / no)", false],
  ]);
  assert.equal(detectors[0].questions[0].options.length, 10);
  assert.equal(s.store.meta.get("seed"), SEED_VERSION);
  assert.equal(s.store.tables.projects.size, 2);
  assert.equal(s.store.tables.detectors.size, 3);
  assert.equal(s.emitted.length, 0, "loading announces nothing");
  const ids = [...SEED.projects, ...SEED.detectors].flatMap((r) => [r.id, ...(r.questions ?? []).flatMap((q) => [q.id, ...q.options.map((o) => o.id)])]);
  assert.equal(new Set(ids).size, ids.length, "seed ids are unique");
  const judge = readFileSync(resolve(HERE, "..", "..", "rubrics", "machine.js"), "utf8");
  assert.ok(ids.every((id) => !judge.includes(id)), "and none is one of Judge's");
});

test("the catch-up never brings back a deleted example", async () => {
  const gone = { ...SEED.projects[0], deleted: true, version: 2 };
  const store = fakeStore({ projects: [gone, SEED.projects[1]], detectors: SEED.detectors.slice(1), seed: SEED_VERSION });
  const s = await start({ store });
  assert.deepEqual(s.read().projects.map((p) => p.name), ["Goals and values"]);
  assert.equal(s.read().detectors.length, 2);
  assert.deepEqual(catchUp("projects", [], SEED_VERSION), [], "an emptied journal stays empty");
  assert.equal(catchUp("projects", [], 0).length, 2);
  assert.deepEqual(catchUp("projects", [gone], 0).map((p) => p.id), [IDS.distortion, IDS.goals], "a tombstone keeps its id");
  assert.equal(catchUp("projects", [gone], 0)[0].deleted, true);
});

test("projects: new, renamed, switched; unticking a project keeps each detector's tick", async () => {
  const s = await start();
  s.send({ type: "detector-project.saved", id: P, name: "Mood" }, PROJECT_SAVED);
  assert.deepEqual(s.read().projects.at(-1), { id: P, name: "Mood", on: true, version: 1, removing: false });
  s.send({ type: "detector-project.saved", id: P, name: "Moods" }, PROJECT_SAVED);
  assert.deepEqual([s.read().projects.at(-1).name, s.read().projects.at(-1).version], ["Moods", 2]);
  s.send({ type: "detector-project.switched", id: IDS.goals, on: false }, PROJECT_SWITCHED);
  assert.equal(s.read().projects.find((p) => p.id === IDS.goals).on, false);
  assert.deepEqual(s.read().detectors.filter((d) => d.project === IDS.goals).map((d) => d.on), [true, false]);
  s.send({ type: "detector.switched", id: IDS.goalOrValueYesNo, on: true }, DETECTOR_SWITCHED);
  s.send({ type: "detector-project.switched", id: IDS.goals, on: true }, PROJECT_SWITCHED);
  assert.deepEqual(s.read().detectors.filter((d) => d.project === IDS.goals).map((d) => d.on), [true, true]);
  const n = s.emitted.length;
  s.send({ type: "detector.switched", id: IDS.goalOrValueYesNo, on: true }, DETECTOR_SWITCHED);
  s.send({ type: "detector-project.switched", id: "01K6SEED00000000000000PJ01", on: false }, PROJECT_SWITCHED);
  assert.equal(s.emitted.length, n, "a repeat, or a project that is Judge's, changes nothing");
});

test("a detector is saved into a journal project, switched on, keeping what is in its undo window", async () => {
  const s = await start();
  saveDetector(s, [yn(Q1, "A?"), pick(Q2, "B?", [opt(O1, "x"), opt(O2, "y"), opt(O3, "z")])]);
  assert.deepEqual([detector(s, T).on, detector(s, T).version], [true, 1]);
  s.send({ type: "detector.switched", id: T, on: false }, DETECTOR_SWITCHED);
  remove(s, "question", Q1);
  remove(s, "option", O2);
  assert.equal(detector(s, T).version, 2, "marks are not a new version; the switch was");
  saveDetector(s, [pick(Q2, "B, edited?", [opt(O1, "x"), opt(O3, "z")])]);
  const t = detector(s, T);
  assert.equal(t.on, false, "a save keeps the tick");
  assert.equal(t.version, 3);
  assert.deepEqual(t.questions.map((q) => [q.id, q.removing]), [[Q1, true], [Q2, false]]);
  assert.deepEqual(t.questions[1].options.map((o) => [o.id, o.removing]), [[O1, false], [O2, true], [O3, false]]);
  s.send({ type: "detector.saved", id: "01K7TEST00000000000000DT02", project: "01K6SEED00000000000000PJ01", name: "x", questions: [] }, DETECTOR_SAVED);
  assert.equal(s.read().detectors.length, 4, "a project that is not the journal's takes no detector");
});

test("removing a project, a detector, a question or an option: undo unflags it, settle removes it", async () => {
  for (const [kind, id, find] of [
    ["project", P, (s) => s.read().projects.find((p) => p.id === P)],
    ["rubric", T, (s) => detector(s, T)],
    ["question", Q1, (s) => detector(s, T)?.questions.find((q) => q.id === Q1)],
    ["option", O1, (s) => detector(s, T)?.questions.find((q) => q.id === Q1)?.options.find((o) => o.id === O1)],
  ]) {
    const s = await start();
    s.send({ type: "detector-project.saved", id: P, name: "Mood" }, PROJECT_SAVED);
    saveDetector(s, [pick(Q1, "Which?", [opt(O1, "x"), opt(O2, "y")])], "Tone", P);
    remove(s, kind, id);
    assert.equal(find(s).removing, true, `${kind} is flagged`);
    undo(s, kind, id);
    assert.equal(find(s).removing, false, `${kind} is back`);
    const n = s.emitted.length;
    settle(s, kind, id);
    assert.equal(s.emitted.length, n, `settling an undone ${kind} changes nothing`);
    remove(s, kind, id);
    settle(s, kind, id);
    assert.equal(find(s), undefined, `${kind} is gone`);
    undo(s, kind, id);
    assert.equal(find(s), undefined, `Undo after the ${kind} settled brings nothing back`);
    if (kind === "project") {
      assert.equal(detector(s, T), undefined, "a settled project takes its detectors");
      assert.equal(s.store.tables.projects.get(P).deleted, true, "kept as a tombstone");
      assert.equal(s.store.tables.detectors.get(T).deleted, true);
      s.send({ type: "detector-project.saved", id: P, name: "Back?" }, PROJECT_SAVED);
      assert.equal(s.read().projects.find((p) => p.id === P), undefined, "a deleted id stays deleted");
    }
  }
});

test("a removal that names none of the journal's ids is not this fact's", async () => {
  const s = await start();
  remove(s, "project", "01K6SEED00000000000000PJ01");
  remove(s, "rubric", "01K6SEED00000000000000RB01");
  remove(s, "case", IDS.goals);
  remove(s, "rubric", IDS.goals);
  assert.equal(s.emitted.length, 0);
});

test("at load every leftover removing flag is settled", async () => {
  const store = fakeStore({
    projects: [{ ...SEED.projects[0], removing: true }, SEED.projects[1]],
    detectors: [
      SEED.detectors[0],
      { ...SEED.detectors[1], questions: [{ ...SEED.detectors[1].questions[0], options: SEED.detectors[1].questions[0].options.map((o, i) => ({ ...o, removing: i === 2 })) }] },
      { ...SEED.detectors[2], questions: [{ ...SEED.detectors[2].questions[0], removing: true }, SEED.detectors[2].questions[1]] },
    ],
    seed: SEED_VERSION,
  });
  const s = await start({ store });
  assert.deepEqual(s.read().projects.map((p) => p.name), ["Goals and values"]);
  assert.deepEqual(s.read().detectors.map((d) => d.id), [IDS.goalOrValue, IDS.goalOrValueYesNo]);
  assert.deepEqual(s.read().detectors[0].questions[0].options.map((o) => o.name), ["Goal", "Value"]);
  assert.deepEqual(s.read().detectors[1].questions.map((q) => q.id), [IDS.isValue]);
  assert.equal(store.tables.projects.get(IDS.distortion).deleted, true, "the settle is stored");
  assert.equal(store.tables.detectors.get(IDS.goalOrValue).version, 2);
});

// --- Why Jev is not reading, and what is not answered ---------------------------------

const picture = (signedIn, keySet) => ({
  signedIn, provider: "anthropic", providers: [], model: "m", models: [], effort: "low", efforts: [], ttl: "5m", jev: { keySet },
});

test("why Jev is not reading: signed out, no key, no detector on", async () => {
  assert.equal((await start()).read().reason, "signed-out", "no llm answer reads as signed out");
  const s = await start({ ask: async (target, name) => (target === "llm" && name === "read" ? picture(true, false) : { error: "no-answerer" }) });
  assert.equal(s.read().reason, "no-key");
  s.send({ type: "llm.changed", ...picture(true, true) }, LLM_CHANGED);
  assert.equal(s.read().reason, null);
  assert.equal(s.emitted.at(-1).reason, null, "a change of reason is announced");
  const n = s.emitted.length;
  s.send({ type: "llm.changed", ...picture(true, true), model: "other" }, LLM_CHANGED);
  assert.equal(s.emitted.length, n, "llm news that leaves the reason alone is not");
  s.send({ type: "detector-project.switched", id: IDS.distortion, on: false }, PROJECT_SWITCHED);
  s.send({ type: "detector.switched", id: IDS.goalOrValue, on: false }, DETECTOR_SWITCHED);
  assert.equal(s.read().reason, "no-detector");
});

test("earlier days list their finished paragraphs no detector on has answered", async () => {
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-10", text: "One\n\nTwo\nOne", editedAt: at(10, 20), version: 1 }] });
  const s = await start({ store, time: at(12, 9) });
  assert.deepEqual(s.read().days[0].unanswered, ["One", "Two"]);
  write(s, D2, "Today\nunfinished");
  assert.deepEqual(s.read().days[1].unanswered, ["Today"], "the open day's last line is still being written");
  for (const id of [IDS.distortion, IDS.goals]) s.send({ type: "detector-project.switched", id, on: false }, PROJECT_SWITCHED);
  assert.deepEqual(s.read().days[0].unanswered, [], "nothing on, nothing to ask");
});

test("an answer keeps its wording and is marked earlier once the question is reworded", async () => {
  const q = SEED.detectors[1].questions[0];
  const answer = { key: `${q.id}\nOne`, text: "One", wording: wordingOf(q), answer: { id: q.id, p: 0.9, choice: q.options[0].id }, at: at(10, 20) };
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-10", text: "One", editedAt: at(10, 20), version: 1 }], answers: [answer] });
  const s = await start({ store, time: at(12, 9) });
  assert.deepEqual(s.read().answers, [{ text: "One", wording: wordingOf(q), answer: answer.answer, at: at(10, 20), earlier: false }]);
  s.send({ type: "detector-project.switched", id: IDS.distortion, on: false }, PROJECT_SWITCHED);
  assert.deepEqual(s.read().days[0].unanswered, [], "answered with the current wording");
  const reworded = { ...q, text: "Goal, value or neither?" };
  s.send({ type: "detector.saved", id: IDS.goalOrValue, project: IDS.goals, name: "Goal or value", questions: [reworded].map(({ removing, ...x }) => ({ ...x, options: x.options.map(({ removing: _, ...o }) => o) })) }, DETECTOR_SAVED);
  assert.equal(s.read().answers[0].earlier, true);
  assert.deepEqual(s.read().answers[0].wording.text, "Is this a goal, a value, or neither?", "the old wording is kept");
  assert.deepEqual(s.read().days[0].unanswered, ["One"]);
});

test("a gesture or a read that arrives while the store loads is applied once it is ready", async () => {
  let open;
  const store = fakeStore();
  const gate = new Promise((r) => (open = r));
  const all = store.all;
  store.all = async (t) => (await gate, all(t));
  const actor = createActor(machine, { input: { store, now: () => at(12, 10) }, clock: new SimulatedClock() });
  let reply;
  actor.start();
  actor.send({ type: "day.saved", id: D1, text: "Early" });
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  assert.equal(reply, undefined);
  open();
  await flush();
  assert.equal(reply.days[0].text, "Early");
  assert.equal(reply.projects.length, 2);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
