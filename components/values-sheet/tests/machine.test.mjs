import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, dateOf, dayName, writable, shownValues, earlierDays, changedLine, boxMarks, marksFor, warned, statusOf, sureOf, rowKey, suggestionFor, sourceOf, cleaned } from "../machine.js";

const SCHEMA = JSON.parse(readFileSync(new URL("../events/values.saved.json", import.meta.url), "utf8"));
const recorded = [];

const NOW = new Date(2026, 9, 24, 9, 30).getTime();
const TODAY = "2026-10-24";
const YESTERDAY = "2026-10-23";
const EARLIER = "2026-10-12";
const id = (n) => `01K6TEST00000000000000VAR${n}`;
const v = (n, name, meaning = "") => ({ id: id(n), name, meaning });

const flush = () => new Promise((r) => setTimeout(r, 0));

// `versions` maps a day a version was written to its values; the fake answers read as the
// values fact does, the latest version on or before the day asked.
async function start(versions = {}, { vimKeys, undoMs = 3000, checks, evaluators, suggestions } = {}) {
  let n = 0;
  const asked = [];
  const clock = new SimulatedClock();
  // Read at each ask, so a test can change what the fact holds.
  const daysOf = () => Object.keys(versions).sort();
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target, name, payload) => {
        asked.push({ target, name, payload });
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        if (target === "value-checks") return Promise.resolve(checks ?? { error: "no-answerer" });
        if (target === "evaluators") return Promise.resolve(evaluators ? { evaluators } : { error: "no-answerer" });
        if (target === "generators") return Promise.resolve(suggestions ? { results: suggestions } : { error: "no-answerer" });
        const days = daysOf();
        if (name === "versions") return Promise.resolve({ days });
        const on = days.filter((d) => payload.day === undefined || d <= payload.day).at(-1) ?? null;
        return Promise.resolve({ day: on, values: on ? versions[on] : [], changedSince: payload.day !== undefined && days.some((d) => d > payload.day) });
      },
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      now: () => NOW,
      throttleMs: 400,
      undoMs,
    },
  });
  const emitted = [];
  actor.on("values.saved", (e) => {
    emitted.push(e);
    recorded.push(e);
  });
  actor.start();
  await flush();
  return { actor, clock, emitted, asked, ctx: () => actor.getSnapshot().context, state: () => actor.getSnapshot().value };
}

// Every emit of the suite matches its schema.
after(() => {
  for (const { type, ...rest } of recorded) assert.ok(new Validator(SCHEMA, "2020-12").validate(rest).valid, JSON.stringify(rest));
});

test("it asks the shown day's version and the days, and follows day.shown", async () => {
  assert.equal(dateOf(NOW), TODAY);
  const { actor, asked, ctx } = await start({ [EARLIER]: [v(1, "Honest")] });
  assert.deepEqual(
    asked.filter((a) => a.target === "values").map((a) => [a.name, a.payload]),
    [["read", { day: TODAY }], ["versions", {}]],
  );
  assert.deepEqual(ctx().version, { day: EARLIER, values: [v(1, "Honest")], changedSince: false });
  assert.deepEqual(ctx().days, [EARLIER]);

  actor.send({ type: "day.shown", day: TODAY, writable: true });
  await flush();
  assert.equal(asked.filter((a) => a.target === "values" && a.name === "read").length, 1, "the same day is not asked again");
  actor.send({ type: "day.shown", day: YESTERDAY, writable: true });
  await flush();
  assert.deepEqual(asked.filter((a) => a.target === "values" && a.name === "read").at(-1).payload, { day: YESTERDAY });
  assert.equal(ctx().day, YESTERDAY);
});

test("only today's page writes, also not yesterday in its hour after midnight", async () => {
  const { actor, ctx } = await start();
  assert.equal(writable(ctx()), true);
  actor.send({ type: "day.shown", day: YESTERDAY, writable: true });
  await flush();
  assert.equal(writable(ctx()), false, "yesterday's text may be open, its values are not");
  actor.send({ type: "day.shown", day: TODAY, writable: false });
  await flush();
  assert.equal(writable(ctx()), false, "a day the journal closes is read only");
});

