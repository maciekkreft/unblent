import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, dateOf } from "../machine.js";

const json = (name) => JSON.parse(readFileSync(new URL(`../events/${name}.json`, import.meta.url), "utf8"));
const SCHEMAS = { "choice-point.saved": json("choice-point.saved"), "removal.started": json("removal.started") };
const recorded = [];

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const TODAY = "2026-10-14";
const EARLIER = "2026-10-12";
const A = "01K6TEST000000000000000CP1";
const B = "01K6TEST000000000000000CP2";

const cp = (id, day, texts = {}, rest = {}) => ({
  id,
  day,
  situation: "",
  thoughts: "",
  away: "",
  towards: "",
  ...texts,
  createdAt: "2026-10-14T07:30:00.000Z",
  version: 1,
  pending: false,
  removing: false,
  ...rest,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

// `days` maps a date to the choice points the fact answers for it; `vimKeys` is the
// settings fact's answer, or none when the page holds no settings.
async function start(days = {}, vimKeys) {
  let n = 0;
  const asked = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target, name, payload) => {
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        asked.push({ target, name, payload });
        return Promise.resolve({ choicePoints: days[payload.day] ?? [] });
      },
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      now: () => NOW,
      throttleMs: 400,
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
  return { actor, clock, emitted, asked, ctx: () => actor.getSnapshot().context, state: () => actor.getSnapshot().value };
}

const saves = (emitted) => emitted.filter((e) => e.type === "choice-point.saved");

// Every emit of the suite matches its schema.
after(() => {
  for (const { type, ...rest } of recorded) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, JSON.stringify({ type, ...rest }));
});

test("it shows today until the journal page says which day it shows, then follows day.shown", async () => {
  assert.equal(dateOf(NOW), TODAY);
  const { actor, asked, ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" })], [EARLIER]: [cp(B, EARLIER)] });
  assert.deepEqual(asked.at(-1), { target: "choice-points", name: "list", payload: { day: TODAY } });
  assert.deepEqual(ctx().choicePoints.map((r) => r.id), [A]);

  actor.send({ type: "day.shown", day: TODAY });
  await flush();
  assert.equal(asked.length, 1, "the same day is not asked again");

  actor.send({ type: "day.shown", day: EARLIER });
  await flush();
  assert.deepEqual(asked.at(-1).payload, { day: EARLIER });
  assert.equal(ctx().day, EARLIER);
  assert.deepEqual(ctx().choicePoints.map((r) => r.id), [B]);
});

test("changes follow the shown day, a stale version is ignored, and a deleted one goes", async () => {
  const { actor, ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "v2" }, { version: 2 })] });
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "v1" }, { version: 1 }) });
  assert.equal(ctx().choicePoints[0].situation, "v2", "an older version does not win");
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "v3" }, { version: 3 }) });
  assert.equal(ctx().choicePoints[0].situation, "v3");
  actor.send({ type: "choice-point.changed", choicePoint: cp(B, EARLIER, { situation: "elsewhere" }) });
  assert.deepEqual(ctx().choicePoints.map((r) => r.id), [A], "another day's change passes by");
  actor.send({ type: "choice-point.deleted", id: A, day: TODAY });
  assert.deepEqual(ctx().choicePoints, []);
});

test("typing saves at a throttle, and at once on blur", async () => {
  const { actor, clock, emitted, ctx, state } = await start();
  actor.send({ type: "_add" });
  const id = ctx().draft.id;
  assert.deepEqual(state(), { ready: { open: "clean" } });
  assert.equal(ctx().draft.day, TODAY);

  actor.send({ type: "_edit", field: "situation", value: "D" });
  clock.increment(200);
  actor.send({ type: "_edit", field: "situation", value: "Dinner" });
  assert.equal(saves(emitted).length, 0, "nothing per keystroke");
  clock.increment(200);
  assert.deepEqual(saves(emitted), [{ type: "choice-point.saved", id, day: TODAY, situation: "Dinner", thoughts: "", away: "", towards: "" }]);

  actor.send({ type: "_edit", field: "away", value: "Checked my phone" });
  actor.send({ type: "_blur" });
  assert.equal(saves(emitted).length, 2);
  assert.equal(saves(emitted)[1].away, "Checked my phone");
  clock.increment(1000);
  assert.equal(saves(emitted).length, 2, "the blur's save ended the window");
});

