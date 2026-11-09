import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, AREAS, QUESTIONS, EXAMPLES, STEPS, shown, writable, carriedFrom, holdsAny, boxEdge, pressed, stepped, chosenOf, nextSteps, wheelLabel, caption, copiedLabel, dayName, sheetKey, sheetTarget, rowKey, applies, wording, answerOf, hasAnswer, panelOf, panelHint, panelTarget, pastLastBox } from "../machine.js";

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

test("add opens a whole copy of the newest wheel before the day and saves it at once, as one finished step", async () => {
  const partly = with1(NONE, 0, 5);
  const answers = with1(Array(8).fill({}), 7, { one: "Errands", closer: "The gym" });
  const focus = with1(Array(8).fill(false), 7, true);
  const { actor, emitted, ctx } = await start([wheel(OLD, LONG_AGO, ACTUAL, WANTED), { ...wheel(A, EARLIER, ACTUAL, partly), answers, focus }]);
  actor.send({ type: "add" });
  assert.equal(ctx().draft.id, NEW);
  assert.equal(ctx().draft.day, TODAY);
  assert.deepEqual(ctx().draft.actual, ACTUAL, "Actual is copied too");
  assert.deepEqual(ctx().draft.wanted, partly, "a partly filled wheel is copied as it stood");
  assert.deepEqual(ctx().draft.answers, answers, "every answer is copied");
  assert.deepEqual(ctx().draft.focus, focus, "and the areas chosen");
  assert.equal(ctx().mode, "actual");
  assert.equal(ctx().cursor, 0);
  assert.equal(ctx().landing, 1);
  assert.equal(emitted.length, 1);
  assert.deepEqual([emitted[0].id, emitted[0].day, emitted[0].actual, emitted[0].focus, emitted[0].finished], [NEW, TODAY, ACTUAL, focus, true]);

  const first = await start([]);
  first.actor.send({ type: "add" });
  assert.deepEqual([first.ctx().draft.actual, first.ctx().draft.wanted], [NONE, NONE], "the first wheel starts empty");
  assert.deepEqual(first.emitted, [], "and is saved once something is set");
});

test("the first wheel starts with both empty", async () => {
  const { actor, ctx } = await start([]);
  actor.send({ type: "add" });
  assert.deepEqual(ctx().draft.wanted, NONE);
});

// An add sent while the fact has not answered yet: `answer` is what it then says.
async function addDuringLoad(answer) {
  let answerNow;
  const sent = [];
  const actor = createActor(machine, {
    input: {
      ask: (target) => (target === "settings" ? Promise.resolve({ error: "no-answerer" }) : new Promise((r) => (answerNow = r))),
      send: (target, name) => sent.push(`${target}: ${name}`),
      mint: () => NEW,
      now: () => NOW,
    },
  });
  actor.start();
  await flush();
  actor.send({ type: "add" });
  assert.equal(actor.getSnapshot().context.draft, null, "the wheels are not in yet");
  answerNow(answer);
  await flush();
  return { actor, sent };
}

test("an add during the load is not lost: it opens the sheet with the keyboard once the wheels are in", async () => {
  const { actor, sent } = await addDuringLoad({ wheels: [wheel(OLD, LONG_AGO)] });
  const { context } = actor.getSnapshot();
  assert.equal(context.draft.id, NEW);
  assert.deepEqual(context.draft.wanted, WANTED, "Wanted is carried over from what the load brought");
  assert.equal(context.landing, 1);
  assert.deepEqual(sent, []);
});

