import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, dateOf, writable, chooserOf, setLine, cardOf, changedSince, offTopic, occasionOf, rowAction, rowTarget, boxEdge } from "../machine.js";

const SAVED = JSON.parse(readFileSync(new URL("../events/prompt-sheet.saved.json", import.meta.url), "utf8"));
const recorded = [];

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const TODAY = "2026-10-14";
const EARLIER = "2026-10-12";
const A = "01K6TEST000000000000000PS1";
const B = "01K6TEST000000000000000PS2";
const S1 = "01K6TEST000000000000000ST1";

const set = (id, name, prompts, rest = {}) => ({ id, name, occasion: "Evening", basedOn: "Flourish, Martin Seligman", prompts, position: "a", version: 1, pending: false, ...rest });
const EVENING = set(S1, "Three good things", ["What went well today?", "Why did it happen?"]);

const sheet = (id, day, answers, rest = {}) => ({
  id,
  day,
  setId: S1,
  setName: "Three good things",
  basedOn: "Flourish, Martin Seligman",
  answers: answers.map(([prompt, answer, fits = null]) => ({ prompt, answer, fits })),
  createdAt: "2026-10-14T07:30:00.000Z",
  version: 1,
  pending: false,
  ...rest,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

// `days` maps a date to the sheets the fact answers for it; `sets` is what prompt-sets
// answers; `vimKeys` the settings fact's answer, or none when the page holds no settings.
async function start({ days = {}, sets = [EVENING], vimKeys, unfolded } = {}) {
  let n = 0;
  const asked = [];
  const sent = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target, name, payload) => {
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        if (target === "prompt-sets") return Promise.resolve({ sets });
        asked.push({ target, name, payload });
        return Promise.resolve({ sheets: days[payload.day] ?? [], total: (days[payload.day] ?? []).length });
      },
      send: (...args) => sent.push(args),
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      now: () => NOW,
      throttleMs: 400,
      ...(unfolded ? { unfolded } : {}),
    },
  });
  const emitted = [];
  actor.on("prompt-sheet.saved", (e) => {
    emitted.push(e);
    recorded.push(e);
  });
  actor.start();
  await flush();
  return { actor, clock, emitted, asked, sent, ctx: () => actor.getSnapshot().context, state: () => actor.getSnapshot().value };
}

// Every save the tests made matches the event's schema, as the bus would check it.
after(() => {
  const v = new Validator(SAVED, "2020-12");
  for (const { type, ...payload } of recorded) assert.ok(v.validate(payload).valid, `prompt-sheet.saved: ${JSON.stringify(payload)}`);
});

test("add opens a new sheet showing the sets, and picking one gives it the set's prompts", async () => {
  const { actor, ctx, emitted, asked } = await start();
  assert.deepEqual(asked, [{ target: "prompt-sheets", name: "list", payload: { day: TODAY } }]);
  actor.send({ type: "add" });
  const [draft] = ctx().drafts;
  assert.equal(draft.setId, null);
  assert.equal(ctx().landing, 1);
  actor.send({ type: "_pick", id: draft.id, setId: S1 });
  assert.deepEqual(ctx().drafts[0].answers, [
    { prompt: "What went well today?", answer: "" },
    { prompt: "Why did it happen?", answer: "" },
  ]);
  assert.equal(ctx().drafts[0].setName, "Three good things");
  assert.deepEqual(emitted, [], "nothing is kept before something is written");
});

test("typing saves at the throttle's end without finished, and the box losing the keyboard saves with finished", async () => {
  const { actor, ctx, clock, emitted } = await start();
  actor.send({ type: "add" });
  const id = ctx().drafts[0].id;
  actor.send({ type: "_pick", id, setId: S1 });
  actor.send({ type: "_edit", id, index: 0, value: "A walk" });
  actor.send({ type: "_edit", id, index: 0, value: "A walk in the sun" });
  assert.deepEqual(emitted, []);
  clock.increment(400);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].finished, undefined);
  assert.equal(emitted[0].answers[0].answer, "A walk in the sun");
  assert.equal(emitted[0].day, TODAY);
  actor.send({ type: "_blur", id });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].finished, true);
  actor.send({ type: "_blur", id });
  assert.equal(emitted.length, 2, "a blur with nothing new typed saves nothing");
});