test("Done on a blank new choice point keeps nothing; Done after typing saves at once", async () => {
  const { actor, emitted, ctx, state } = await start();
  actor.send({ type: "_add" });
  actor.send({ type: "_done" });
  assert.deepEqual(state(), { ready: "folded" });
  assert.equal(ctx().draft, null);
  assert.deepEqual(emitted, []);

  actor.send({ type: "_add" });
  actor.send({ type: "_edit", field: "towards", value: "Listened" });
  actor.send({ type: "_done" });
  assert.deepEqual(state(), { ready: "folded" });
  assert.equal(saves(emitted).length, 1);
  assert.equal(saves(emitted)[0].towards, "Listened");
});

test("a kept choice point opens with its texts and follows changes only while nothing waits to save", async () => {
  const { actor, clock, ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" })] });
  actor.send({ type: "_open", id: A });
  assert.equal(ctx().draft.situation, "Dinner");
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "From the phone" }, { version: 2 }) });
  assert.equal(ctx().draft.situation, "From the phone");
  actor.send({ type: "_edit", field: "situation", value: "Typed here" });
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "Another" }, { version: 3 }) });
  assert.equal(ctx().draft.situation, "Typed here", "what is on screen is not overwritten");
  clock.increment(400);
});

test("Delete saves what waits, then starts the removal; a removed one closes and Undo brings back its card", async () => {
  const { actor, emitted, ctx, state } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" })] });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", field: "situation", value: "Dinner party " });
  actor.send({ type: "_delete" });
  assert.deepEqual(
    emitted.map((e) => e.type),
    ["choice-point.saved", "removal.started"],
  );
  assert.deepEqual(emitted[1], { type: "removal.started", kind: "choice-point", id: A, name: "Dinner party" });
  assert.deepEqual(state(), { ready: "folded" });

  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "Dinner party " }, { removing: true }) });
  assert.equal(ctx().choicePoints[0].removing, true);
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "Dinner party " }, { removing: false }) });
  assert.equal(ctx().choicePoints[0].removing, false, "Undo: the card is back");
});

test("Delete on a blank new one just closes; a choice point removed elsewhere while open closes", async () => {
  const { actor, emitted, state } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" })] });
  actor.send({ type: "_add" });
  actor.send({ type: "_delete" });
  assert.deepEqual(emitted, []);
  assert.deepEqual(state(), { ready: "folded" });

  actor.send({ type: "_open", id: A });
  actor.send({ type: "choice-point.deleted", id: A, day: TODAY });
  assert.deepEqual(state(), { ready: "folded" });
});

test("adding another or moving to another day saves the open one first", async () => {
  const { actor, emitted, ctx, state } = await start();
  actor.send({ type: "_add" });
  const first = ctx().draft.id;
  actor.send({ type: "_edit", field: "thoughts", value: "Tight chest" });
  actor.send({ type: "_add" });
  assert.equal(saves(emitted).at(-1).id, first);
  assert.notEqual(ctx().draft.id, first);
  assert.deepEqual(state(), { ready: { open: "clean" } }, "the new one starts with nothing to save");

  actor.send({ type: "_edit", field: "away", value: "Snapped" });
  actor.send({ type: "day.shown", day: EARLIER });
  assert.equal(saves(emitted).at(-1).away, "Snapped");
  assert.equal(saves(emitted).at(-1).day, TODAY, "it stays with the day it was added to");
  await flush();
  assert.equal(ctx().draft, null);
  actor.send({ type: "_add" });
  assert.equal(ctx().draft.day, EARLIER, "a new one joins the day shown");
});

test("a fact that cannot answer is an honest failure", async () => {
  const actor = createActor(machine, {
    input: { ask: () => Promise.resolve({ error: "no-answerer" }), mint: () => A, now: () => NOW },
  });
  actor.start();
  await flush();
  assert.equal(actor.getSnapshot().value, "failed");
});

test("the Vim keys preference is read at start and followed after; without settings it is off", async () => {
  assert.equal((await start()).ctx().vimKeys, false);
  const { actor, ctx } = await start({}, true);
  assert.equal(ctx().vimKeys, true);
  actor.send({ type: "_add" });
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(ctx().vimKeys, false, "followed while a sheet is open");
  assert.ok(ctx().draft, "the open sheet stays open");
});