test("an add during a load that fails gives the keyboard back to the row, and so does one after it", async () => {
  const { actor, sent } = await addDuringLoad({ error: "no-answerer" });
  assert.ok(actor.getSnapshot().matches("failed"));
  assert.deepEqual(sent, ["sheet-picker: focus"]);
  actor.send({ type: "add" });
  assert.deepEqual(sent, ["sheet-picker: focus", "sheet-picker: focus"]);
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

test("an untouched first wheel folds to nothing; an untouched copy stays as it was added", async () => {
  const first = await start([]);
  first.actor.send({ type: "add" });
  first.actor.send({ type: "_done" });
  assert.equal(first.ctx().draft, null);
  assert.deepEqual(first.emitted, []);

  const { actor, emitted, ctx } = await start([wheel(OLD, EARLIER)]);
  actor.send({ type: "add" });
  actor.send({ type: "wheel.changed", wheel: wheel(NEW, TODAY) });
  actor.send({ type: "_done" });
  assert.equal(ctx().draft, null);
  assert.equal(emitted.length, 1, "only the save of the add");
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

test("Reset empties the whole wheel; the fold deletes it, and rating again keeps only what is new", async () => {
  const focus = with1(Array(8).fill(false), 2, true);
  const { actor, emitted, tick, ctx } = await start([{ ...wheel(OLD, EARLIER), focus, answers: with1(Array(8).fill({}), 0, { one: "Tired" }) }]);
  actor.send({ type: "add" });
  actor.send({ type: "wheel.changed", wheel: { ...wheel(NEW, TODAY), focus } });
  actor.send({ type: "_mode", mode: "wanted" });
  actor.send({ type: "_reset" });
  assert.deepEqual([ctx().draft.actual, ctx().draft.wanted, ctx().draft.focus, ctx().mode], [NONE, NONE, Array(8).fill(false), "actual"]);
  assert.deepEqual(ctx().draft.answers, Array(8).fill({}));
  await tick();
  assert.equal(emitted.length, 1, "an emptied wheel is not saved while rating");
  actor.send({ type: "_done" });
  assert.deepEqual([emitted[1].actual, emitted[1].wanted, emitted[1].focus, emitted[1].finished], [NONE, NONE, Array(8).fill(false), true], "the fold deletes it");

  const again = await start([wheel(OLD, EARLIER)]);
  again.actor.send({ type: "add" });
  again.actor.send({ type: "_reset" });
  again.actor.send({ type: "_press", area: 1, value: 4 });
  await again.tick();
  assert.deepEqual(again.emitted.at(-1).actual, with1(NONE, 1, 4));
  again.actor.send({ type: "_reset" });
  again.actor.send({ type: "_reset" });
  assert.equal(again.ctx().dirty, true, "a blank wheel has nothing more to reset");
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

test("Delete sends what waits first, then the delete; a first wheel left untouched sends nothing", async () => {
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
  assert.deepEqual(
    fresh.emitted.map((e) => e.actual),
    [ACTUAL, NONE],
    "the copy saved at the add, then its delete",
  );

  const first = await start([]);
  first.actor.send({ type: "add" });
  first.actor.send({ type: "_delete" });
  assert.deepEqual(first.emitted, [], "a first wheel left untouched sends nothing");
});

test("a key changes the score of the chosen tab and never moves the choice; the end of the scale changes nothing", async () => {
  const { actor, ctx, emitted, tick } = await start([wheel(A, TODAY, with1(ACTUAL, 0, 9), with1(WANTED, 0, 1))]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_step", more: true });
  assert.equal(ctx().draft.actual[0], 9, "Actual is at the end of the scale");
  assert.equal(ctx().dirty, false);
  actor.send({ type: "_mode", mode: "wanted" });
  assert.equal(ctx().dirty, false, "choosing a tab changes no score");
  actor.send({ type: "_step", more: true });
  assert.equal(ctx().draft.wanted[0], 2);
  assert.equal(ctx().mode, "wanted", "the choice stays");
  assert.equal(ctx().draft.actual[0], 9);
  actor.send({ type: "_mode", mode: "actual" });
  actor.send({ type: "_cursor", to: 1 });
  actor.send({ type: "_step", more: false });
  assert.equal(ctx().draft.actual[1], 4);
  assert.equal(ctx().draft.wanted[1], WANTED[1]);
  await tick();
  assert.equal(emitted.length, 1);
});

test("the panel starts closed on every opening, and pressing the open area closes it", async () => {
  const { actor, ctx } = await start([wheel(A, TODAY), wheel(B, TODAY), wheel(OLD, EARLIER)]);
  actor.send({ type: "_open", id: A });
  assert.equal(ctx().panel, false);
  actor.send({ type: "_toggle", area: 3 });
  assert.deepEqual([ctx().panel, ctx().cursor], [true, 3]);
  actor.send({ type: "_toggle", area: 5 });
  assert.deepEqual([ctx().panel, ctx().cursor], [true, 5], "pressing another area moves the panel to it");
  actor.send({ type: "_toggle", area: 5 });
  assert.deepEqual([ctx().panel, ctx().cursor], [false, 5]);

  actor.send({ type: "_toggle", area: 1 });
  actor.send({ type: "_open", id: B });
  assert.deepEqual([ctx().panel, ctx().cursor], [false, 0], "another card");
  actor.send({ type: "_toggle", area: 1 });
  actor.send({ type: "_done" });
  actor.send({ type: "_open", id: B });
  assert.equal(ctx().panel, false, "folded and opened again");
  actor.send({ type: "_toggle", area: 1 });
  actor.send({ type: "add" });
  assert.deepEqual([ctx().panel, ctx().cursor], [false, 0], "add");
  actor.send({ type: "_toggle", area: 1 });
  actor.send({ type: "_done" });
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  actor.send({ type: "_open", id: OLD });
  assert.equal(ctx().panel, false, "another day");
});

test("the open panel follows the area the keys act on and the area a score is pressed in", async () => {
  const { actor, ctx } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_enter" });
  assert.deepEqual([ctx().panel, panelOf(ctx(), ctx().draft).name], [true, "Health"]);
  actor.send({ type: "_cursor", to: 3 });
  assert.deepEqual([ctx().panel, panelOf(ctx(), ctx().draft).name], [true, "Family"]);
  actor.send({ type: "_press", area: 5, value: 2 });
  assert.deepEqual([ctx().panel, panelOf(ctx(), ctx().draft).name], [true, "Friends"]);
  actor.send({ type: "_enter" });
  assert.equal(ctx().panel, true, "Enter again changes nothing in this step");
});

test("Escape closes the panel first, then folds the sheet", async () => {
  const { actor, ctx, emitted } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 1 });
  actor.send({ type: "_enter" });
  actor.send({ type: "_escape" });
  assert.deepEqual([ctx().panel, ctx().draft?.id], [false, A]);
  assert.deepEqual(emitted, [], "closing the panel saves nothing");
  actor.send({ type: "_escape" });
  assert.equal(ctx().draft, null);
  assert.equal(emitted.at(-1).finished, true);
});

test("an earlier day's areas take the panel and the cursor, and still no score", async () => {
  const { actor, ctx, emitted } = await start([wheel(A, EARLIER)]);
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_cursor", to: 2 });
  actor.send({ type: "_enter" });
  assert.deepEqual([ctx().panel, ctx().cursor], [true, 2]);
  actor.send({ type: "_step", more: true });
  assert.deepEqual(ctx().draft.actual, ACTUAL);
  actor.send({ type: "_escape" });
  actor.send({ type: "_escape" });
  assert.equal(ctx().draft, null);
  assert.deepEqual(emitted, []);
});

const EMPTY = Array(8).fill({});

test("every save names all eight areas, a score change keeps an answer whose question is now hidden, and Delete sends them empty", async () => {
  const answers = with1(EMPTY, 0, { lower: "Walking helps" });
  const { actor, ctx, emitted, tick } = await start([{ ...wheel(A, TODAY), answers }]);
  actor.send({ type: "_open", id: A });
  assert.equal(panelOf(ctx(), ctx().draft).groups[1].items[0].value, "Walking helps");
  // At 1 the not lower question is hidden.
  actor.send({ type: "_press", area: 0, value: 1 });
  await tick();
  assert.deepEqual(emitted[0].answers, answers);
  actor.send({ type: "_press", area: 0, value: 4 });
  actor.send({ type: "_done" });
  assert.deepEqual(emitted[1].answers, answers);

  const gone = await start([{ ...wheel(A, TODAY), answers }]);
  gone.actor.send({ type: "_open", id: A });
  gone.actor.send({ type: "_delete" });
  assert.deepEqual([gone.emitted[0].actual, gone.emitted[0].wanted, gone.emitted[0].answers, gone.emitted[0].finished], [NONE, NONE, EMPTY, true]);
});

test("the draft is the sheet's own copy, so typing never changes what the fact announced", async () => {
  const answers = with1(EMPTY, 0, { one: "Low" });
  const record = { ...wheel(A, TODAY), answers };
  const { actor, ctx } = await start([record]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", area: 0, question: "one", value: "Lower" });
  assert.equal(ctx().draft.answers[0].one, "Lower");
  assert.equal(record.answers[0].one, "Low");
});

test("a new wheel copies every answer of the newest earlier wheel, and the panel says nothing of where they came from", async () => {
  const answers = with1(EMPTY, 2, { one: "Worried", ten: "Calm", lower: "Paid off", higher: "Rent", closer: "Budget" });
  const { actor, ctx, emitted } = await start([{ ...wheel(OLD, LONG_AGO), answers: with1(EMPTY, 2, { one: "Older" }) }, { ...wheel(A, EARLIER), answers }]);
  actor.send({ type: "add" });
  assert.deepEqual(ctx().draft.answers, answers);
  assert.equal(panelOf({ ...ctx(), cursor: 2 }, ctx().draft).groups[0].note, null);
  assert.deepEqual(emitted[0].answers, answers, "saved with the copy");
});

test("a first wheel holding only spaces, or an answer typed and emptied, is not kept", async () => {
  const { actor, ctx, emitted, tick } = await start([]);
  actor.send({ type: "add" });
  actor.send({ type: "_boxIn" });
  actor.send({ type: "_boxOut" });
  actor.send({ type: "_done" });
  assert.deepEqual(emitted, []);

  actor.send({ type: "add" });
  actor.send({ type: "_edit", area: 0, question: "one", value: "Lower" });
  actor.send({ type: "_edit", area: 0, question: "one", value: "" });
  await tick();
  actor.send({ type: "_edit", area: 1, question: "lower", value: "   " });
  actor.send({ type: "_boxOut" });
  actor.send({ type: "_done" });
  assert.equal(ctx().draft, null);
  assert.deepEqual(emitted, []);
});

test("a first wheel holding only an answer is kept", async () => {
  const { actor, emitted, tick } = await start([]);
  actor.send({ type: "add" });
  actor.send({ type: "_edit", area: 1, question: "ten", value: "A job I like" });
  await tick();
  assert.equal(emitted.length, 1);
  assert.deepEqual([emitted[0].actual, emitted[0].wanted], [NONE, NONE]);
  assert.deepEqual(emitted[0].answers.slice(0, 2), [{}, { ten: "A job I like" }]);
  assert.equal(emitted[0].finished, undefined);
});

test("an emptied box leaves no key, and text of only spaces is kept as typed", async () => {
  const { actor, ctx } = await start([{ ...wheel(A, TODAY), answers: with1(EMPTY, 0, { one: "Low" }) }]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", area: 0, question: "one", value: "" });
  assert.deepEqual(ctx().draft.answers[0], {});
  actor.send({ type: "_edit", area: 0, question: "ten", value: "  " });
  assert.deepEqual(ctx().draft.answers[0], { ten: "  " });
});

test("typing saves at the throttle and at once with finished when the box loses the keyboard; a look sends nothing", async () => {
  const { actor, ctx, emitted, tick } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_boxIn" });
  actor.send({ type: "_boxOut" });
  assert.deepEqual(emitted, []);

  actor.send({ type: "_boxIn" });
  actor.send({ type: "_edit", area: 0, question: "lower", value: "W" });
  actor.send({ type: "_edit", area: 0, question: "lower", value: "Wa" });
  assert.deepEqual(emitted, [], "not at every key");
  await tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].answers[0].lower, "Wa");
  assert.equal(emitted[0].finished, undefined);
  actor.send({ type: "_edit", area: 0, question: "lower", value: "Walk" });
  actor.send({ type: "_boxOut" });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].answers[0].lower, "Walk");
  assert.equal(emitted[1].finished, true);
  assert.equal(ctx().dirty, false);
  actor.send({ type: "_done" });
  assert.equal(emitted.length, 2, "the fold has nothing left to send");
});

test("a box taking the keyboard ends the rating before it, so the two are separate stretches", async () => {
  const { actor, emitted, tick } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_press", area: 0, value: 2 });
  await tick();
  assert.equal(emitted.length, 1);
  actor.send({ type: "_boxIn" });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].finished, true, "what was saved stays, and the stretch ends");
  actor.send({ type: "_press", area: 0, value: 3 });
  actor.send({ type: "_boxIn" });
  assert.equal(emitted.at(-1).actual[0], 3, "what waited goes along");
  assert.equal(emitted.at(-1).finished, true);
});

test("a box emptied of the wheel's only answer waits, and the fold deletes the wheel", async () => {
  const { actor, ctx, emitted, tick } = await start([{ ...wheel(A, TODAY, NONE, NONE), answers: with1(EMPTY, 0, { one: "Low" }) }]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", area: 0, question: "one", value: "" });
  await tick();
  actor.send({ type: "_boxOut" });
  assert.deepEqual(emitted, [], "the user may be clearing it only to write another");
  assert.equal(ctx().dirty, true);
  actor.send({ type: "_done" });
  assert.deepEqual([emitted[0].actual, emitted[0].answers, emitted[0].finished], [NONE, EMPTY, true]);
});

test("a change from the fact reaches the boxes only while they hold nothing unsaved", async () => {
  const { actor, ctx, tick } = await start([{ ...wheel(A, TODAY), answers: with1(EMPTY, 0, { one: "Low" }) }]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", area: 0, question: "one", value: "Typed" });
  actor.send({ type: "wheel.changed", wheel: { ...wheel(A, TODAY, ACTUAL, WANTED, 2), answers: with1(EMPTY, 0, { one: "From the phone" }) } });
  assert.equal(ctx().draft.answers[0].one, "Typed");
  await tick();
  assert.equal(ctx().dirty, false);
  actor.send({ type: "wheel.changed", wheel: { ...wheel(A, TODAY, ACTUAL, WANTED, 3), answers: with1(EMPTY, 0, { one: "Undone" }) } });
  assert.equal(ctx().draft.answers[0].one, "Undone");
});

test("a box can be typed in only while the day can be written; at 2:00 what was typed is saved and the sheet stays to be read", async () => {
  const { actor, ctx, emitted } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", area: 3, question: "closer", value: "Call home" });
  actor.send({ type: "day.shown", day: TODAY, writable: false });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].answers[3].closer, "Call home");
  assert.equal(emitted[0].finished, true);
  assert.equal(ctx().draft.answers[3].closer, "Call home", "the sheet stays, with the answer");
  assert.equal(ctx().dirty, false);
  actor.send({ type: "_edit", area: 3, question: "closer", value: "Too late" });
  actor.send({ type: "_boxOut" });
  assert.equal(ctx().draft.answers[3].closer, "Call home");
  assert.equal(emitted.length, 1);
});

test("moving to another day with a box in the middle of typing saves what was typed and folds", async () => {
  const { actor, ctx, emitted } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", area: 0, question: "lower", value: "Walking" });
  actor.send({ type: "day.shown", day: "2026-10-15", writable: true });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].answers[0].lower, "Walking");
  assert.equal(emitted[0].finished, true);
  assert.equal(ctx().draft, null);
});