test("Done folds a sheet with its stretch finished; a sheet still showing the sets, or never written, just goes", async () => {
  const { actor, ctx, emitted } = await start();
  actor.send({ type: "add" });
  actor.send({ type: "_done", id: ctx().drafts[0].id });
  assert.deepEqual(ctx().drafts, []);
  actor.send({ type: "add" });
  const id = ctx().drafts[0].id;
  actor.send({ type: "_pick", id, setId: S1 });
  actor.send({ type: "_done", id });
  assert.deepEqual(emitted, []);
  actor.send({ type: "add" });
  const id2 = ctx().drafts[0].id;
  actor.send({ type: "_pick", id: id2, setId: S1 });
  actor.send({ type: "_edit", id: id2, index: 1, value: "Because I went out" });
  actor.send({ type: "_done", id: id2 });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].finished, true);
  assert.deepEqual(ctx().drafts, []);
});

test("a kept sheet folded with every answer emptied is saved empty, which removes it", async () => {
  const kept = sheet(A, TODAY, [["What went well today?", "A walk"], ["Why did it happen?", ""]]);
  const { actor, emitted, clock } = await start({ days: { [TODAY]: [kept] } });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", id: A, index: 0, value: "  " });
  clock.increment(400);
  assert.deepEqual(emitted, [], "an emptied sheet is not saved while open");
  actor.send({ type: "_done", id: A });
  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].answers.every((a) => !a.answer.trim()));
});

test("Remove from this day saves what waits first, then says deleted; a new empty one sends nothing", async () => {
  const kept = sheet(A, TODAY, [["What went well today?", "A walk"], ["Why did it happen?", ""]]);
  const { actor, ctx, emitted } = await start({ days: { [TODAY]: [kept] } });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", id: A, index: 1, value: "Sun" });
  actor.send({ type: "_delete", id: A });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].answers[1].answer, "Sun");
  assert.equal(emitted[0].deleted, undefined);
  assert.equal(emitted[1].deleted, true);
  assert.deepEqual(ctx().drafts, []);
  actor.send({ type: "add" });
  actor.send({ type: "_delete", id: ctx().drafts[0].id });
  assert.equal(emitted.length, 2);
  assert.deepEqual(ctx().drafts, []);
});

test("an earlier day is read only: no add, no typing, no removing, and a card opens to be read", async () => {
  const kept = sheet(A, EARLIER, [["What went well today?", "A walk"]]);
  const { actor, ctx, emitted } = await start({ days: { [EARLIER]: [kept] } });
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  await flush();
  assert.equal(writable(ctx()), false);
  actor.send({ type: "add" });
  assert.deepEqual(ctx().drafts, []);
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", id: A, index: 0, value: "Changed" });
  actor.send({ type: "_delete", id: A });
  actor.send({ type: "_done", id: A });
  assert.deepEqual(emitted, []);
  assert.deepEqual(ctx().drafts, []);
});

