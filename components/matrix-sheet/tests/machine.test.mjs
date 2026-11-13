import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, shownPlace, ordered, neighbor, tagOf, cardOf, copiedLabel, linesOf, taskKey, pathTarget, dayName } from "../machine.js";

// matrix-sheet's decisions, against the machine alone: what it saves for each gesture, what a
// new day's matrix starts as, what follows the fact, and where its keys go.

const SCHEMA = new Validator(JSON.parse(readFileSync(new URL("../events/matrix.saved.json", import.meta.url), "utf8")), "2020-12");

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const TODAY = "2026-10-14";
const EARLIER = "2026-10-12";
const OLD = "01K6TEST000000000000000MX0";
const KEPT = "01K6TEST000000000000000MX1";
const T1 = "01K6TEST000000000000000TA1";
const T2 = "01K6TEST000000000000000TA2";
const T3 = "01K6TEST000000000000000TA3";

const task = (id, text, over = {}) => ({ id, text, place: null, done: false, ...over });
const matrix = (id, day, tasks, over = {}) => ({ id, day, tasks, createdAt: "2026-10-12T08:00:00.000Z", version: 1, pending: false, ...over });

const flush = () => new Promise((r) => setTimeout(r, 0));

async function start(matrices = [], { reply, vimKeys } = {}) {
  let n = 0;
  const asked = [];
  const sent = [];
  const actor = createActor(machine, {
    input: {
      ask: (target, name, payload) => {
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        asked.push({ target, name, payload });
        return Promise.resolve(reply ?? { matrices: payload.day ? matrices.filter((m) => m.day === payload.day) : matrices, total: matrices.length });
      },
      send: (target, name, payload) => sent.push({ target, name, payload }),
      mint: () => `01K6TEST000000000000000N${String(++n).padStart(2, "0")}`,
      now: () => NOW,
    },
  });
  const emitted = [];
  actor.on("matrix.saved", (e) => {
    const { type, ...payload } = e;
    assert.ok(SCHEMA.validate(payload).valid, JSON.stringify(payload));
    emitted.push(e);
  });
  actor.start();
  await flush();
  return { actor, emitted, asked, sent, ctx: () => actor.getSnapshot().context };
}

test("a task shows at the place the user chose, else at its suggestion, else in To sort, and the keyboard walks To sort first", () => {
  const placed = task(T1, "A", { place: "drop", suggested: { place: "do", sure: true } });
  const suggested = task(T2, "B", { suggested: { place: "schedule", sure: false } });
  const neither = task(T3, "C");
  assert.deepEqual([placed, suggested, neither].map(shownPlace), ["drop", "schedule", null]);
  assert.deepEqual(ordered([placed, suggested, neither]).map((t) => t.id), [T3, T2, T1]);
  assert.equal(tagOf(placed), null, "a place the user chose has no tag");
  assert.deepEqual(tagOf(suggested), { label: "Not sure", sure: false, title: "Suggested: not urgent, important, not sure" });
  assert.equal(tagOf(task(T1, "A", { suggested: { place: "do", sure: true } })).label, "Suggested");
  assert.equal(tagOf(neither), null);
});

test("the very first matrix starts empty, is not kept until it holds a task, and folding it empty leaves nothing", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "add" });
  assert.deepEqual(ctx().fresh, { id: "01K6TEST000000000000000N01", day: TODAY, tasks: [] });
  assert.equal(ctx().open, true);
  assert.equal(ctx().landing, 1);
  assert.equal(emitted.length, 0);
  actor.send({ type: "_fold" });
  assert.equal(ctx().fresh, null);
  actor.send({ type: "add" });
  actor.send({ type: "_draft", text: "Call" });
  actor.send({ type: "_add", text: "Call the bank" });
  assert.equal(ctx().adding, "");
  assert.deepEqual(emitted.at(-1), {
    type: "matrix.saved",
    id: "01K6TEST000000000000000N02",
    day: TODAY,
    tasks: [{ id: "01K6TEST000000000000000N03", text: "Call the bank", place: null, done: false }],
    finished: true,
  });
});