test("an edit to no known question is refused", async () => {
  const { actor, ctx } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", area: 9, question: "one", value: "x" });
  actor.send({ type: "_edit", area: 0, question: "other", value: "x" });
  assert.equal(ctx().dirty, false);
});

test("text copied in the reader goes to Vim's register", async () => {
  const pushed = [];
  const actor = createActor(machine, { input: { ask: () => Promise.resolve({ wheels: [] }), mint: () => NEW, now: () => NOW, pushRegister: (t) => pushed.push(t) } });
  actor.start();
  actor.send({ type: "text.copied", text: "A passage" });
  actor.send({ type: "link.copied", text: "[A](note:1)" });
  assert.deepEqual(pushed, ["A passage", "[A](note:1)"]);
  actor.stop();
});

test("j on a box's last line and k on its first leave it, only in Vim's normal mode with nothing waiting", () => {
  const e = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...extra });
  const normal = { insertMode: false, visualMode: false, inputState: {} };
  const ends = { first: 1, last: 3 };
  assert.equal(boxEdge(e("j"), normal, 3, ends), "down");
  assert.equal(boxEdge(e("k"), normal, 1, ends), "up");
  assert.equal(boxEdge(e("j"), normal, 2, ends), null);
  assert.equal(boxEdge(e("k"), normal, 2, ends), null);
  assert.equal(boxEdge(e("j"), { ...normal, insertMode: true }, 3, ends), null);
  assert.equal(boxEdge(e("j"), { ...normal, visualMode: true }, 3, ends), null);
  assert.equal(boxEdge(e("j"), { ...normal, inputState: { operator: "d" } }, 3, ends), null);
  assert.equal(boxEdge(e("k"), { ...normal, inputState: { motionRepeat: ["2"] } }, 1, ends), null);
  assert.equal(boxEdge(e("j", { ctrlKey: true }), normal, 3, ends), null);
  assert.equal(boxEdge(e("j"), null, 3, ends), null);
});