test("an open sheet follows the fact while nothing typed waits, and one deleted elsewhere closes", async () => {
  const kept = sheet(A, TODAY, [["What went well today?", "A walk"], ["Why did it happen?", ""]]);
  const { actor, ctx } = await start({ days: { [TODAY]: [kept] } });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "prompt-sheet.changed", sheet: { ...kept, answers: [{ ...kept.answers[0], answer: "A run" }, kept.answers[1]], version: 2 } });
  assert.equal(ctx().drafts[0].answers[0].answer, "A run");
  actor.send({ type: "prompt-sheet.changed", sheet: { ...kept, version: 1 } });
  assert.equal(ctx().sheets[0].version, 2, "an older version is stale");
  actor.send({ type: "_edit", id: A, index: 1, value: "Sun" });
  actor.send({ type: "prompt-sheet.changed", sheet: { ...kept, version: 3 } });
  assert.equal(ctx().drafts[0].answers[1].answer, "Sun", "what is typed is not overwritten");
  actor.send({ type: "prompt-sheet.changed", sheet: sheet(B, EARLIER, [["x", "y"]]) });
  assert.equal(ctx().sheets.length, 1, "another day's sheet passes by");
  actor.send({ type: "prompt-sheet.deleted", id: A, day: TODAY });
  assert.deepEqual(ctx().drafts, []);
  assert.deepEqual(ctx().sheets, []);
});

test("sheets left unfolded open again after a reload; a new day saves what waits and asks for its sheets", async () => {
  const kept = sheet(A, TODAY, [["What went well today?", "A walk"]]);
  const { actor, ctx, emitted, asked } = await start({ days: { [TODAY]: [kept] }, unfolded: { read: (day) => (day === TODAY ? [A, B] : []) } });
  assert.deepEqual(ctx().drafts.map((d) => d.id), [A]);
  actor.send({ type: "_edit", id: A, index: 0, value: "A long walk" });
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  assert.equal(emitted.length, 1);
  await flush();
  assert.deepEqual(asked.at(-1).payload, { day: EARLIER });
  assert.deepEqual(ctx().drafts, []);
});

test("the chooser shows the first four sets and N more, and sets follow prompt-sets", async () => {
  const sets = ["a", "b", "c", "d", "e", "f"].map((p, i) => set(`01K6TEST000000000000000S0${i}`, `Set ${p}`, ["Q?"], { position: p }));
  const { actor, ctx } = await start({ sets: [...sets].reverse() });
  actor.send({ type: "add" });
  const id = ctx().drafts[0].id;
  assert.deepEqual(chooserOf(ctx(), id).shown.map((s) => s.name), ["Set a", "Set b", "Set c", "Set d"]);
  assert.equal(chooserOf(ctx(), id).more, 2);
  actor.send({ type: "_more", id });
  assert.equal(chooserOf(ctx(), id).shown.length, 6);
  actor.send({ type: "prompt-set.deleted", id: sets[0].id });
  actor.send({ type: "prompt-set.changed", set: { ...sets[1], prompts: [] } });
  assert.deepEqual(chooserOf(ctx(), id).shown.map((s) => s.name), ["Set c", "Set d", "Set e", "Set f"], "a set without prompts is not offered");
  actor.send({ type: "_pick", id, setId: sets[1].id });
  assert.equal(ctx().drafts[0].setId, null, "nor picked");
});

test("a set's line says how many prompts and the book; its occasion comes from the set as it is now", () => {
  assert.equal(setLine(EVENING), "2 prompts · based on Flourish, Martin Seligman");
  assert.equal(setLine({ ...EVENING, prompts: ["One?"], basedOn: "" }), "1 prompt");
  assert.equal(occasionOf({ sets: [EVENING] }, S1), "Evening");
  assert.equal(occasionOf({ sets: [] }, S1), "");
});

test("the card lists answered prompts only, the first three and then a count", () => {
  const four = sheet(A, TODAY, [["1?", "one"], ["2?", " "], ["3?", "three"], ["4?", "four"], ["5?", "five"]]);
  const card = cardOf(four);
  assert.deepEqual(card.shown.map((a) => a.prompt), ["1?", "3?", "4?"]);
  assert.equal(card.more, 1);
  assert.equal(cardOf(sheet(A, TODAY, [["1?", "one"]])).more, 0);
});

