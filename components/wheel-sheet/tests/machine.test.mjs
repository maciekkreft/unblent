import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, AREAS, writable, carriedFrom, ownScores, pressed, stepped, gapOf, scoreLine, summaryOf, wheelLabel, caption, wantedLabel, dayName, sheetKey, rowKey, areaTarget } from "../machine.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../events/wheel.saved.json", import.meta.url), "utf8"));
const recorded = [];

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const TODAY = "2026-10-14";
const EARLIER = "2026-10-12";
const LONG_AGO = "2026-10-06";
const OLD = "01K6TEST000000000000000WH0";
const A = "01K6TEST000000000000000WH1";
const B = "01K6TEST000000000000000WH2";
const NEW = "01K6TEST000000000000000M01";

const NONE = Array(8).fill(null);
const WANTED = [9, 7, 6, 8, 7, 6, 7, 6];
const ACTUAL = [6, 5, 4, 7, 3, 6, 5, 2];
const with1 = (list, i, v) => list.map((x, n) => (n === i ? v : x));

const wheel = (id, day, actual = ACTUAL, wanted = WANTED, version = 1) => ({ id, day, actual, wanted, version, pending: false });

const flush = () => new Promise((r) => setTimeout(r, 0));

// `wheels` is what the fact holds; `vimKeys` the settings fact's answer, or none when the
// page holds no settings.
async function start(wheels = [], { vimKeys, reply } = {}) {
  let n = 0;
  const asked = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target, name, payload) => {
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        asked.push({ target, name, payload });
        return Promise.resolve(reply ?? { wheels });
      },
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      now: () => NOW,
      throttleMs: 400,
    },
  });
  const emitted = [];
  actor.on("wheel.saved", (e) => {
    emitted.push(e);
    recorded.push(e);
  });
  actor.start();
  await flush();
  const ctx = () => actor.getSnapshot().context;
  const tick = async () => {
    clock.increment(400);
    await flush();
  };
  return { actor, clock, emitted, asked, ctx, tick };
}

// Every emit of the suite matches its schema.
after(() => {
  for (const { type, ...rest } of recorded) assert.ok(new Validator(SCHEMA, "2020-12").validate(rest).valid, JSON.stringify(rest));
});

test("it asks for every day once and shows the shown day's wheels, following day.shown", async () => {
  const { actor, asked, ctx } = await start([wheel(OLD, EARLIER), wheel(A, TODAY)]);
  assert.deepEqual(asked, [{ target: "wheels", name: "list", payload: {} }]);
  assert.deepEqual(ctx().wheels.filter((w) => w.day === ctx().day).map((w) => w.id), [A]);
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  assert.equal(ctx().day, EARLIER);
  assert.equal(asked.length, 1, "every day's wheels are already held");
  assert.equal(writable(ctx()), false);
});

test("a fact that cannot answer is an honest failure", async () => {
  const { actor } = await start([], { reply: { error: "no-answerer" } });
  assert.equal(actor.getSnapshot().matches("failed"), true);
});

test("add opens a new wheel with Actual empty and Wanted as the newest wheel before the day left it, and sends nothing", async () => {
  const partly = with1(NONE, 0, 5);
  const { actor, emitted, ctx } = await start([wheel(OLD, LONG_AGO, ACTUAL, WANTED), wheel(A, EARLIER, ACTUAL, partly)]);
  actor.send({ type: "add" });
  assert.equal(ctx().draft.id, NEW);
  assert.equal(ctx().draft.day, TODAY);
  assert.deepEqual(ctx().draft.actual, NONE);
  assert.deepEqual(ctx().draft.wanted, partly, "a partly filled wheel carries over as it stood");
  assert.equal(ctx().mode, "actual");
  assert.equal(ctx().cursor, 0);
  assert.equal(ctx().landing, 1);
  assert.deepEqual(emitted, []);
});

test("the first wheel starts with both empty", async () => {
  const { actor, ctx } = await start([]);
  actor.send({ type: "add" });
  assert.deepEqual(ctx().draft.wanted, NONE);
});

test("add opens the wheel the day has instead of a second, the one open stays, and a day that is closed takes none", async () => {
  const { actor, ctx } = await start([wheel(A, TODAY)]);
  actor.send({ type: "add" });
  assert.equal(ctx().draft.id, A);
  actor.send({ type: "add" });
  assert.equal(ctx().draft.id, A);
  assert.equal(ctx().landing, 2, "pressed again, the sheet takes the keyboard again");

  const closed = await start([wheel(A, TODAY)]);
  closed.actor.send({ type: "day.shown", day: EARLIER, writable: false });
  closed.actor.send({ type: "add" });
  assert.equal(closed.ctx().draft, null);
  assert.equal(closed.ctx().landing, 0);
});

