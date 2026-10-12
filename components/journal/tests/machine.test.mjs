import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, openDay, paragraphs, wordingOf, dateOf, catchUp, SEED, SEED_VERSION, IDS, HOUR, BUSY_RETRY_MS } from "../machine.js";

// The actor is where the journal's decisions live (3.2): it is driven with a fake store,
// a clock the test sets, and a SimulatedClock for the timer that closes the open day.
// Times are built with the local Date constructor, so the midnight cases hold in any
// time zone.

const HERE = dirname(fileURLToPath(import.meta.url));
// Schemas are read, never imported (11.2); the gestures' schemas live with their emitters.
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "journal.changed.json");
const CONFLICTED = json("events", "journal.conflicted.json");
const SESSION_CHANGED = json("..", "session", "events", "session.changed.json");
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

function fakeStore({ days = [], projects = [], detectors = [], answers = [], seed, userId } = {}) {
  const tables = {
    days: new Map(days.map((r) => [r.id, r])),
    projects: new Map(projects.map((r) => [r.id, r])),
    detectors: new Map(detectors.map((r) => [r.id, r])),
    answers: new Map(answers.map((r) => [r.key, r])),
  };
  const meta = new Map([...(seed === undefined ? [] : [["seed", seed]]), ...(userId === undefined ? [] : [["userId", userId]])]);
  const outbox = new Map();
  const puts = [];
  return {
    tables,
    meta,
    outbox,
    puts,
    all: (t) => Promise.resolve([...tables[t].values()]),
    put: (t, r) => (puts.push([t, r.key ?? r.id]), tables[t].set(r.key ?? r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (row) => (outbox.set(row.key, row), Promise.resolve()),
    outboxDelete: (key) => (outbox.delete(key), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

async function start({ store = fakeStore(), time = at(12, 10), ask, api } = {}) {
  let now = time;
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, now: () => now, ask, api }, clock });
  const emitted = [];
  const conflicted = [];
  actor.on("journal.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.on("journal.conflicted", (e) => {
    conflicted.push(e);
    recorded.push({ value: e, schema: CONFLICTED });
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
  return { actor, store, emitted, conflicted, send, read, advance, setNow };
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

// --- Asking Jev -----------------------------------------------------------------------

const DECIDE = json("..", "llm", "queries", "decide.json");

// A stand-in for llm: signed in with a key, each decide held open until the test answers
// it, so the order of requests is visible.
function fakeJev(llm = picture(true, true)) {
  const asked = [];
  const open = [];
  const ask = async (target, name, payload) => {
    if (target === "llm" && name === "read") return llm;
    if (target !== "llm" || name !== "decide") return { error: "no-answerer" };
    recorded.push({ value: payload, schema: DECIDE.payload });
    asked.push(payload);
    return new Promise((resolve) => open.push({ payload, resolve }));
  };
  const reply = async (value) => {
    if (!value.error || value.error === "busy") recorded.push({ value, schema: DECIDE.reply });
    open.shift().resolve(value);
    await flush();
  };
  // Answers every question of the oldest open request.
  const answer = (p = 0.7) =>
    reply({
      answers: open[0].payload.questions.map((q) =>
        q.kind === "pick"
          ? { id: q.id, p, choice: q.options[0].id, probabilities: q.options.map((o, i) => ({ id: o.id, p: i ? 0 : p })), confidence: 0.5 }
          : { id: q.id, p },
      ),
      inputTokens: 10,
      ms: 5,
    });
  return { ask, asked, open, reply, answer, fail: (error) => reply({ error }) };
}

const texts = (jev) => jev.asked.map((p) => p.state.text);
const leave = (s, id, text) => s.send({ type: "day.saved", id, text, left: true }, DAY_SAVED);
const judgeDay = (s, id) => s.send({ type: "day.judging.requested", id }, JUDGING);
const JUDGING = json("..", "journal-entry", "events", "day.judging.requested.json");
const ON = [IDS.distortionPick, IDS.goalOrValuePick];

test("each finished paragraph is asked once, one at a time, with every question on across projects", async () => {
  const jev = fakeJev();
  const s = await start({ ask: jev.ask });
  assert.equal(s.read().reason, null);
  write(s, D1, "One\nTwo\nOne\nstill typing");
  await flush();
  assert.deepEqual(texts(jev), ["One"], "one request open at a time");
  assert.deepEqual(jev.asked[0].questions.map((q) => q.id), ON, "both projects' questions in the one request");
  assert.equal(jev.asked[0].questions[0].options.length, 10);
  assert.deepEqual(s.read().days[0].waiting, ["One", "Two"], "a paragraph written twice is asked once");
  assert.deepEqual(s.emitted.at(-1).days[0].waiting, ["One", "Two"]);
  write(s, D1, "One\nTwo\nOne\nstill typing more");
  await flush();
  assert.equal(jev.asked.length, 1, "typing on does not queue the paragraph being asked again");
  await jev.answer();
  assert.deepEqual(texts(jev), ["One", "Two"]);
  assert.deepEqual(s.read().days[0].waiting, ["Two"]);
  await jev.answer(0.4);
  assert.deepEqual(texts(jev), ["One", "Two"], "nothing left to ask");
  const { days, answers } = s.read();
  assert.deepEqual([days[0].waiting, days[0].unanswered], [[], []]);
  assert.deepEqual(answers.map((a) => [a.text, a.answer.id, a.earlier]), [
    ["One", IDS.distortionPick, false],
    ["One", IDS.goalOrValuePick, false],
    ["Two", IDS.distortionPick, false],
    ["Two", IDS.goalOrValuePick, false],
  ]);
  const goal = SEED.detectors[1].questions[0];
  const two = answers.find((a) => a.text === "Two" && a.answer.id === goal.id);
  assert.deepEqual(two.wording, wordingOf(goal), "the wording it was asked with");
  assert.deepEqual(two.answer, { id: goal.id, p: 0.4, choice: goal.options[0].id, probabilities: goal.options.map((o, i) => ({ id: o.id, p: i ? 0 : 0.4 })), confidence: 0.5 });
  assert.ok(s.store.outbox.has(`answers\n${goal.id}\nTwo`), "answers go up through the outbox");
  assert.equal(s.store.tables.answers.size, 4, "and are stored");
  write(s, D1, "One\nTwo\nOne\nstill typing more\n");
  await flush();
  assert.deepEqual(texts(jev).at(-1), "still typing more", "a new paragraph is asked; the answered ones are not");
  assert.equal(jev.asked.length, 3);
});

test("leaving the writing box finishes the last paragraph; typing again unfinishes it", async () => {
  const jev = fakeJev();
  const s = await start({ ask: jev.ask });
  write(s, D1, "First");
  await flush();
  assert.deepEqual([jev.asked.length, s.read().days[0].unanswered], [0, []], "the last line is still being written");
  leave(s, D1, "First");
  await flush();
  assert.deepEqual(texts(jev), ["First"], "left: the same text, now finished");
  assert.deepEqual(s.read().days[0].waiting, ["First"]);
  write(s, D1, "First\nSecond");
  await jev.answer();
  assert.equal(jev.asked.length, 1, "back in the box, the last line is unfinished again");
  assert.deepEqual(s.read().days[0].unanswered, []);
  leave(s, D1, "First\nSecond");
  await flush();
  assert.deepEqual(texts(jev), ["First", "Second"]);
});

test("rewording a question re-asks today; an earlier day keeps its answer until Judge this day", async () => {
  const goal = SEED.detectors[1].questions[0];
  const distortion = SEED.detectors[0].questions[0];
  const old = (q) => ({ key: `${q.id}\nOld`, text: "Old", wording: wordingOf(q), answer: { id: q.id, p: 0.9, choice: q.options[1].id }, at: at(10, 20), version: 1 });
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-10", text: "Old", editedAt: at(10, 20), version: 1 }], answers: [old(goal), old(distortion)] });
  const jev = fakeJev();
  const s = await start({ store, ask: jev.ask });
  write(s, D2, "New\n");
  await flush();
  await jev.answer();
  assert.deepEqual(texts(jev), ["New"]);
  const reworded = { ...goal, text: "Goal, value or neither?" };
  s.send({ type: "detector.saved", id: IDS.goalOrValue, project: IDS.goals, name: "Goal or value", questions: [reworded].map(({ removing, ...x }) => ({ ...x, options: x.options.map(({ removing: _, ...o }) => o) })) }, DETECTOR_SAVED);
  await flush();
  assert.deepEqual(texts(jev), ["New", "New"], "today is asked again; the earlier day is not");
  assert.equal(jev.asked[1].questions[1].instructions, "Goal, value or neither?");
  await jev.answer();
  const of = (text) => s.read().answers.filter((a) => a.text === text && a.answer.id === goal.id);
  assert.deepEqual(of("New").map((a) => [a.earlier, a.wording.text]), [[false, "Goal, value or neither?"]], "the new answer replaces the old one");
  assert.deepEqual(of("Old").map((a) => [a.earlier, a.wording.text, a.answer.p]), [[true, "Is this a goal, a value, or neither?", 0.9]], "kept, marked earlier");
  assert.deepEqual(s.read().days[0].unanswered, ["Old"]);
  assert.deepEqual(s.read().days[0].waiting, []);
  judgeDay(s, D1);
  await flush();
  assert.deepEqual(texts(jev).at(-1), "Old");
  assert.deepEqual(s.read().days[0].waiting, ["Old"]);
  await jev.answer(0.2);
  assert.deepEqual(of("Old").map((a) => [a.earlier, a.answer.p]), [[false, 0.2]]);
  assert.deepEqual(s.read().days[0].unanswered, []);
  assert.equal(jev.asked.length, 3);
});

test("Judge this day asks an earlier day's paragraphs in order, each once", async () => {
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-10", text: "A\nB\nA\nC", editedAt: at(10, 20), version: 1 }] });
  const jev = fakeJev();
  const s = await start({ store, ask: jev.ask });
  assert.deepEqual([jev.asked.length, s.read().days[0].waiting], [0, []], "an earlier day is never asked by itself");
  judgeDay(s, D1);
  judgeDay(s, D1);
  await flush();
  assert.deepEqual(s.read().days[0].waiting, ["A", "B", "C"]);
  await jev.answer();
  judgeDay(s, D1);
  await jev.answer();
  await jev.answer();
  await flush();
  assert.deepEqual(texts(jev), ["A", "B", "C"], "pressed again mid-way, nothing is asked twice");
  assert.deepEqual(s.read().days[0].unanswered, []);
});

test("llm busy with another decide: the queue waits and tries again", async () => {
  const jev = fakeJev();
  const s = await start({ ask: jev.ask });
  write(s, D1, "One\n");
  await flush();
  await jev.fail("busy");
  assert.equal(jev.asked.length, 1);
  assert.deepEqual([s.read().reason, s.read().days[0].waiting], [null, ["One"]], "still waiting, no reason shown");
  s.advance(BUSY_RETRY_MS);
  await flush();
  assert.deepEqual(texts(jev), ["One", "One"]);
  await jev.answer();
  assert.equal(s.read().answers.length, 2);
});

test("an error stops the queue with decide's reason; a later gesture resumes it", async () => {
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-10", text: "Earlier", editedAt: at(10, 20), version: 1 }] });
  const jev = fakeJev();
  const s = await start({ store, ask: jev.ask });
  write(s, D2, "One\nTwo\n");
  judgeDay(s, D1);
  await flush();
  assert.deepEqual(s.read().days.map((d) => d.waiting), [["Earlier"], ["One", "Two"]]);
  await jev.fail("rate-limited");
  assert.equal(s.read().reason, "rate-limited");
  assert.deepEqual(s.read().days.map((d) => d.waiting), [[], []], "nothing waits once stopped");
  assert.equal(s.emitted.at(-1).reason, "rate-limited");
  s.advance(10 * BUSY_RETRY_MS);
  await flush();
  assert.equal(jev.asked.length, 1, "no retry by itself");
  leave(s, D2, "One\nTwo\n");
  await flush();
  assert.equal(s.read().reason, null, "a save resumes it");
  assert.deepEqual(texts(jev), ["One", "One"]);
  assert.deepEqual(s.read().days[1].waiting, ["One", "Two"], "the open day's paragraphs, not the earlier day's");
  await jev.fail("no-answerer");
  assert.equal(s.read().reason, "unavailable", "the bus's own refusal is unavailable");
  s.send({ type: "llm.changed", ...picture(true, true) }, LLM_CHANGED);
  await flush();
  assert.equal(jev.asked.length, 3, "news from llm resumes it");
  await jev.answer();
  await jev.answer();
  assert.deepEqual(texts(jev), ["One", "One", "One", "Two"]);
  s.send({ type: "llm.changed", ...picture(true, false), jev: { keySet: false, starterLeft: 0 } }, LLM_CHANGED);
  write(s, D2, "One\nTwo\nThree\n");
  await flush();
  assert.deepEqual([s.read().reason, jev.asked.length], ["no-key", 4], "starter requests used up: no key, nothing sent");
});

test("ticking a project or a detector on asks today's paragraphs again", async () => {
  const jev = fakeJev();
  const s = await start({ ask: jev.ask });
  s.send({ type: "detector-project.switched", id: IDS.goals, on: false }, PROJECT_SWITCHED);
  write(s, D1, "One\n");
  await flush();
  assert.deepEqual(jev.asked[0].questions.map((q) => q.id), [IDS.distortionPick]);
  await jev.answer();
  s.send({ type: "detector-project.switched", id: IDS.goals, on: true }, PROJECT_SWITCHED);
  await flush();
  assert.deepEqual(jev.asked[1].questions.map((q) => q.id), ON, "every question on, in the one request");
  await jev.answer();
  s.send({ type: "detector.switched", id: IDS.goalOrValueYesNo, on: true }, DETECTOR_SWITCHED);
  await flush();
  assert.deepEqual(jev.asked[2].questions.map((q) => [q.id, q.kind]), [
    [IDS.distortionPick, "pick"],
    [IDS.goalOrValuePick, "pick"],
    [IDS.isGoal, "yesno"],
    [IDS.isValue, "yesno"],
  ]);
  await jev.answer(0.8);
  assert.equal(s.read().answers.length, 4);
  assert.equal(jev.asked.length, 3);
});

test("signed out, nothing is sent", async () => {
  const jev = fakeJev(picture(false, false));
  const s = await start({ ask: jev.ask });
  leave(s, D1, "One\nTwo");
  await flush();
  assert.deepEqual([jev.asked.length, s.read().reason, s.read().days[0].waiting], [0, "signed-out", []]);
});

// --- Sync (5) -------------------------------------------------------------------------

// A stand-in for journal's server module, keeping its rules: a new record continues from
// the base it was sent on, a day on a stale base is a conflict, every other kind is last
// write wins, and the pull returns what changed since a cursor.
function fakeServer() {
  const tables = { days: new Map(), projects: new Map(), detectors: new Map(), answers: new Map() };
  const puts = [];
  let seq = 0;
  const keyOf = (table, r) => (table === "answers" ? `${r.answer.id}\n${r.text}` : r.id);
  const out = ({ seq: _, ...r }) => structuredClone(r);
  const held = (table, id) => tables[table].get(id);
  const set = (table, record, version, deleted = false) => {
    const r = { ...structuredClone(record), version, deleted, seq: ++seq };
    tables[table].set(keyOf(table, record), r);
    return out(r);
  };
  const api = {
    async put(row) {
      puts.push(structuredClone(row));
      const was = held(row.table, keyOf(row.table, row.record));
      if (!was) return { record: set(row.table, row.record, (row.baseVersion ?? 0) + 1, Boolean(row.deleted)) };
      if (row.deleted) return { record: was.deleted ? out(was) : set(row.table, row.record, was.version + 1, true) };
      if (was.deleted) return row.table === "days" ? { conflict: true, record: out(was) } : { record: out(was) };
      const { version: _v, deleted: _d, seq: _s, ...content } = was;
      if (same(content, row.record)) return { record: out(was) };
      if (row.table === "days" && row.baseVersion !== was.version) return { conflict: true, record: out(was) };
      return { record: set(row.table, row.record, was.version + 1) };
    },
    async pull(since) {
      const pulled = Object.fromEntries(
        Object.entries(tables).map(([t, m]) => [t, [...m.values()].filter((r) => r.seq > since).map(out)]),
      );
      return { ...pulled, cursor: seq };
    },
  };
  // Another device's write, straight into the server.
  const other = (table, record) => set(table, record, (held(table, keyOf(table, record))?.version ?? 0) + 1);
  return { api, puts, held, other };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const signedIn = (userId) => async (target, name) =>
  target === "session" && name === "read" ? { userId, registrationOpen: false } : { error: "no-answerer" };
const IDLE = 2000;

test("signed in, a run of saves goes up once typing pauses, as one write per record", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore({ userId: "u1" }), ask: signedIn("u1"), api: server.api });
  assert.deepEqual(server.puts, [], "nothing changed, so nothing goes up: the examples are every device's own");
  write(s, D1, "One");
  write(s, D1, "One\nTwo");
  s.send({ type: "detector-project.switched", id: IDS.goals, on: false }, PROJECT_SWITCHED);
  s.send({ type: "detector-project.switched", id: IDS.goals, on: true }, PROJECT_SWITCHED);
  s.send({ type: "detector-project.switched", id: IDS.goals, on: false }, PROJECT_SWITCHED);
  s.advance(IDLE - 1);
  await flush();
  assert.deepEqual(server.puts, [], "still inside the pause");
  write(s, D1, "One\nTwo\nThree");
  s.advance(IDLE - 1);
  await flush();
  assert.deepEqual(server.puts, [], "a save restarts the pause");
  s.advance(1);
  await flush();
  assert.deepEqual(server.puts.map((r) => r.key).sort(), [`days\n${D1}`, `projects\n${IDS.goals}`]);
  const day = server.puts.find((r) => r.table === "days");
  assert.equal(day.record.text, "One\nTwo\nThree");
  assert.equal(day.baseVersion, null, "a new day");
  assert.equal(server.puts.find((r) => r.table === "projects").baseVersion, 1, "the version the first unsynced change was on");
  assert.equal(s.store.outbox.size, 0, "acknowledged rows are gone");
  assert.equal(s.read().days[0].version, 1, "the server's version");
});

test("a tab going to the background drains at once, without waiting for the pause", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore({ userId: "u1" }), ask: signedIn("u1"), api: server.api });
  write(s, D1, "One");
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.equal(server.puts.length, 1);
  assert.equal(s.store.outbox.size, 0);
});