test("the set has changed since when it now asks other prompts; a set that is gone says nothing", () => {
  const kept = sheet(A, EARLIER, [["What went well today?", "A walk"], ["Why did it happen?", ""]]);
  assert.equal(changedSince({ sets: [EVENING] }, kept), false);
  assert.equal(changedSince({ sets: [{ ...EVENING, prompts: ["What went well today?"] }] }, kept), true);
  assert.equal(changedSince({ sets: [{ ...EVENING, prompts: ["What went well?", "Why did it happen?"] }] }, kept), true);
  assert.equal(changedSince({ sets: [] }, kept), false);
});

test("an answer judged not to fit is marked until its words change; one that fits or is not judged is not", async () => {
  const kept = sheet(A, TODAY, [["What went well today?", "Pizza is round", false], ["Why did it happen?", "Sun", true], ["Else?", "x", null]]);
  const { actor, ctx } = await start({ days: { [TODAY]: [kept] } });
  assert.equal(offTopic(ctx(), A, 0), true, "on the folded card's record");
  assert.equal(offTopic(ctx(), A, 1), false);
  assert.equal(offTopic(ctx(), A, 2), false);
  actor.send({ type: "_open", id: A });
  assert.equal(offTopic(ctx(), A, 0), true);
  actor.send({ type: "_edit", id: A, index: 0, value: "A walk" });
  assert.equal(offTopic(ctx(), A, 0), false);
});

test("an add during the load acts once the day is in; a failed load hands the keyboard back", async () => {
  let release;
  const sent = [];
  const actor = createActor(machine, {
    input: {
      ask: (target) => (target === "prompt-sheets" ? new Promise((r) => (release = r)) : Promise.resolve({ error: "no-answerer" })),
      send: (...args) => sent.push(args),
      mint: () => A,
      now: () => NOW,
    },
  });
  actor.start();
  actor.send({ type: "add" });
  release({ sheets: [], total: 0 });
  await flush();
  assert.equal(actor.getSnapshot().context.drafts.length, 1);

  const failing = createActor(machine, {
    input: { ask: (target) => Promise.resolve(target === "prompt-sheets" ? { error: "no-answerer" } : {}), send: (...args) => sent.push(args), mint: () => B, now: () => NOW },
  });
  failing.start();
  await flush();
  assert.equal(failing.getSnapshot().value, "failed");
  failing.send({ type: "add" });
  assert.deepEqual(sent.at(-1), ["sheet-picker", "focus", {}]);
});

test("Vim keys follow settings; the keys of the list and of a box's edges", async () => {
  const { actor, ctx } = await start({ vimKeys: true });
  assert.equal(ctx().vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(ctx().vimKeys, false);
  const key = (k, more = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...more });
  assert.equal(rowAction(key("ArrowDown"), false), "down");
  assert.equal(rowAction(key("j"), false), null);
  assert.equal(rowAction(key("j"), true), "down");
  assert.equal(rowAction(key("g"), true), "g");
  assert.equal(rowAction(key("g"), true, true), "first");
  assert.equal(rowAction(key("o"), true), "add");
  assert.equal(rowAction(key("j", { ctrlKey: true }), true), null);
  assert.equal(rowTarget("down", 0, 2), 1);
  assert.equal(rowTarget("down", 1, 2), "leave");
  assert.equal(rowTarget("up", 0, 2), "leave");
  const normal = { insertMode: false, visualMode: false, inputState: {} };
  assert.equal(boxEdge(key("j"), normal, 3, { first: 1, last: 3 }), "down");
  assert.equal(boxEdge(key("j"), normal, 2, { first: 1, last: 3 }), null);
  assert.equal(boxEdge(key("k"), normal, 1, { first: 1, last: 3 }), "up");
  assert.equal(boxEdge(key("j"), { ...normal, insertMode: true }, 3, { first: 1, last: 3 }), null);
  assert.equal(boxEdge(key("j"), { ...normal, inputState: { operator: "d" } }, 3, { first: 1, last: 3 }), null);
  assert.equal(dateOf(NOW), TODAY);
});