test("an untouched new wheel folds to nothing and sends nothing", async () => {
  const { actor, emitted, ctx } = await start([wheel(OLD, EARLIER)]);
  actor.send({ type: "add" });
  actor.send({ type: "_done" });
  assert.equal(ctx().draft, null);
  assert.deepEqual(emitted, []);
});

test("a click sets the chosen score, the current score clears, saves are throttled, and the fold says finished", async () => {
  const { actor, emitted, ctx, tick } = await start([]);
  actor.send({ type: "add" });
  actor.send({ type: "_press", area: 2, value: 6 });
  actor.send({ type: "_press", area: 2, value: 7 });
  assert.deepEqual(emitted, [], "nothing leaves before the throttle's end");
  assert.equal(ctx().cursor, 2);
  await tick();
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].actual, with1(NONE, 2, 7));
  assert.equal(emitted[0].finished, undefined);

  actor.send({ type: "_mode", mode: "wanted" });
  actor.send({ type: "_press", area: 2, value: 9 });
  assert.deepEqual(ctx().draft.wanted, with1(NONE, 2, 9));
  actor.send({ type: "_press", area: 2, value: 9 });
  assert.deepEqual(ctx().draft.wanted, NONE, "pressing the current score clears it");
  actor.send({ type: "_press", area: 2, value: 8 });
  actor.send({ type: "_done" });
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[1].wanted, with1(NONE, 2, 8));
  assert.equal(emitted[1].finished, true);
});

test("clearing the last score is never saved while rating; the fold deletes a kept wheel and keeps nothing of a new one", async () => {
  const kept = with1(NONE, 0, 6);
  const { actor, emitted, ctx, tick } = await start([wheel(A, TODAY, kept, NONE)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 6 });
  await tick();
  await tick();
  assert.deepEqual(emitted, [], "no save of nothing at all while the user is clicking");
  assert.equal(ctx().dirty, true, "it stays waiting");
  actor.send({ type: "wheel.changed", wheel: wheel(A, TODAY, kept, NONE, 2) });
  assert.deepEqual(ctx().draft.actual, NONE, "a change from the fact does not refill what was cleared");
  actor.send({ type: "_done" });
  assert.equal(emitted.length, 1);
  assert.deepEqual([emitted[0].actual, emitted[0].wanted, emitted[0].finished], [NONE, NONE, true]);

  const fresh = await start([]);
  fresh.actor.send({ type: "add" });
  fresh.actor.send({ type: "_press", area: 0, value: 6 });
  fresh.actor.send({ type: "_press", area: 0, value: 6 });
  fresh.actor.send({ type: "_done" });
  assert.deepEqual(fresh.emitted, []);
});

test("a score set again after clearing the last one saves as usual", async () => {
  const kept = with1(NONE, 0, 6);
  const { actor, emitted, tick } = await start([wheel(A, TODAY, kept, NONE)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 6 });
  await tick();
  actor.send({ type: "_press", area: 1, value: 3 });
  await tick();
  assert.deepEqual(emitted.map((e) => e.actual), [with1(NONE, 1, 3)]);
});

test("a wheel with Wanted changed and no Actual is kept; changed back to as carried it is not, and the fold deletes it", async () => {
  const { actor, emitted, tick, ctx } = await start([wheel(OLD, EARLIER, ACTUAL, WANTED)]);
  actor.send({ type: "add" });
  actor.send({ type: "_mode", mode: "wanted" });
  actor.send({ type: "_press", area: 0, value: 3 });
  await tick();
  assert.equal(emitted.length, 1, "Wanted changed is enough to keep it");
  actor.send({ type: "wheel.changed", wheel: wheel(ctx().draft.id, TODAY, NONE, with1(WANTED, 0, 3)) });
  actor.send({ type: "_press", area: 0, value: 9 });
  await tick();
  assert.equal(emitted.length, 1, "as carried over again, it is not saved while rating");
  actor.send({ type: "_done" });
  assert.deepEqual([emitted[1].actual, emitted[1].wanted, emitted[1].finished], [NONE, NONE, true]);
});