test("adding on a new day copies the newest earlier matrix without its ticked tasks, saved at once with the day it came from", async () => {
  const older = matrix(OLD, "2026-10-01", [task(T1, "Old")]);
  const newest = matrix("01K6TEST000000000000000MX2", EARLIER, [task(T1, "Keep", { place: "do" }), task(T2, "Ticked", { done: true }), task(T3, "Sugg", { suggested: { place: "drop", sure: true } })]);
  const { actor, emitted, ctx } = await start([older, newest]);
  actor.send({ type: "add" });
  assert.deepEqual(emitted, [
    {
      type: "matrix.saved",
      id: "01K6TEST000000000000000N01",
      day: TODAY,
      from: EARLIER,
      tasks: [
        { id: T1, text: "Keep", place: "do", done: false },
        { id: T3, text: "Sugg", place: null, done: false },
      ],
      finished: true,
    },
  ]);
  assert.equal(ctx().fresh.tasks[1].suggested.place, "drop", "the sheet shows the copied suggestion until the fact says");
  assert.equal(copiedLabel(ctx(), ctx().fresh), "Copied from your matrix of 12 October, without the ticked tasks.");
  actor.send({ type: "matrix.changed", matrix: matrix("01K6TEST000000000000000N01", TODAY, ctx().fresh.tasks, { from: EARLIER }) });
  assert.equal(ctx().fresh, null, "what the fact keeps replaces it");
  actor.send({ type: "_fold" });
  actor.send({ type: "add" });
  assert.equal(emitted.length, 1, "a day holds one matrix: add opens the one it has");
  assert.equal(ctx().open, true);
});

test("a copy of a matrix whose tasks were all ticked starts empty and names no day", async () => {
  const { actor, emitted, ctx } = await start([matrix(OLD, EARLIER, [task(T1, "Done", { done: true })])]);
  actor.send({ type: "add" });
  assert.deepEqual(ctx().fresh, { id: "01K6TEST000000000000000N01", day: TODAY, tasks: [] });
  assert.equal(emitted.length, 0);
});

test("each gesture is one save that says finished: tick, place, a neighbor, new words, delete", async () => {
  const { actor, emitted, ctx } = await start([matrix(KEPT, TODAY, [task(T1, "A", { suggested: { place: "do", sure: true } }), task(T2, "B")])]);
  actor.send({ type: "_open" });
  const last = () => emitted.at(-1).tasks;
  actor.send({ type: "_tick", id: T1 });
  assert.equal(last()[0].done, true);
  assert.equal(last()[0].suggested, undefined, "the suggestion is the fact's and is never sent");
  actor.send({ type: "_placing", id: T2 });
  assert.equal(ctx().placing, T2);
  actor.send({ type: "_place", id: T2, place: "delegate" });
  assert.equal(last()[1].place, "delegate");
  assert.equal(ctx().placing, null, "a place picked closes the places");
  actor.send({ type: "_move", id: T1, dir: "right" });
  assert.equal(last()[0].place, "schedule", "right of Do, the suggested place, is Schedule");
  actor.send({ type: "_move", id: T1, dir: "left" });
  assert.equal(last()[0].place, "do", "and left brings it back");
  const count = emitted.length;
  actor.send({ type: "_move", id: T1, dir: "left" });
  assert.equal(emitted.length, count, "a move that stays sends nothing");
  actor.send({ type: "_edit", id: T2 });
  actor.send({ type: "_words", id: T2, text: "  " });
  assert.equal(emitted.length, count, "empty words keep the old ones");
  actor.send({ type: "_edit", id: T2 });
  actor.send({ type: "_words", id: T2, text: "B, sooner" });
  assert.equal(last()[1].text, "B, sooner");
  assert.equal(ctx().editing, null);
  actor.send({ type: "_delete", id: T1 });
  assert.deepEqual(last().map((t) => t.id), [T2]);
  actor.send({ type: "_delete", id: T2 });
  assert.deepEqual(last(), [], "the last delete sends no task, which takes the matrix away");
  assert.ok(emitted.every((e) => e.finished === true && e.id === KEPT));
});

test("pasted lines add one task each and keep what was typed; empty lines add nothing", async () => {
  assert.deepEqual(linesOf("one\r\n\n  two  \n"), ["one", "two"]);
  const { actor, emitted, ctx } = await start([matrix(KEPT, TODAY, [task(T1, "A")])]);
  actor.send({ type: "_open" });
  actor.send({ type: "_draft", text: "typed" });
  actor.send({ type: "_add", text: "one\ntwo", pasted: true });
  assert.deepEqual(emitted.at(-1).tasks.map((t) => t.text), ["A", "one", "two"]);
  assert.equal(ctx().adding, "typed");
});

test("an earlier day is read only: add does nothing and no gesture saves", async () => {
  const { actor, emitted, ctx, sent } = await start([matrix(OLD, EARLIER, [task(T1, "A")])]);
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  actor.send({ type: "add" });
  assert.equal(ctx().open, false);
  actor.send({ type: "_open" });
  assert.equal(ctx().open, true, "it opens to be read");
  actor.send({ type: "_tick", id: T1 });
  actor.send({ type: "_add", text: "x" });
  actor.send({ type: "_delete", id: T1 });
  assert.equal(emitted.length, 0);
  assert.equal(sent.length, 0);
});