test("a day written on a version another device moved past comes back as a conflict with both copies", async () => {
  const server = fakeServer();
  server.other("days", { id: D1, day: "2026-10-12", text: "Morning", editedAt: at(12, 9) });
  const store = fakeStore({ userId: "u1", days: [{ id: D1, day: "2026-10-12", text: "Morning", editedAt: at(12, 9), version: 1 }] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  server.other("days", { id: D1, day: "2026-10-12", text: "Morning\nFrom the phone", editedAt: at(12, 9, 30) });
  write(s, D1, "Morning\nFrom the laptop");
  s.advance(IDLE);
  await flush();
  assert.equal(server.puts.at(-1).baseVersion, 1);
  assert.deepEqual(s.conflicted.map(({ type, ...e }) => e), [
    {
      id: D1,
      mine: { text: "Morning\nFrom the laptop", baseVersion: 1 },
      theirs: { text: "Morning\nFrom the phone", version: 2, editedAt: at(12, 9, 30) },
    },
  ]);
  assert.equal(s.read().days[0].text, "Morning\nFrom the phone", "the server's copy is kept");
  assert.equal(s.read().days[0].version, 2);
  assert.equal(s.store.outbox.size, 0);
});

test("a detector is last write wins: a write on an old version replaces the server's, never a conflict", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore({ userId: "u1" }), ask: signedIn("u1"), api: server.api });
  const seed = SEED.detectors[2];
  const { removing: _, version: __, ...record } = structuredClone(seed);
  record.questions = record.questions.map(({ removing: _r, ...q }) => ({ ...q, options: [] }));
  server.other("detectors", { ...record, name: "Renamed on the phone" });
  server.other("detectors", { ...record, name: "Renamed again" });
  s.send({ type: "detector.switched", id: seed.id, on: true }, DETECTOR_SWITCHED);
  s.advance(IDLE);
  await flush();
  assert.equal(server.puts.at(-1).baseVersion, 1, "written on the version this device held");
  assert.deepEqual(s.conflicted, []);
  assert.equal(server.held("detectors", seed.id).version, 3);
  assert.equal(server.held("detectors", seed.id).name, "Goal or value (yes / no)", "this device's write is the last");
  assert.equal(detector(s, seed.id).version, 3);
  assert.equal(detector(s, seed.id).on, true);
  server.other("detectors", { ...record, name: "From the phone", on: true });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(detector(s, seed.id).name, "From the phone", "a tab regaining focus pulls the newer copy");
  assert.equal(detector(s, seed.id).version, 4);
});