test("which questions apply: the scale always; not lower above 1, higher below 9, closer only below Wanted", () => {
  const live = (actual, wanted) => QUESTIONS.filter((q) => applies(q, actual, wanted));
  assert.deepEqual(live(null, 8), ["one", "ten"], "no Actual");
  assert.deepEqual(live(1, 8), ["one", "ten", "higher", "closer"], "at 1");
  assert.deepEqual(live(9, 9), ["one", "ten", "lower"], "at 9, the top");
  assert.deepEqual(live(5, 8), QUESTIONS);
  assert.deepEqual(live(8, 8), ["one", "ten", "lower", "higher"], "Actual at Wanted");
  assert.deepEqual(live(7, 6), ["one", "ten", "lower", "higher"], "Actual above Wanted");
  assert.deepEqual(live(5, null), ["one", "ten", "lower", "higher"], "Wanted empty");
});

const drafted = (actual, wanted, answers = []) => ({ id: A, day: TODAY, actual: with1(NONE, 0, actual), wanted: with1(NONE, 0, wanted), answers });
const atFirst = (answer) => with1(Array(8).fill({}), 0, answer);

test("the mark counts only an answer with text to a question that applies, and a hidden answer comes back", () => {
  assert.equal(hasAnswer(drafted(5, 8), 0), false);
  assert.equal(hasAnswer(drafted(5, 8, atFirst({ one: "x" })), 0), true, "a scale answer counts");
  assert.equal(hasAnswer(drafted(null, null, atFirst({ ten: "x" })), 0), true, "with no score too");
  assert.equal(hasAnswer(drafted(5, 8, atFirst({ one: " \n " })), 0), false, "blank is no answer");
  assert.equal(hasAnswer(drafted(1, 8, atFirst({ lower: "x" })), 0), false, "not lower is hidden at 1");
  assert.equal(hasAnswer(drafted(2, 8, atFirst({ lower: "x" })), 0), true, "and back at 2");
  assert.equal(hasAnswer(drafted(10, 10, atFirst({ higher: "x" })), 0), false, "higher is hidden at 10");
  assert.equal(hasAnswer(drafted(8, 8, atFirst({ closer: "x" })), 0), false, "closer is hidden at Wanted");
  assert.equal(hasAnswer(drafted(null, 8, atFirst({ closer: "x", lower: "y", higher: "z" })), 0), false, "the score's questions are hidden with no Actual");
  assert.equal(hasAnswer(drafted(5, 8, atFirst({ one: "x" })), 1), false, "another area");
  assert.equal(hasAnswer({ ...drafted(5, 8), answers: undefined }, 0), false);
  assert.equal(answerOf([{ one: 7 }], 0, "one"), "");
});