test("a wheel looked at and not changed sends nothing, also one that holds only what was carried", async () => {
  const { actor, emitted } = await start([wheel(OLD, EARLIER, ACTUAL, WANTED), wheel(A, TODAY, ACTUAL, WANTED), wheel(B, TODAY, NONE, WANTED)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_done" });
  actor.send({ type: "_open", id: B });
  actor.send({ type: "_done" });
  assert.deepEqual(emitted, []);
});

test("a fold after the throttle already saved still says finished, so the next change is a step of its own", async () => {
  const { actor, emitted, tick } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 1 });
  await tick();
  actor.send({ type: "_done" });
  assert.deepEqual(emitted.map((e) => e.finished), [undefined, true]);
  assert.deepEqual(emitted[1].actual, emitted[0].actual);
});

test("Delete sends what waits first, then nothing at all; a new wheel left untouched sends nothing", async () => {
  const { actor, emitted, ctx } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 1 });
  actor.send({ type: "_delete" });
  assert.equal(ctx().draft, null);
  assert.deepEqual(emitted[0].actual, with1(ACTUAL, 0, 1));
  assert.deepEqual([emitted[1].actual, emitted[1].wanted, emitted[1].finished], [NONE, NONE, true]);

  const fresh = await start([wheel(OLD, EARLIER)]);
  fresh.actor.send({ type: "add" });
  fresh.actor.send({ type: "_delete" });
  assert.equal(fresh.ctx().draft, null);
  assert.deepEqual(fresh.emitted, []);
});

test("the keys set a score and switch the choice to match; the end of the scale changes no score", async () => {
  const { actor, ctx, emitted, tick } = await start([wheel(A, TODAY, with1(ACTUAL, 0, 10), with1(WANTED, 0, 1))]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_step", more: true, wanted: true });
  assert.equal(ctx().mode, "wanted");
  assert.equal(ctx().draft.wanted[0], 2);
  actor.send({ type: "_step", more: true, wanted: false });
  assert.equal(ctx().mode, "actual", "the key switches the choice");
  assert.equal(ctx().draft.actual[0], 10);
  actor.send({ type: "_cursor", to: 1 });
  actor.send({ type: "_step", more: false, wanted: false });
  assert.equal(ctx().draft.actual[1], 4);
  await tick();
  assert.equal(emitted.length, 1);

  const end = await start([wheel(A, TODAY, with1(ACTUAL, 0, 10))]);
  end.actor.send({ type: "_open", id: A });
  end.actor.send({ type: "_mode", mode: "wanted" });
  end.actor.send({ type: "_step", more: true, wanted: false });
  assert.equal(end.ctx().mode, "actual");
  assert.equal(end.ctx().dirty, false);
});

test("an earlier day is read only: it opens, takes no score and no delete, and closes", async () => {
  const { actor, ctx, emitted, tick } = await start([wheel(A, EARLIER)]);
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  actor.send({ type: "_open", id: A });
  assert.equal(ctx().draft.id, A);
  actor.send({ type: "_press", area: 0, value: 1 });
  actor.send({ type: "_step", more: true, wanted: false });
  actor.send({ type: "_mode", mode: "wanted" });
  actor.send({ type: "_delete" });
  await tick();
  assert.deepEqual(ctx().draft.actual, ACTUAL);
  assert.equal(ctx().mode, "actual");
  actor.send({ type: "_done" });
  assert.equal(ctx().draft, null);
  assert.deepEqual(emitted, []);
});

test("before the journal page has said, only today's date is written on; yesterday stays open while it says so", async () => {
  const { actor, ctx } = await start([]);
  assert.equal(writable(ctx()), true);
  actor.send({ type: "day.shown", day: EARLIER, writable: true });
  assert.equal(writable(ctx()), true);
});

test("at 2:00 an open sheet keeps what was rated and becomes read only", async () => {
  const { actor, ctx, emitted } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 1 });
  actor.send({ type: "day.shown", day: TODAY, writable: false });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].finished, true);
  assert.equal(writable(ctx()), false);
  assert.equal(ctx().draft.id, A, "the sheet stays, to be read");
  actor.send({ type: "_press", area: 0, value: 2 });
  assert.equal(ctx().draft.actual[0], 1);
});