test("signing in moves the journal kept in this browser to the account, with its history", async () => {
  const server = fakeServer();
  const s = await start({ store: fakeStore(), api: server.api });
  write(s, D1, "One");
  write(s, D1, "One\nTwo");
  s.send({ type: "detector-project.switched", id: IDS.goals, on: false }, PROJECT_SWITCHED);
  s.advance(IDLE);
  await flush();
  assert.deepEqual(server.puts, [], "signed out, nothing goes up");
  assert.equal(s.read().days[0].version, 2, "versions numbered in the browser");
  s.send({ type: "session.changed", userId: "u1" }, SESSION_CHANGED);
  await flush();
  assert.deepEqual(server.puts.map((r) => [r.key, r.baseVersion]).sort(), [
    [`days\n${D1}`, 2],
    [`projects\n${IDS.goals}`, 2],
  ], "every changed record, on the version it holds; the untouched examples stay");
  assert.equal(server.held("days", D1).version, 3, "the server continues the browser's history");
  assert.equal(s.read().days[0].version, 3);
  assert.equal(s.store.meta.get("userId"), "u1");
  s.send({ type: "session.changed", userId: null }, SESSION_CHANGED);
  write(s, D1, "One\nTwo\nThree");
  s.advance(IDLE);
  await flush();
  assert.equal(server.puts.length, 2, "signed out again, the change waits");
  assert.equal(s.store.outbox.size, 1);
  s.send({ type: "session.changed", userId: "u1" }, SESSION_CHANGED);
  await flush();
  assert.equal(server.held("days", D1).text, "One\nTwo\nThree", "and goes up at the next sign-in");
  assert.equal(s.store.outbox.size, 0);
});

test("a browser signed in elsewhere since it last synced adopts its journal at load", async () => {
  const server = fakeServer();
  const store = fakeStore({ days: [{ id: D1, day: "2026-10-12", text: "Kept here", editedAt: at(12, 9), version: 1 }] });
  const s = await start({ store, ask: signedIn("u1"), api: server.api });
  await flush();
  assert.equal(server.held("days", D1).text, "Kept here");
  assert.equal(s.read().days[0].version, 2);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