test("the panel's wording, examples and notes", async () => {
  const { actor, ctx } = await start([]);
  actor.send({ type: "add" });
  const panelAt = (i) => {
    actor.send({ type: "_cursor", to: i });
    return panelOf(ctx(), ctx().draft);
  };
  const unrated = panelAt(7);
  assert.equal(unrated.name, "Fun");
  assert.equal(unrated.label, "Questions about Fun");
  assert.deepEqual(unrated.groups.map((g) => g.title), ["The scale", "Your score"]);
  assert.deepEqual(unrated.groups[0].items.map((q) => q.text), ["What does a 1 look like for you?", "What does a 9 look like for you?"]);
  assert.deepEqual(unrated.groups[0].items.map((q) => q.hint), EXAMPLES[7]);
  assert.equal(unrated.groups[0].note, null);
  assert.equal(unrated.groups[1].note, "Give Fun an Actual score to answer these.");
  assert.deepEqual(unrated.groups[1].items, []);

  actor.send({ type: "_mode", mode: "wanted" });
  actor.send({ type: "_press", area: 1, value: 8 });
  actor.send({ type: "_mode", mode: "actual" });
  actor.send({ type: "_press", area: 1, value: 6 });
  const rated = panelOf(ctx(), ctx().draft);
  assert.equal(rated.groups[1].note, null);
  assert.deepEqual(rated.groups[1].items.map((q) => q.text), [
    "What makes it a 6, and not lower?",
    "What keeps it from being higher?",
    "What would move it one point closer to Wanted?",
  ]);
  assert.equal(rated.emptyLine, null);
  assert.equal(EXAMPLES.length, AREAS.length);
  assert.equal(wording("lower", 3), "What makes it a 3, and not lower?");
});