test("opening today with no values starts one empty row; typing saves at a throttle and at once on blur", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "_open" });
  assert.equal(ctx().drafts.length, 1);
  const row = ctx().drafts[0].id;
  actor.send({ type: "_edit", id: row, field: "name", value: "Being" });
  clock.increment(200);
  actor.send({ type: "_edit", id: row, field: "name", value: "Being a present parent" });
  assert.equal(emitted.length, 0, "nothing per keystroke");
  clock.increment(200);
  assert.deepEqual(emitted, [{ type: "values.saved", day: TODAY, values: [{ id: row, name: "Being a present parent", meaning: "" }] }]);

  actor.send({ type: "_edit", id: row, field: "meaning", value: "Time with\nthe kids" });
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].values[0].meaning, "Time with the kids", "a box holds one line");
  clock.increment(1000);
  assert.equal(emitted.length, 2, "the blur's save ended the window");
});

test("a row with neither a name nor a sentence is not saved, and its removal is at once", async () => {
  const { actor, emitted, ctx } = await start({ [TODAY]: [v(1, "Honest")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_add" });
  const row = ctx().drafts[1].id;
  actor.send({ type: "_edit", id: row, field: "name", value: "  " });
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted.at(-1).values, [v(1, "Honest")]);
  actor.send({ type: "_remove", id: row });
  assert.deepEqual(ctx().drafts, [v(1, "Honest")]);
  assert.deepEqual(ctx().removing, []);
});

test("removing a value waits out the undo window; Undo keeps it, and the end saves without it", async () => {
  const { actor, clock, emitted, ctx } = await start({ [TODAY]: [v(1, "Honest"), v(2, "Kind")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_remove", id: id(1) });
  assert.deepEqual(ctx().removing, [id(1)]);
  assert.deepEqual(shownValues(ctx()), [v(2, "Kind")]);
  clock.increment(1000);
  actor.send({ type: "_undo", id: id(1) });
  clock.increment(5000);
  assert.equal(emitted.length, 0, "Undo cancelled the removal");
  assert.equal(ctx().drafts.length, 2);

  actor.send({ type: "_remove", id: id(2) });
  // The window goes on while the sheet is folded.
  actor.send({ type: "_done" });
  assert.deepEqual(shownValues(ctx()), [v(1, "Honest")]);
  clock.increment(3000);
  assert.deepEqual(emitted.at(-1), { type: "values.saved", day: TODAY, values: [v(1, "Honest")] });
  assert.deepEqual(ctx().removing, []);
});

test("moving to another day ends an undo window at once", async () => {
  const { actor, emitted } = await start({ [TODAY]: [v(1, "Honest"), v(2, "Kind")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_remove", id: id(1) });
  actor.send({ type: "day.shown", day: YESTERDAY });
  assert.deepEqual(emitted.at(-1), { type: "values.saved", day: TODAY, values: [v(2, "Kind")] });
});

test("an earlier day is read only and says when the values changed since", async () => {
  const { actor, emitted, ctx } = await start({ [EARLIER]: [v(1, "Honest")], [TODAY]: [v(1, "Honest"), v(2, "Kind")] });
  actor.send({ type: "day.shown", day: YESTERDAY, writable: true });
  await flush();
  assert.deepEqual(ctx().version, { day: EARLIER, values: [v(1, "Honest")], changedSince: true });
  actor.send({ type: "_open" });
  actor.send({ type: "_edit", id: id(1), field: "name", value: "Brave" });
  actor.send({ type: "_add" });
  actor.send({ type: "_remove", id: id(1) });
  actor.send({ type: "_done" });
  assert.equal(emitted.length, 0);
  assert.equal(changedLine(ctx()), "Last changed 12 October");

  actor.send({ type: "_open" });
  actor.send({ type: "_see" });
  await flush();
  assert.deepEqual(ctx().viewing, { kind: "current", day: TODAY, values: [v(1, "Honest"), v(2, "Kind")] });
  actor.send({ type: "_back" });
  assert.equal(ctx().viewing, null);
});

test("earlier versions are listed before the shown one, and one picked is shown", async () => {
  const { actor, ctx } = await start({ "2026-09-01": [v(1, "Calm")], [EARLIER]: [v(1, "Honest")], [TODAY]: [v(2, "Kind")] });
  assert.equal(changedLine(ctx()), "Changed today");
  assert.deepEqual(earlierDays(ctx()), [EARLIER, "2026-09-01"]);
  actor.send({ type: "_open" });
  actor.send({ type: "_browse" });
  assert.equal(ctx().browsing, true);
  actor.send({ type: "_see", day: "2026-09-01" });
  await flush();
  assert.deepEqual(ctx().viewing, { kind: "earlier", day: "2026-09-01", values: [v(1, "Calm")] });
  assert.equal(ctx().browsing, false);
});

test("values.changed is followed, also by an open sheet with nothing waiting, and marks a past day changed", async () => {
  const { actor, ctx } = await start({ [TODAY]: [v(1, "Honest")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_add" });
  const blankRow = ctx().drafts[1].id;
  actor.send({ type: "values.changed", day: TODAY, values: [v(1, "Honest too"), v(3, "Brave")] });
  assert.deepEqual(ctx().drafts.map((d) => d.id), [id(1), blankRow, id(3)], "the empty row stays where it was");
  assert.equal(ctx().drafts[0].name, "Honest too");

  actor.send({ type: "_edit", id: id(1), field: "name", value: "Mine" });
  actor.send({ type: "values.changed", day: TODAY, values: [v(1, "Theirs")] });
  assert.equal(ctx().drafts[0].name, "Mine", "typing waiting to be saved is not overwritten");

  actor.send({ type: "day.shown", day: YESTERDAY });
  await flush();
  actor.send({ type: "values.changed", day: TODAY, values: [v(1, "Later")] });
  await flush();
  assert.equal(ctx().version.changedSince, true);
});

test("after a change the days listed and Changed since are asked again, as the fact says them", async () => {
  const versions = { [EARLIER]: [v(1, "Honest")], [TODAY]: [v(2, "Kind")] };
  const { actor, ctx, asked } = await start(versions);
  assert.deepEqual(earlierDays(ctx()), [EARLIER]);
  // Today's edit made the earlier version read as today's, so the fact no longer lists it.
  delete versions[EARLIER];
  const before = asked.length;
  actor.send({ type: "values.changed", day: TODAY, values: [v(1, "Honest")] });
  await flush();
  assert.deepEqual(asked.slice(before).map((a) => a.name).sort(), ["read", "versions"]);
  assert.deepEqual(earlierDays(ctx()), []);
  assert.deepEqual(ctx().version.values, [v(1, "Honest")], "the shown day's version follows the event at once");
});

test("the footer names a day of another year with its year", () => {
  assert.equal(dayName("2025-12-31", TODAY), "31 December 2025");
  assert.equal(dayName("2026-01-02", TODAY), "2 January");
});

test("the Vim keys preference is read and followed", async () => {
  const { actor, ctx } = await start({}, { vimKeys: true });
  assert.equal(ctx().vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(ctx().vimKeys, false);
});

// Text or a link copied in the reader goes into Vim's register (one per page), so p
// pastes it here, in any state.
test("a copied text or link goes into Vim's register", () => {
  const pushed = [];
  const actor = createActor(machine, {
    input: { ask: () => Promise.resolve({ error: "no-answerer" }), mint: () => "01K7TEST0000000000000V0001", now: () => NOW, pushRegister: (text) => pushed.push(text) },
  }).start();
  actor.send({ type: "text.copied", text: "One.\n\nTwo." });
  actor.send({ type: "link.copied", id: "01K7TEST0000000000000H0001", text: "[q](note:01K7TEST0000000000000H0001)" });
  assert.deepEqual(pushed, ["One.\n\nTwo.", "[q](note:01K7TEST0000000000000H0001)"]);
  actor.stop();
});

test("a save names the rows the user has just left as finished, once each", async () => {
  const { actor, clock, emitted, ctx } = await start({ [TODAY]: [v(1, "Honest", "Say it"), v(2, "Kind")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_edit", id: id(1), field: "name", value: "Honest always" });
  clock.increment(400);
  assert.equal(emitted.at(-1).finished, undefined, "typing saves without finishing the row");
  actor.send({ type: "_blur", id: id(1), to: id(1) });
  assert.equal(emitted.length, 1, "moving to the other box of the same row leaves nothing");
  actor.send({ type: "_blur", id: id(1), to: id(2) });
  assert.deepEqual(emitted.at(-1).finished, [id(1)], "moving on to the next row finishes the row, even after the throttle saved it");
  actor.send({ type: "_blur", id: id(2), to: null });
  assert.equal(emitted.length, 2, "a row not typed in is not finished");
  actor.send({ type: "_blur", id: id(1), to: null });
  assert.equal(emitted.length, 2, "a row already finished is not finished again");

  actor.send({ type: "_edit", id: id(2), field: "meaning", value: "Hold the door" });
  actor.send({ type: "_done" });
  assert.deepEqual(emitted.at(-1).finished, [id(2)], "Done finishes every row typed in");
  assert.equal(ctx().edited.length, 0);
});

// --- Jev's marks ----------------------------------------------------------------------

const EV = "01K6TEST0000000000000EVAL1";
const EX = "01K6TEST0000000000000EVAL2";
const Q = "01K6TEST0000000000000QUES1";
const QX = "01K6TEST0000000000000QUES2";
const GOAL = "01K6TEST0000000000000OPTG1";
const ACT = "01K6TEST0000000000000OPTA1";
const EVALUATORS = [
  {
    id: EV,
    name: "Is it a value?",
    questions: [
      {
        id: Q,
        kind: "pick",
        text: "What is it?",
        expect: ACT,
        options: [
          { id: ACT, name: "A way of acting", icon: "compass" },
          { id: GOAL, name: "A goal" },
        ],
      },
    ],
  },
  { id: EX, name: "Does the example fit?", questions: [{ id: QX, kind: "yes-no", text: "Does it fit?" }] },
];
const line = (kind, text, answers, status = "done") => ({ line: kind, text, status, answers, unexpected: [] });
const answer = (question, option, name, p = 0.95) => ({ question, option, name, p });

test("marks show for the line as written, green or red by the expected answer, plain when none is expected", async () => {
  const checks = {
    keySet: true,
    settings: { values: EV, examples: EX },
    values: [
      { id: id(1), lines: [line("value", "Honest", [answer(Q, ACT, "A way of acting")]), line("example", "Say it", [answer(QX, "yes", "Yes", 0.6)])] },
      { id: id(2), lines: [line("value", "Get rich", [answer(Q, GOAL, "A goal")])] },
    ],
  };
  const { actor, ctx, asked } = await start({ [TODAY]: [v(1, "Honest", "Say it"), v(2, "Get rich")] }, { checks, evaluators: EVALUATORS });
  assert.deepEqual(
    asked.filter((a) => a.target !== "values" && a.target !== "settings").map((a) => [a.target, a.name, a.payload]),
    [["value-checks", "read", { day: TODAY }], ["evaluators", "list", { day: TODAY }], ["generators", "results", { generator: "value-suggestion" }]],
  );
  assert.deepEqual(marksFor(ctx(), v(1, "Honest"), "name"), [
    { question: Q, name: "A way of acting", tone: "right", icon: "compass", expected: "A way of acting", sure: 1 },
  ]);
  assert.deepEqual(marksFor(ctx(), v(1, "Honest", "Say it"), "meaning"), [
    { question: QX, name: "Yes", tone: "plain", icon: "check", expected: null, sure: sureOf(0.6) },
  ]);
  const red = marksFor(ctx(), v(2, "Get rich"), "name");
  assert.equal(red[0].tone, "wrong");
  assert.equal(red[0].icon, "warning", "an option without an icon gets a warning when red");
  assert.equal(red[0].expected, "A way of acting");
  assert.equal(marksFor(ctx(), v(2, "Get richer"), "name").length, 0, "a line edited since it was checked has no mark");
  assert.equal(warned(ctx(), v(2, "Get rich")), true);
  assert.equal(warned(ctx(), v(1, "Honest", "Say it")), false);

  actor.send({ type: "_open" });
  assert.equal(statusOf(ctx()), "");
  actor.send({ type: "_point", source: "cursor", id: id(2), field: "name", text: "Get rich" });
  assert.equal(statusOf(ctx()), "A goal · you expect A way of acting");
  actor.send({ type: "_point", source: "hover", id: id(1), field: "meaning", text: "Say it" });
  assert.equal(statusOf(ctx()), "Yes", "the pointer comes before the cursor");
  actor.send({ type: "_point", source: "hover", field: null });
  assert.equal(statusOf(ctx()), "A goal · you expect A way of acting");

  // Settings no longer naming the examples' evaluator takes those marks away.
  actor.send({ type: "value-checks.changed", settings: { values: EV, examples: null } });
  assert.deepEqual(boxMarks(ctx(), id(1), "meaning"), []);
});

test("a pending line shows a dot, a failure says why, and another day's checks are ignored", async () => {
  const checks = { keySet: true, settings: { values: EV, examples: null }, values: [] };
  const { actor, ctx } = await start({ [TODAY]: [v(1, "Honest")] }, { checks, evaluators: EVALUATORS });
  actor.send({ type: "values.checked", day: TODAY, values: [{ id: id(1), lines: [line("value", "Honest", [], "pending")] }] });
  assert.deepEqual(marksFor(ctx(), v(1, "Honest"), "name"), [{ pending: true }]);
  actor.send({ type: "values.checked", day: TODAY, values: [{ id: id(1), lines: [line("value", "Honest", [], "failed")] }], error: "rate-limited" });
  assert.deepEqual(marksFor(ctx(), v(1, "Honest"), "name"), []);
  actor.send({ type: "_open" });
  assert.match(statusOf(ctx()), /too many requests/);
  actor.send({ type: "values.checked", day: YESTERDAY, values: [{ id: id(1), lines: [line("value", "Honest", [answer(Q, GOAL, "A goal")])] }] });
  assert.deepEqual(marksFor(ctx(), v(1, "Honest"), "name"), []);
});

test("without value-checks on the page no line has a mark", async () => {
  const { ctx } = await start({ [TODAY]: [v(1, "Honest")] });
  assert.deepEqual(boxMarks(ctx(), id(1), "name"), []);
  assert.equal(statusOf(ctx()), "");
});

// --- Reordering -----------------------------------------------------------------------

const order = (ctx) => ctx().drafts.map((d) => d.name);

test("a row moved up or down is saved in its new order without finishing any row", async () => {
  const { actor, emitted, ctx } = await start({ [TODAY]: [v(1, "A"), v(2, "B"), v(3, "C")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_move", id: id(3), to: 1 });
  assert.deepEqual(order(ctx), ["A", "C", "B"]);
  assert.deepEqual(emitted.at(-1), { type: "values.saved", day: TODAY, values: [v(1, "A"), v(3, "C"), v(2, "B")] });
  actor.send({ type: "_move", id: id(3), to: 2 });
  assert.deepEqual(order(ctx), ["A", "B", "C"], "the opposite move undoes it");
  actor.send({ type: "_move", id: id(1), to: 0 });
  assert.equal(emitted.length, 2, "a move to where it is saves nothing");

  actor.send({ type: "_edit", id: id(2), field: "name", value: "Bee" });
  actor.send({ type: "_move", id: id(2), to: 0 });
  assert.equal(emitted.at(-1).finished, undefined, "a move finishes no row, even one typed in");
  assert.deepEqual(emitted.at(-1).values.map((x) => x.name), ["Bee", "A", "C"]);
  actor.send({ type: "_blur", id: id(2), to: null });
  assert.deepEqual(emitted.at(-1).finished, [id(2)], "leaving it afterwards still finishes it");
});

test("dd cuts a row, p or P places it, u puts the cut back or takes a paste back", async () => {
  const { actor, emitted, ctx } = await start({ [TODAY]: [v(1, "A"), v(2, "B"), v(3, "C")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_cut", id: id(1) });
  assert.equal(ctx().cut, id(1));
  assert.equal(emitted.length, 0, "cutting moves nothing yet");
  actor.send({ type: "_uncut" });
  assert.equal(ctx().cut, null);
  assert.deepEqual(order(ctx), ["A", "B", "C"]);

  actor.send({ type: "_cut", id: id(1) });
  actor.send({ type: "_paste", at: id(3), below: true });
  assert.deepEqual(order(ctx), ["B", "C", "A"]);
  assert.deepEqual(emitted.at(-1).values.map((x) => x.name), ["B", "C", "A"]);
  actor.send({ type: "_unpaste" });
  assert.deepEqual(order(ctx), ["A", "B", "C"], "u takes the paste back");
  assert.deepEqual(emitted.at(-1).values.map((x) => x.name), ["A", "B", "C"]);

  actor.send({ type: "_cut", id: id(3) });
  actor.send({ type: "_paste", at: id(1), below: false });
  assert.deepEqual(order(ctx), ["C", "A", "B"], "P places it above");
  const saves = emitted.length;
  actor.send({ type: "_cut", id: id(2) });
  actor.send({ type: "_paste", at: id(2), below: true });
  assert.equal(emitted.length, saves, "pasting a row onto itself leaves it where it was");
  assert.equal(ctx().cut, null);
});

test("Escape while a row is cut removes it with its undo window", async () => {
  const { actor, clock, emitted, ctx } = await start({ [TODAY]: [v(1, "A"), v(2, "B")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_cut", id: id(1) });
  actor.send({ type: "_remove", id: id(1) });
  assert.equal(ctx().cut, null);
  assert.deepEqual(ctx().removing, [id(1)]);
  actor.send({ type: "_cut", id: id(1) });
  assert.equal(ctx().cut, null, "a row waiting to be removed cannot be cut");
  clock.increment(3000);
  assert.deepEqual(emitted.at(-1).values, [v(2, "B")]);
});

test("an earlier day's rows do not move", async () => {
  const { actor, emitted, ctx } = await start({ [EARLIER]: [v(1, "A"), v(2, "B")] });
  actor.send({ type: "day.shown", day: YESTERDAY, writable: true });
  await flush();
  actor.send({ type: "_open" });
  actor.send({ type: "_move", id: id(2), to: 0 });
  actor.send({ type: "_cut", id: id(2) });
  assert.deepEqual(order(ctx), ["A", "B"]);
  assert.equal(ctx().cut, null);
  assert.equal(emitted.length, 0);
});

test("a row's keys with Vim keys on", () => {
  const k = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...mods });
  assert.equal(rowKey(k("j")), "down");
  assert.equal(rowKey(k("ArrowUp")), "up");
  assert.equal(rowKey(k("g")), "g");
  assert.equal(rowKey(k("g"), { afterG: true }), "first");
  assert.equal(rowKey(k("G")), "last");
  assert.equal(rowKey(k("d")), "d");
  assert.equal(rowKey(k("d"), { afterD: true }), "cut");
  assert.equal(rowKey(k("p")), "below");
  assert.equal(rowKey(k("P")), "above");
  assert.equal(rowKey(k("u")), "undo");
  assert.equal(rowKey(k("o")), "add-below");
  assert.equal(rowKey(k("O")), "add-above");
  assert.equal(rowKey(k("i")), "edit");
  assert.equal(rowKey(k("Enter")), "edit");
  assert.equal(rowKey(k("Escape")), "escape");
  assert.equal(rowKey(k("j", { ctrlKey: true })), null);
});

test("o and O add a value below or above a row", async () => {
  const { actor, ctx } = await start({ [TODAY]: [v(1, "A"), v(2, "B")] });
  actor.send({ type: "_open" });
  actor.send({ type: "_add", at: 1 });
  actor.send({ type: "_add", at: 0 });
  assert.deepEqual(order(ctx), ["", "A", "", "B"]);
  actor.send({ type: "_add" });
  assert.equal(ctx().drafts.length, 5);
  assert.equal(ctx().drafts.at(-1).name, "");
});

// --- Could be -------------------------------------------------------------------------

// Web Crypto answers a hash a few turns later.
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await flush();
};
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const red = (text, unexpected = ["A goal"]) => ({ line: "value", text, status: "done", answers: [answer(Q, GOAL, "A goal")], unexpected });
const suggestion = (n, text, source, version = 1) => ({ id: `value-suggestion:${id(n)}`, generator: "value-suggestion", item: id(n), text, source, version });
const SOURCE = sha(JSON.stringify({ value: "Get rich", example: "Buy a house", reads: "A goal" }));
const redChecks = { keySet: true, settings: { values: EV, examples: null }, values: [{ id: id(1), lines: [red("Get rich")] }] };

test("Could be shows only a suggestion made from the value line as it is now, while it is red", async () => {
  const { actor, ctx } = await start({ [TODAY]: [v(1, "Get rich", "Buy a house"), v(2, "Honest")] }, {
    checks: redChecks,
    evaluators: EVALUATORS,
    suggestions: [suggestion(1, " Building security. ", SOURCE), suggestion(2, "Truthful", SOURCE)],
  });
  await settle();
  assert.deepEqual(sourceOf(ctx(), v(1, "Get rich", "Buy a house")), { value: "Get rich", example: "Buy a house", reads: "A goal" });
  assert.equal(suggestionFor(ctx(), v(1, "Get rich", "Buy a house")), "Building security", "trimmed, without its full stop");
  assert.equal(suggestionFor(ctx(), v(2, "Honest")), null, "a line not red shows none");
  assert.equal(suggestionFor(ctx(), v(1, "Get rich", "Buy a flat")), null, "made from another example");

  // A newer result is taken; an older one announced later is not.
  actor.send({ type: "generation.changed", result: suggestion(1, "Providing", SOURCE, 3) });
  actor.send({ type: "generation.changed", result: suggestion(1, "Old", SOURCE, 2) });
  assert.equal(suggestionFor(ctx(), v(1, "Get rich", "Buy a house")), "Providing");

  // The line checked green now: nothing is suggested.
  actor.send({ type: "values.checked", day: TODAY, values: [{ id: id(1), lines: [red("Get rich", [])] }] });
  assert.equal(suggestionFor(ctx(), v(1, "Get rich", "Buy a house")), null);
  assert.equal(cleaned("  Contributing.. "), "Contributing");
});

test("Use puts the suggestion in the value line and saves it finished; Undo puts the old one back the same way", async () => {
  const { actor, ctx, emitted, clock } = await start({ [TODAY]: [v(1, "Get rich", "Buy a house")] }, {
    checks: redChecks,
    evaluators: EVALUATORS,
    suggestions: [suggestion(1, "Building security.", SOURCE)],
  });
  await settle();
  actor.send({ type: "_open" });
  actor.send({ type: "_use", id: id(1) });
  assert.deepEqual(ctx().drafts, [v(1, "Building security", "Buy a house")], "the example is kept");
  assert.deepEqual(emitted.at(-1), { type: "values.saved", day: TODAY, values: [v(1, "Building security", "Buy a house")], finished: [id(1)] });
  assert.deepEqual(ctx().used, { id: id(1), was: "Get rich", now: "Building security" });
  assert.equal(suggestionFor(ctx(), ctx().drafts[0]), null, "the new line is not red, so no suggestion");

  actor.send({ type: "_unuse" });
  assert.deepEqual(ctx().drafts, [v(1, "Get rich", "Buy a house")]);
  assert.deepEqual(emitted.at(-1), { type: "values.saved", day: TODAY, values: [v(1, "Get rich", "Buy a house")], finished: [id(1)] });
  assert.equal(ctx().used, null);

  // The undo window ends on its own.
  actor.send({ type: "_use", id: id(1) });
  clock.increment(3000);
  assert.equal(ctx().used, null);
  const saves = emitted.length;
  actor.send({ type: "_unuse" });
  assert.equal(emitted.length, saves, "no Undo after the window");
});

test("typing in the line, folding the sheet or another day ends Use's Undo; earlier days take no Use", async () => {
  const { actor, ctx, emitted } = await start({ [TODAY]: [v(1, "Get rich", "Buy a house")] }, {
    checks: redChecks,
    evaluators: EVALUATORS,
    suggestions: [suggestion(1, "Building security", SOURCE)],
  });
  await settle();
  actor.send({ type: "_open" });
  actor.send({ type: "_use", id: id(1) });
  actor.send({ type: "_edit", id: id(1), field: "name", value: "Building safety" });
  assert.equal(ctx().used, null);
  actor.send({ type: "_unuse" });
  assert.equal(ctx().drafts[0].name, "Building safety");

  actor.send({ type: "_edit", id: id(1), field: "name", value: "Get rich" });
  await flush();
  actor.send({ type: "_use", id: id(1) });
  actor.send({ type: "_done" });
  assert.equal(ctx().used, null);

  actor.send({ type: "day.shown", day: YESTERDAY, writable: false });
  await flush();
  actor.send({ type: "_open" });
  const saves = emitted.length;
  actor.send({ type: "_use", id: id(1) });
  assert.equal(emitted.length, saves);
  assert.equal(ctx().used, null);
});