test("a shown day it does not hold is asked for by itself; the fact's changes are followed by version", async () => {
  const { actor, asked, ctx } = await start([]);
  actor.send({ type: "day.shown", day: "2025-01-02", writable: false });
  await flush();
  assert.deepEqual(asked.map((a) => a.payload), [{}, { day: "2025-01-02" }]);
  actor.send({ type: "matrix.changed", matrix: matrix(KEPT, TODAY, [task(T1, "A")], { version: 3 }) });
  actor.send({ type: "matrix.changed", matrix: matrix(KEPT, TODAY, [task(T1, "Old")], { version: 2 }) });
  assert.equal(ctx().matrices[0].tasks[0].text, "A", "an older version is stale");
  actor.send({ type: "day.shown", day: TODAY, writable: true });
  actor.send({ type: "_open" });
  actor.send({ type: "matrix.deleted", id: KEPT, day: TODAY });
  assert.deepEqual([ctx().matrices, ctx().open], [[], false], "one that is gone closes");
});

test("Escape closes the places first, then folds", async () => {
  const { actor, ctx } = await start([matrix(KEPT, TODAY, [task(T1, "A")])]);
  actor.send({ type: "_open" });
  actor.send({ type: "_placing", id: T1 });
  actor.send({ type: "_escape" });
  assert.deepEqual([ctx().placing, ctx().open], [null, true]);
  actor.send({ type: "_escape" });
  assert.equal(ctx().open, false);
});

test("an add during the load acts once the matrices are in; with no answer the keyboard goes back", async () => {
  const waiting = await start([], { reply: { error: "no-answerer" } });
  assert.ok(waiting.actor.getSnapshot().matches("failed"));
  waiting.actor.send({ type: "add" });
  assert.deepEqual(waiting.sent, [{ target: "sheet-picker", name: "focus", payload: {} }]);
});

test("the folded card lists Do's open tasks and counts the rest", () => {
  const m = matrix(KEPT, TODAY, [
    task(T1, "Now", { place: "do" }),
    task(T2, "Also", { suggested: { place: "do", sure: true } }),
    task(T3, "Gone", { place: "do", done: true }),
    task("01K6TEST000000000000000TA4", "Later", { place: "schedule" }),
    task("01K6TEST000000000000000TA5", "?"),
  ]);
  assert.deepEqual(cardOf(m), { doing: ["Now", "Also"], rest: "To sort 1 · Schedule 1 · Delegate 0 · Drop 0 · 1 done" });
});

test("Shift with an arrow moves to the neighboring place: left is urgent, up is important; from To sort as if from Do", () => {
  assert.equal(neighbor("do", "right"), "schedule");
  assert.equal(neighbor("schedule", "left"), "do");
  assert.equal(neighbor("do", "down"), "delegate");
  assert.equal(neighbor("delegate", "up"), "do");
  assert.equal(neighbor("drop", "up"), "schedule");
  assert.equal(neighbor(null, "right"), "schedule");
  assert.equal(neighbor(null, "left"), "do");
  assert.equal(dayName("2025-03-04", TODAY), "4 March 2025");
});

test("the keys: arrows always, Vim's letters only with Vim keys on, and gg and dd wait for their second press", () => {
  const k = (key, over = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...over });
  assert.deepEqual(taskKey(k("ArrowDown"), false), { go: "down" });
  assert.deepEqual(taskKey(k("ArrowUp", { shiftKey: true }), false), { move: "up" });
  assert.equal(taskKey(k("j"), false), null);
  assert.deepEqual(taskKey(k("j"), true), { go: "down" });
  assert.deepEqual(taskKey(k("L"), true), { move: "right" });
  assert.deepEqual(taskKey(k("d"), true), { wait: "d" });
  assert.deepEqual(taskKey(k("d"), true, "d"), { remove: true });
  assert.deepEqual(taskKey(k("g"), true, "g"), { go: "first" });
  assert.deepEqual(taskKey(k("o"), true), { add: true });
  assert.deepEqual(taskKey(k(" "), false), { tick: true });
  assert.equal(taskKey(k("j", { ctrlKey: true }), true), null);
});

test("the keyboard path: tasks then Done, the Add a task line above by the arrow only, and leave past either end", () => {
  assert.equal(pathTarget("down", 0, 2), 1);
  assert.equal(pathTarget("down", 1, 2), "done");
  assert.equal(pathTarget("down", "done", 2), "leave");
  assert.equal(pathTarget("up", "done", 2), 1);
  assert.equal(pathTarget("up", 0, 2), "leave", "k past the first task goes on to the page");
  assert.equal(pathTarget("up", 0, 2, { arrow: true }), "add", "the up arrow goes to the Add a task line");
  assert.equal(pathTarget("down", "add", 2), 0, "and the down arrow comes back");
  assert.equal(pathTarget("up", 0, 2, { arrow: true, write: false }), "leave", "an earlier day has no such line");
  assert.equal(pathTarget("up", "done", 0, { arrow: true }), "add");
  assert.equal(pathTarget("first", 1, 2), 0);
  assert.equal(pathTarget("last", 0, 2), "done");
});