test("an earlier day's panel lists only what was written, and says so when nothing was", async () => {
  const answers = with1(atFirst({ one: "Low", ten: "  ", lower: "Because", closer: "Hidden at Wanted" }), 2, { higher: "Only this" });
  const { actor, ctx } = await start([{ ...wheel(A, EARLIER, with1(ACTUAL, 0, 8), with1(WANTED, 0, 8)), answers }]);
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  actor.send({ type: "_open", id: A });
  const first = panelOf(ctx(), ctx().draft);
  assert.deepEqual(first.groups.map((g) => [g.title, g.note, g.items.map((q) => q.value)]), [
    ["The scale", null, ["Low"]],
    ["Your score", null, ["Because"]],
  ]);
  actor.send({ type: "_cursor", to: 2 });
  assert.deepEqual(panelOf(ctx(), ctx().draft).groups.map((g) => g.title), ["Your score"], "a group with nothing written goes");
  actor.send({ type: "_cursor", to: 3 });
  const none = panelOf(ctx(), ctx().draft);
  assert.deepEqual(none.groups, []);
  assert.equal(none.emptyLine, "Nothing written about Family on this day.");
});

test("the line beside a closed panel says what the arrow does", async () => {
  const { actor, ctx } = await start([]);
  assert.equal(panelHint(ctx()), "Press an area’s arrow to write about it.");
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  assert.equal(panelHint(ctx()), "Press an area’s arrow to read what you wrote.");
});