test("at 2:00 a wheel emptied while rating goes back to what was saved, and an untouched new one goes", async () => {
  const kept = with1(NONE, 0, 6);
  const { actor, ctx, emitted } = await start([wheel(A, TODAY, kept, NONE)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 6 });
  actor.send({ type: "day.shown", day: TODAY, writable: false });
  assert.deepEqual(ctx().draft.actual, kept);
  assert.deepEqual(emitted, []);

  const fresh = await start([]);
  fresh.actor.send({ type: "add" });
  fresh.actor.send({ type: "day.shown", day: TODAY, writable: false });
  assert.equal(fresh.ctx().draft, null);
  assert.deepEqual(fresh.emitted, []);
});

test("moving to another day folds the open sheet as Done does", async () => {
  const { actor, ctx, emitted } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 1 });
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  assert.equal(emitted.at(-1).finished, true);
  assert.equal(emitted.at(-1).day, TODAY);
  assert.equal(ctx().draft, null);
});

test("opening another card folds the one open: one sheet at a time", async () => {
  const { actor, ctx, emitted } = await start([wheel(A, TODAY), wheel(B, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 1 });
  actor.send({ type: "_open", id: B });
  assert.equal(ctx().draft.id, B);
  assert.equal(emitted.at(-1).id, A);
  assert.equal(emitted.at(-1).finished, true);
});

test("the sheet follows the fact only while nothing waits; a stale version loses; a delete closes it and Undo shows the wheel again", async () => {
  const { actor, ctx, tick } = await start([wheel(A, TODAY, ACTUAL, WANTED, 2)]);
  actor.send({ type: "wheel.changed", wheel: wheel(A, TODAY, with1(ACTUAL, 0, 1), WANTED, 1) });
  assert.equal(ctx().wheels[0].actual[0], ACTUAL[0], "an older version does not win");

  actor.send({ type: "_open", id: A });
  actor.send({ type: "wheel.changed", wheel: wheel(A, TODAY, with1(ACTUAL, 0, 2), WANTED, 3) });
  assert.equal(ctx().draft.actual[0], 2, "an Undo reaches the open sheet");
  actor.send({ type: "_press", area: 1, value: 1 });
  actor.send({ type: "wheel.changed", wheel: wheel(A, TODAY, with1(ACTUAL, 0, 3), WANTED, 4) });
  assert.equal(ctx().draft.actual[0], 2, "what waits is not overwritten");
  await tick();

  actor.send({ type: "wheel.deleted", id: A, day: TODAY });
  assert.equal(ctx().draft, null);
  assert.deepEqual(ctx().wheels, []);
  actor.send({ type: "wheel.changed", wheel: wheel(A, TODAY, ACTUAL, WANTED, 6) });
  assert.deepEqual(ctx().wheels.map((w) => w.id), [A], "Undo brings it back under the same id");
  assert.equal(ctx().draft, null, "as a card");
});

test("Vim keys comes from settings and follows settings.changed", async () => {
  const { actor, ctx } = await start([], { vimKeys: true });
  assert.equal(ctx().vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(ctx().vimKeys, false);
});

test("the keys of a sheet: arrows always with Shift for Wanted, letters only with Vim keys", () => {
  const key = (k, shiftKey = false) => ({ key: k, shiftKey });
  assert.deepEqual(sheetKey(key("ArrowDown"), false), { move: "down" });
  assert.deepEqual(sheetKey(key("ArrowUp", true), false), { move: "up" });
  assert.deepEqual(sheetKey(key("ArrowRight"), false), { step: true, more: true, wanted: false });
  assert.deepEqual(sheetKey(key("ArrowLeft", true), false), { step: true, more: false, wanted: true });
  for (const k of ["j", "k", "g", "G", "h", "l", "H", "L"]) assert.equal(sheetKey(key(k), false), null, k);
  assert.deepEqual(sheetKey(key("j"), true), { move: "down" });
  assert.deepEqual(sheetKey(key("k"), true), { move: "up" });
  assert.deepEqual(sheetKey(key("G"), true), { move: "last" });
  assert.deepEqual(sheetKey(key("g"), true), { wait: true });
  assert.deepEqual(sheetKey(key("g"), true, true), { move: "first" });
  assert.deepEqual(sheetKey(key("l"), true), { step: true, more: true, wanted: false });
  assert.deepEqual(sheetKey(key("h"), true), { step: true, more: false, wanted: false });
  assert.deepEqual(sheetKey(key("L", true), true), { step: true, more: true, wanted: true });
  assert.deepEqual(sheetKey(key("H", true), true), { step: true, more: false, wanted: true });
  assert.equal(sheetKey({ key: "j", ctrlKey: true }, true), null, "Ctrl+j is the desk's");
  assert.deepEqual(rowKey(key("j"), true), { move: "down" });
  assert.equal(rowKey(key("j"), false), null);
  assert.equal(rowKey(key("l"), true), null);
});

test("a move lands on an area, or leaves past either end", () => {
  assert.equal(areaTarget("down", 0), 1);
  assert.equal(areaTarget("up", 0), "leave");
  assert.equal(areaTarget("down", 7), "leave");
  assert.equal(areaTarget("first", 5), 0);
  assert.equal(areaTarget("last", 5), 7);
});

test("the scores step and clear", () => {
  assert.equal(pressed(6, 6), null);
  assert.equal(pressed(6, 7), 7);
  assert.equal(stepped(null, true), 1);
  assert.equal(stepped(10, true), 10);
  assert.equal(stepped(1, false), null);
  assert.equal(stepped(null, false), null);
  assert.equal(stepped(5, false), 4);
});

test("a card says each area's scores and the gap, empty when they match or one is missing", () => {
  assert.equal(gapOf(6, 9), "−3");
  assert.equal(gapOf(9, 6), "+3");
  assert.equal(gapOf(6, 6), "");
  assert.equal(gapOf(null, 6), "");
  assert.equal(gapOf(6, null), "");
  assert.equal(scoreLine(null, 6), "–/6");
  const summary = summaryOf({ actual: with1(NONE, 0, 6), wanted: with1(NONE, 0, 9) });
  assert.deepEqual(summary[0], { name: "Health", score: "6/9", gap: "−3" });
  assert.deepEqual(summary[7], { name: "Fun", score: "–/–", gap: "" });
  assert.equal(summary.length, AREAS.length);
  assert.match(wheelLabel({ actual: with1(NONE, 0, 6), wanted: NONE }), /^Health: actual 6, wanted not rated; Work: actual not rated/);
});

test("the key names the wheel Wanted came from until a Wanted score is changed, and only where it can be", async () => {
  const { actor, ctx } = await start([wheel(OLD, LONG_AGO, ACTUAL, WANTED)]);
  actor.send({ type: "add" });
  assert.equal(wantedLabel(ctx(), ctx().draft), "Wanted, from your wheel of 6 October");
  actor.send({ type: "_mode", mode: "wanted" });
  actor.send({ type: "_press", area: 0, value: 1 });
  assert.equal(wantedLabel(ctx(), ctx().draft), "Wanted");
  actor.send({ type: "_press", area: 0, value: 9 });
  assert.equal(wantedLabel(ctx(), ctx().draft), "Wanted, from your wheel of 6 October", "the same again is as carried");

  const context = { ...ctx(), dayWritable: false };
  assert.equal(wantedLabel(context, ctx().draft), "Wanted", "an earlier day is only read");

  const blank = await start([wheel(OLD, LONG_AGO, ACTUAL, NONE)]);
  blank.actor.send({ type: "add" });
  assert.equal(wantedLabel(blank.ctx(), blank.ctx().draft), "Wanted", "nothing was carried");

  assert.equal(dayName("2025-10-06", TODAY), "6 October 2025");
});

test("the caption says what a click sets, and on a closed day that the scores are only read", async () => {
  const { actor, ctx } = await start([]);
  actor.send({ type: "add" });
  assert.match(caption(ctx()), /How is each area/);
  actor.send({ type: "_mode", mode: "wanted" });
  assert.match(caption(ctx()), /Where do you want/);
  assert.equal(caption({ ...ctx(), dayWritable: false }), "Your scores on this day.");
});

test("a wheel holds something of its own by Actual, or by Wanted other than as carried", async () => {
  const { ctx } = await start([wheel(OLD, EARLIER, ACTUAL, WANTED)]);
  assert.equal(carriedFrom(ctx(), TODAY).id, OLD);
  assert.equal(carriedFrom(ctx(), EARLIER), null);
  assert.equal(ownScores(ctx(), { day: TODAY, actual: NONE, wanted: WANTED }), false);
  assert.equal(ownScores(ctx(), { day: TODAY, actual: NONE, wanted: NONE }), false);
  assert.equal(ownScores(ctx(), { day: TODAY, actual: NONE, wanted: with1(WANTED, 0, 1) }), true);
  assert.equal(ownScores(ctx(), { day: TODAY, actual: with1(NONE, 0, 1), wanted: WANTED }), true);
});