test("an earlier day is read only: it opens, takes no score and no delete, and closes", async () => {
  const { actor, ctx, emitted, tick } = await start([wheel(A, EARLIER)]);
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  actor.send({ type: "_open", id: A });
  assert.equal(ctx().draft.id, A);
  actor.send({ type: "_press", area: 0, value: 1 });
  actor.send({ type: "_step", more: true });
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

test("the keys of a sheet: arrows always, with Shift choosing the tab; letters only with Vim keys", () => {
  const key = (k, shiftKey = false) => ({ key: k, shiftKey });
  assert.deepEqual(sheetKey(key("ArrowDown"), false), { move: "down" });
  assert.deepEqual(sheetKey(key("ArrowUp", true), false), { move: "up" });
  assert.deepEqual(sheetKey(key("ArrowRight"), false), { step: true, more: true });
  assert.deepEqual(sheetKey(key("ArrowLeft"), false), { step: true, more: false });
  assert.deepEqual(sheetKey(key("ArrowRight", true), false), { choose: "wanted" });
  assert.deepEqual(sheetKey(key("ArrowLeft", true), false), { choose: "actual" });
  for (const k of ["j", "k", "g", "G", "h", "l", "H", "L"]) assert.equal(sheetKey(key(k), false), null, k);
  assert.deepEqual(sheetKey(key("j"), true), { move: "down", walk: true });
  assert.deepEqual(sheetKey(key("k"), true), { move: "up", walk: true });
  assert.deepEqual(sheetKey(key("ArrowDown"), true), { move: "down" }, "an arrow does not walk into a box");
  assert.deepEqual(sheetKey(key("G"), true), { move: "last" });
  assert.deepEqual(sheetKey(key("g"), true), { wait: true });
  assert.deepEqual(sheetKey(key("g"), true, true), { move: "first" });
  assert.deepEqual(sheetKey(key("l"), true), { step: true, more: true });
  assert.deepEqual(sheetKey(key("h"), true), { step: true, more: false });
  assert.deepEqual(sheetKey(key("L", true), true), { choose: "wanted" });
  assert.deepEqual(sheetKey(key("H", true), true), { choose: "actual" });
  assert.equal(sheetKey({ key: "j", ctrlKey: true }, true), null, "Ctrl+j is the desk's");
  assert.deepEqual(rowKey(key("j"), true), { move: "down" });
  assert.equal(rowKey(key("j"), false), null);
  assert.equal(rowKey(key("l"), true), null);
  assert.equal(rowKey(key("ArrowLeft"), true), null, "an earlier day takes no score");
});

test("a move along a sheet you can write: the tabs, the areas, the areas to focus on, and out past either end", () => {
  const go = (move, on, cursor) => sheetTarget(move, on, cursor, true);
  assert.equal(go("up", "area", 0), "tabs", "k from the first area lands on the tabs");
  assert.equal(go("down", "tabs", 0), 0, "and j goes back");
  assert.equal(go("down", "tabs", 5), 0, "to the first area, whichever the cursor is on");
  assert.equal(go("up", "tabs", 0), "leave", "past the tabs");
  assert.equal(go("down", "area", 0), 1);
  assert.equal(go("up", "area", 3), 2);
  assert.equal(go("down", "area", 7), "choose", "past the last area, the areas to focus on");
  assert.equal(go("up", "choose", 3), 7, "and k goes back to the last area");
  assert.equal(go("down", "choose", 3), "leave", "past the areas to focus on");
  for (const on of ["tabs", "area", "button", "choose"]) {
    assert.equal(go("first", on, 5), 0, on);
    assert.equal(go("last", on, 5), 7, on);
  }
  assert.equal(go("down", "button", 4), 4, "from Delete or Done, first to the area the keys act on");
  assert.equal(go("up", "button", 4), 4);
});

test("a move along an earlier day's sheet: the areas, then Close, with no tabs", () => {
  const go = (move, on, cursor) => sheetTarget(move, on, cursor, false);
  assert.equal(go("up", "area", 0), "leave", "no tabs to land on");
  assert.equal(go("down", "area", 6), 7);
  assert.equal(go("down", "area", 7), "close");
  assert.equal(go("up", "close", 7), 7, "and back");
  assert.equal(go("down", "close", 7), "leave");
  assert.equal(go("first", "close", 7), 0);
  assert.equal(go("last", "area", 0), 7);
});

test("j and k through an open panel: into its boxes, on to the next area, and back the same way", () => {
  assert.deepEqual(panelTarget("down", 0), { area: 0, edge: "first" });
  assert.deepEqual(panelTarget("down", 7), { area: 7, edge: "first" });
  assert.deepEqual(panelTarget("up", 3), { area: 2, edge: "last" }, "k takes back the j past that box");
  assert.equal(panelTarget("up", 0), null, "above the first area the tabs come, as without a panel");
  assert.equal(pastLastBox(0), 1);
  assert.equal(pastLastBox(6), 7);
  assert.equal(pastLastBox(7), "choose", "past the last area's last box, the areas to focus on");
});

test("the scores step and clear", () => {
  assert.equal(pressed(6, 6), null);
  assert.equal(pressed(6, 7), 7);
  assert.equal(stepped(null, true), 1);
  assert.equal(stepped(STEPS, true), 9, "9 is the top of the scale");
  assert.equal(stepped(8, true), 9);
  assert.equal(stepped(1, false), null);
  assert.equal(stepped(null, false), null);
  assert.equal(stepped(5, false), 4);
});

test("a card names the areas chosen and the next steps written for them, and a 10 from before reads as 9", () => {
  const focus = with1(with1(Array(8).fill(false), 5, true), 7, true);
  const answers = with1(with1(Array(8).fill({}), 7, { closer: "Book the gym" }), 5, { one: "No one" });
  assert.equal(chosenOf({ focus }), "Friends and Fun");
  assert.equal(chosenOf({ focus: with1(focus, 0, true) }), "Health, Friends and Fun");
  assert.equal(chosenOf({ focus: Array(8).fill(false) }), "");
  assert.equal(chosenOf({}), "", "a wheel from before choosing");
  assert.deepEqual(nextSteps({ focus, answers }), [{ name: "Fun", text: "Book the gym" }], "Friends has no closer answer");
  assert.deepEqual(nextSteps({ focus: Array(8).fill(false), answers }), [], "an answer of an area not chosen is no next step");
  assert.equal(shown(10), 9);
  assert.equal(shown(null), null);
  assert.match(wheelLabel({ actual: with1(NONE, 0, 6), wanted: with1(NONE, 0, 10) }), /^Health: actual 6, wanted 9; Work: actual not rated/);
});

test("the sheet names the wheel it was copied from while it reads the same, and only where it can be", async () => {
  const { actor, ctx } = await start([wheel(OLD, LONG_AGO, ACTUAL, WANTED)]);
  actor.send({ type: "add" });
  assert.equal(copiedLabel(ctx(), ctx().draft), "Copied from your wheel of 6 October.");
  actor.send({ type: "_press", area: 0, value: 1 });
  assert.equal(copiedLabel(ctx(), ctx().draft), "", "any change");
  actor.send({ type: "_press", area: 0, value: ACTUAL[0] });
  assert.equal(copiedLabel(ctx(), ctx().draft), "Copied from your wheel of 6 October.", "the same again reads as copied");
  actor.send({ type: "_choose", area: 3 });
  assert.equal(copiedLabel(ctx(), ctx().draft), "", "a choice is a change too");

  const context = { ...ctx(), dayWritable: false };
  assert.equal(copiedLabel(context, ctx().draft), "", "an earlier day is only read");

  const first = await start([]);
  first.actor.send({ type: "add" });
  assert.equal(copiedLabel(first.ctx(), first.ctx().draft), "", "the first wheel is copied from nothing");

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

test("a wheel holds something by a score or an answer with text; the areas chosen alone keep nothing", async () => {
  const { ctx } = await start([wheel(OLD, EARLIER, ACTUAL, WANTED)]);
  assert.equal(carriedFrom(ctx(), TODAY).id, OLD);
  assert.equal(carriedFrom(ctx(), EARLIER), null);
  const empty = Array(8).fill({});
  assert.equal(holdsAny({ actual: NONE, wanted: NONE, answers: empty }), false);
  assert.equal(holdsAny({ actual: NONE, wanted: with1(NONE, 0, 1), answers: empty }), true, "a Wanted score");
  assert.equal(holdsAny({ actual: with1(NONE, 0, 1), wanted: NONE, answers: empty }), true, "an Actual score");
  assert.equal(holdsAny({ actual: NONE, wanted: NONE, answers: with1(empty, 1, { closer: "Call" }) }), true, "only an answer");
  assert.equal(holdsAny({ actual: NONE, wanted: NONE, answers: with1(empty, 1, { closer: " \n " }) }), false, "only spaces");
  assert.equal(holdsAny({ actual: NONE, wanted: NONE, answers: empty, focus: Array(8).fill(true) }), false, "only areas chosen");
});

test("choosing an area toggles it, is saved with the scores, and an earlier day takes no choice", async () => {
  const { actor, ctx, emitted, tick } = await start([wheel(A, TODAY)]);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_choose", area: 5 });
  actor.send({ type: "_choose", area: 7 });
  actor.send({ type: "_choose", area: 5 });
  assert.deepEqual(ctx().draft.focus, with1(Array(8).fill(false), 7, true));
  await tick();
  assert.deepEqual(emitted.at(-1).focus, with1(Array(8).fill(false), 7, true));
  actor.send({ type: "day.shown", day: TODAY, writable: false });
  actor.send({ type: "_choose", area: 0 });
  assert.equal(ctx().draft.focus[0], false, "read only");
});
