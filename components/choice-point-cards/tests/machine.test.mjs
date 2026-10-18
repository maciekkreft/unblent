import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, dateOf, marksOf, sayMarks, sureOf, statusOf, cardWarnings, writable } from "../machine.js";

const json = (name) => JSON.parse(readFileSync(new URL(`../events/${name}.json`, import.meta.url), "utf8"));
const SCHEMAS = { "choice-point.saved": json("choice-point.saved") };
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
// `checks` is what choice-point-checks answers for a day, and `evaluators` the evaluators
// fact's list; left out, the page holds neither fact.
async function start(days = {}, vimKeys, { checks, evaluators, unfolded } = {}) {
  let n = 0;
  const asked = [];
  const checksAsked = [];
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    clock,
    input: {
      ask: (target, name, payload) => {
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        if (target === "choice-point-checks") {
          checksAsked.push(payload.day);
          return Promise.resolve(checks ? checks(payload.day) : { error: "no-answerer" });
        }
        if (target === "evaluators") return Promise.resolve(evaluators ? { evaluators } : { error: "no-answerer" });
        asked.push({ target, name, payload });
        return Promise.resolve({ choicePoints: days[payload.day] ?? [] });
      },
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      now: () => NOW,
      throttleMs: 400,
      ...(unfolded ? { unfolded } : {}),
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
  return { actor, clock, emitted, asked, checksAsked, ctx: () => actor.getSnapshot().context, state: () => actor.getSnapshot().value };
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

// The one open sheet's id, for the tests that open one.
const only = (ctx) => {
  assert.equal(ctx().drafts.length, 1);
  return ctx().drafts[0].id;
};

test("typing saves at a throttle, and at once on blur", async () => {
  const { actor, clock, emitted, ctx, state } = await start();
  actor.send({ type: "_add" });
  const id = only(ctx);
  assert.deepEqual(state(), { ready: "idle" });
  assert.equal(ctx().drafts[0].day, TODAY);

  actor.send({ type: "_edit", id, field: "situation", value: "D" });
  clock.increment(200);
  actor.send({ type: "_edit", id, field: "situation", value: "Dinner" });
  assert.equal(saves(emitted).length, 0, "nothing per keystroke");
  clock.increment(200);
  assert.deepEqual(saves(emitted), [{ type: "choice-point.saved", id, day: TODAY, situation: "Dinner", thoughts: "", away: "", towards: "" }]);

  actor.send({ type: "_edit", id, field: "away", value: "Checked my phone" });
  actor.send({ type: "_blur", id });
  assert.equal(saves(emitted).length, 2);
  assert.equal(saves(emitted)[1].away, "Checked my phone");
  clock.increment(1000);
  assert.equal(saves(emitted).length, 2, "the blur's save ended the window");
});

test("a line is finished for Jev on Enter or a move to another line, on blur, and on Done", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "_add" });
  const id = only(ctx);
  actor.send({ type: "_edit", id, field: "away", value: "Checked my phone" });
  clock.increment(400);
  assert.equal(saves(emitted).at(-1).finished, undefined, "a save while typing finishes nothing");

  // Enter makes a paragraph (10): the line and a blank one before the new line.
  actor.send({ type: "_edit", id, field: "away", value: "Checked my phone\n\n" });
  actor.send({ type: "_finish", id, field: "away", lines: ["Checked my phone", ""] });
  assert.deepEqual(saves(emitted).at(-1).finished, [{ field: "away", text: "Checked my phone" }]);
  assert.equal(saves(emitted).at(-1).away, "Checked my phone\n\n", "saved at once with the new line");
  const count = saves(emitted).length;
  clock.increment(400);
  assert.equal(saves(emitted).length, count, "the finish's save ended the wait");

  actor.send({ type: "_finish", id, field: "away", lines: ["   "] });
  assert.equal(saves(emitted).length, count, "an empty line finishes nothing");

  actor.send({ type: "_edit", id, field: "away", value: "Checked my phone\n\nSnapped" });
  actor.send({ type: "_edit", id, field: "towards", value: "Breathe" });
  actor.send({ type: "_blur", id, field: "away" });
  assert.deepEqual(saves(emitted).at(-1).finished, [
    { field: "away", text: "Checked my phone" },
    { field: "away", text: "Snapped" },
  ], "a blur finishes every line of its box");

  actor.send({ type: "_done", id });
  assert.deepEqual(saves(emitted).at(-1).finished.map((l) => l.field), ["away", "away", "towards"], "Done finishes the whole sheet");
});

test("Done on a blank new choice point keeps nothing; Done after typing saves at once", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "_add" });
  actor.send({ type: "_done", id: only(ctx) });
  assert.deepEqual(ctx().drafts, []);
  assert.deepEqual(emitted, []);

  actor.send({ type: "_add" });
  const id = only(ctx);
  actor.send({ type: "_edit", id, field: "towards", value: "Listened" });
  actor.send({ type: "_done", id });
  assert.deepEqual(ctx().drafts, []);
  assert.equal(saves(emitted).length, 1);
  assert.equal(saves(emitted)[0].towards, "Listened");
});

test("a kept choice point opens with its texts and follows changes only while nothing waits to save", async () => {
  const { actor, clock, ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" })] });
  actor.send({ type: "_open", id: A });
  assert.equal(ctx().drafts[0].situation, "Dinner");
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "From the phone" }, { version: 2 }) });
  assert.equal(ctx().drafts[0].situation, "From the phone");
  actor.send({ type: "_edit", id: A, field: "situation", value: "Typed here" });
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "Another" }, { version: 3 }) });
  assert.equal(ctx().drafts[0].situation, "Typed here", "what is on screen is not overwritten");
  clock.increment(400);
});

test("folded with every box empty, a kept one is removed by saving it empty; a new one sends nothing", async () => {
  const { actor, clock, emitted, ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" })] });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", id: A, field: "situation", value: "" });
  clock.increment(400);
  actor.send({ type: "_blur", id: A });
  assert.deepEqual(emitted, [], "four empty boxes are not saved while the sheet is open");
  actor.send({ type: "choice-point.changed", choicePoint: cp(A, TODAY, { situation: "Dinner" }, { version: 2 }) });
  assert.equal(ctx().drafts[0].situation, "", "what was cleared is not refilled");
  actor.send({ type: "_done", id: A });
  assert.deepEqual(saves(emitted), [{ type: "choice-point.saved", id: A, day: TODAY, situation: "", thoughts: "", away: "", towards: "" }]);
  assert.deepEqual(ctx().drafts, []);

  actor.send({ type: "_add" });
  actor.send({ type: "_edit", id: only(ctx), field: "away", value: "x" });
  actor.send({ type: "_edit", id: only(ctx), field: "away", value: "" });
  actor.send({ type: "_done", id: only(ctx) });
  assert.equal(saves(emitted).length, 1, "a new one never kept sends nothing");
});

test("an earlier day's choice points open to be read: no new one, no typing, no save on fold", async () => {
  const { actor, emitted, ctx } = await start({ [EARLIER]: [cp(B, EARLIER, { situation: "Old" }), cp(A, EARLIER)] });
  actor.send({ type: "day.shown", day: EARLIER });
  await flush();
  assert.equal(writable(ctx()), false);
  actor.send({ type: "_add" });
  assert.deepEqual(ctx().drafts, [], "no new choice point on an earlier day");
  actor.send({ type: "_open", id: B });
  actor.send({ type: "_edit", id: B, field: "situation", value: "Changed" });
  assert.equal(ctx().drafts[0].situation, "Old");
  actor.send({ type: "_done", id: B });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_done", id: A });
  assert.deepEqual(emitted, [], "an empty one kept from before is not removed from an earlier day");

  actor.send({ type: "day.shown", day: TODAY });
  await flush();
  assert.equal(writable(ctx()), true);
});

test("yesterday is written on while the journal page says it is, and turns read only in place when its hour runs out", async () => {
  const YESTERDAY = "2026-10-13";
  const { actor, clock, emitted, asked, ctx, state } = await start({ [YESTERDAY]: [cp(A, YESTERDAY, { situation: "Late" })] });
  actor.send({ type: "day.shown", day: YESTERDAY, writable: true });
  await flush();
  assert.equal(writable(ctx()), true, "the journal's word wins over the calendar");
  actor.send({ type: "_add" });
  assert.equal(ctx().drafts.length, 1, "the New choice point row works");
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_edit", id: A, field: "thoughts", value: "Tired" });

  const loads = asked.length;
  actor.send({ type: "day.shown", day: YESTERDAY, writable: false });
  assert.deepEqual(saves(emitted).map((e) => [e.id, e.day, e.thoughts]), [[A, YESTERDAY, "Tired"]], "what was typed while open is saved");
  assert.equal(writable(ctx()), false);
  assert.equal(asked.length, loads, "the same day is not asked for again");
  assert.deepEqual(ctx().drafts.map((d) => d.id).at(-1), A, "the open sheet stays, to be read");
  assert.equal(state().ready !== undefined, true);
  actor.send({ type: "_edit", id: A, field: "thoughts", value: "More" });
  actor.send({ type: "_add" });
  clock.increment(400);
  assert.equal(ctx().drafts.find((d) => d.id === A).thoughts, "Tired");
  assert.equal(ctx().drafts.length, 2);
  assert.equal(saves(emitted).length, 1);

  // A sender that does not say falls back to the calendar date.
  actor.send({ type: "day.shown", day: YESTERDAY });
  assert.equal(writable(ctx()), false);
  actor.send({ type: "day.shown", day: TODAY });
  await flush();
  assert.equal(writable(ctx()), true);
});

test("a choice point removed elsewhere while open closes", async () => {
  const { actor, ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" })] });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "choice-point.deleted", id: A, day: TODAY });
  assert.deepEqual(ctx().drafts, []);
});

test("each choice point folds on its own: several stay open, Done folds one, and a new day saves them all", async () => {
  const { actor, clock, emitted, ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "Dinner" }), cp(B, TODAY, { situation: "Work" })] });
  actor.send({ type: "_open", id: A });
  actor.send({ type: "_open", id: B });
  actor.send({ type: "_add" });
  const added = ctx().drafts[2].id;
  assert.deepEqual(ctx().drafts.map((d) => d.id), [A, B, added], "opening one leaves the others open");

  actor.send({ type: "_edit", id: A, field: "thoughts", value: "Tight chest" });
  actor.send({ type: "_edit", id: B, field: "away", value: "Snapped" });
  clock.increment(400);
  assert.deepEqual(saves(emitted).map((e) => e.id), [A, B], "one throttle saves every sheet typed in");

  actor.send({ type: "_done", id: B });
  assert.deepEqual(ctx().drafts.map((d) => d.id), [A, added], "Done folds only its own sheet");

  actor.send({ type: "_edit", id: added, field: "towards", value: "Breathe" });
  actor.send({ type: "day.shown", day: EARLIER });
  assert.equal(saves(emitted).at(-1).towards, "Breathe");
  assert.equal(saves(emitted).at(-1).day, TODAY, "it stays with the day it was added to");
  await flush();
  assert.deepEqual(ctx().drafts, []);
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
  assert.equal(ctx().drafts.length, 1, "the open sheet stays open");
});

// --- Jev's marks -------------------------------------------------------------------------

const EV = "01K6TEST0000000000000000E1";
const Q1 = "01K6TEST0000000000000000Q1";
const Q2 = "01K6TEST0000000000000000Q2";
const Q3 = "01K6TEST0000000000000000Q3";
const BEH = "01K6TEST0000000000000000O1";
const EMO = "01K6TEST0000000000000000O2";
const OVERT = "01K6TEST0000000000000000O3";
const COVERT = "01K6TEST0000000000000000O4";
const EVALUATORS = [
  {
    id: EV,
    questions: [
      { id: Q1, kind: "pick", expect: BEH, options: [{ id: BEH, name: "Behavioral Goal", icon: "person-simple-walk" }, { id: EMO, name: "Emotional Goal" }] },
      { id: Q2, kind: "pick", options: [{ id: OVERT, name: "Overt behavior" }, { id: COVERT, name: "Covert behavior", icon: "brain" }] },
      { id: Q3, kind: "yesno", expect: "yes", options: [] },
    ],
  },
];
// Therapy Goal on Towards: the evaluator expects the goal's kind to be behavioural, its
// option drawn as the walking person; the behaviour's kind shown only for a behavioural
// goal, nothing expected. A box's own `expect` and `icons`, from before the evaluator held
// them, are ignored.
const TOWARDS_BOX = {
  evaluator: EV,
  questions: [
    { id: Q1, show: true, expect: EMO, when: null, icons: { [EMO]: "brain" } },
    { id: Q2, show: true, expect: OVERT, when: { question: Q1, option: BEH }, icons: {} },
  ],
};
const NONE = { evaluator: null, questions: [] };
const SETTINGS = { away: NONE, towards: TOWARDS_BOX, situation: NONE, thoughts: NONE };
const ans = (question, option, name, p) => ({ question, option, name, p });
const done = (text, answers) => ({ field: "towards", text, status: "done", answers });

test("a line's marks follow the box's settings: shown, only when, expected; the glyph is the option's icon", () => {
  assert.deepEqual(marksOf(TOWARDS_BOX, { field: "towards", text: "x", status: "pending", answers: [] }), [{ pending: true }]);
  assert.deepEqual(marksOf(TOWARDS_BOX, { field: "towards", text: "x", status: "failed", answers: [] }), []);
  assert.deepEqual(marksOf(NONE, done("x", [ans(Q1, BEH, "Behavioral Goal", 0.9)])), [], "a box without an evaluator has no marks");

  const call = marksOf(TOWARDS_BOX, done("Call Anna", [ans(Q1, BEH, "Behavioral Goal", 0.96), ans(Q2, OVERT, "Overt behavior", 0.97)]), EVALUATORS);
  assert.deepEqual(
    call.map((m) => [m.icon, m.tone]),
    [["person-simple-walk", "right"], ["check", "plain"]],
    "the option's icon, then an option given none: a check, uncoloured when nothing is expected",
  );
  const notice = marksOf(TOWARDS_BOX, done("Notice", [ans(Q1, BEH, "Behavioral Goal", 0.83), ans(Q2, COVERT, "Covert behavior", 0.88)]), EVALUATORS);
  assert.deepEqual(notice.map((m) => m.icon), ["person-simple-walk", "brain"]);

  const calm = marksOf(TOWARDS_BOX, done("Feel calm", [ans(Q1, EMO, "Emotional Goal", 0.92), ans(Q2, COVERT, "Covert behavior", 0.6)]), EVALUATORS);
  assert.deepEqual(
    calm.map((m) => [m.icon, m.tone, m.expected]),
    [["warning", "wrong", "Behavioral Goal"]],
    "not the expected answer, with no icon of its own: a warning, whatever the box's old icons say; the second question only when the first is behavioural",
  );
  const withIcon = EVALUATORS.map((e) => ({ ...e, questions: e.questions.map((q) => (q.id === Q1 ? { ...q, options: q.options.map((o) => ({ ...o, icon: "heart" })) } : q)) }));
  const wrong = marksOf(TOWARDS_BOX, done("Feel calm", [ans(Q1, EMO, "Emotional Goal", 0.92)]), withIcon);
  assert.deepEqual(wrong.map((m) => [m.icon, m.tone]), [["heart", "wrong"]], "an option's icon stands also when it is not the one expected, still red");
  const feet = EVALUATORS.map((e) => ({ ...e, questions: e.questions.map((q) => (q.id === Q1 ? { ...q, options: q.options.map((o) => ({ ...o, icon: o.id === BEH ? "footprints" : "hand-palm" })) } : q)) }));
  assert.deepEqual(
    [ans(Q1, BEH, "Behavioral Goal", 0.9), ans(Q1, EMO, "Emotional Goal", 0.9)].map((a) => marksOf(TOWARDS_BOX, done("x", [a]), feet)[0].icon),
    ["footprints", "hand-palm"],
  );

  const yesno = { evaluator: EV, questions: [{ id: Q3, show: true, expect: "no", when: null, icons: { yes: "brain", no: "trophy" } }] };
  assert.deepEqual(
    [ans(Q3, "yes", "Yes", 0.9), ans(Q3, "no", "No", 0.9)].map((a) => marksOf(yesno, done("Call", [a]), EVALUATORS).map((m) => [m.icon, m.tone])[0]),
    [["check", "right"], ["warning", "wrong"]],
    "a yes / no answer keeps the check and the warning",
  );

  const unexpected = EVALUATORS.map((e) => ({ ...e, questions: e.questions.map(({ expect, ...q }) => q) }));
  assert.deepEqual(
    marksOf(TOWARDS_BOX, done("Feel calm", [ans(Q1, EMO, "Emotional Goal", 0.9)]), unexpected).map((m) => [m.tone, m.icon, m.expected]),
    [["plain", "check", null]],
    "an evaluator that expects nothing: uncoloured, whatever the box once held",
  );
  const switched = EVALUATORS.map((e) => ({ ...e, questions: e.questions.map((q) => (q.id === Q1 ? { ...q, kind: "yesno" } : q)) }));
  assert.equal(marksOf(TOWARDS_BOX, done("Feel calm", [ans(Q1, "no", "No", 0.9)]), switched)[0].tone, "plain", "an option kept as expected while the question is yes / no expects nothing");
  const pending = EVALUATORS.map((e) => ({ ...e, questions: e.questions.map((q) => (q.id === Q1 ? { ...q, options: q.options.map((o) => (o.id === BEH ? { ...o, removing: true } : o)) } : q)) }));
  assert.equal(marksOf(TOWARDS_BOX, done("Feel calm", [ans(Q1, EMO, "Emotional Goal", 0.9)]), pending)[0].tone, "plain", "an expected option waiting out its removal expects nothing");

  const hidden = { ...TOWARDS_BOX, questions: [{ ...TOWARDS_BOX.questions[0], show: false }, TOWARDS_BOX.questions[1]] };
  assert.deepEqual(marksOf(hidden, done("Call", [ans(Q1, EMO, "Emotional Goal", 0.9), ans(Q2, OVERT, "Overt behavior", 0.9)])), [], "unticked, and only when unmet");
});

test("the status line names a line's answers, and how sure Jev is shows as the mark's opacity", () => {
  const calm = marksOf(TOWARDS_BOX, done("Feel calm when she doesn't answer", [ans(Q1, EMO, "Emotional Goal", 0.92)]), EVALUATORS);
  assert.equal(sayMarks(calm), "Emotional Goal · you expect Behavioral Goal");
  const call = marksOf(TOWARDS_BOX, done("Call Anna", [ans(Q1, BEH, "Behavioral Goal", 0.7), ans(Q2, OVERT, "Overt behavior", 0.97)]), EVALUATORS);
  assert.equal(sayMarks(call), "Behavioral Goal · Overt behavior");
  assert.equal(sayMarks([{ pending: true }]), "Jev is checking…");
  assert.deepEqual(call.map((m) => m.sure), [0.67, 1], "solid when sure, faded when not");
  assert.equal(sureOf(0.5), 0.33);
});

test("the checks are asked by day, followed after, and pointed lines fill the status line", async () => {
  const CALM = "Feel calm when she doesn't answer";
  const record = cp(A, TODAY, { situation: "Sunday", towards: "Call Anna\n" + CALM });
  const report = (day, lines, error) => ({ choicePoint: A, day, lines, ...(error ? { error } : {}) });
  const { actor, ctx, checksAsked } = await start({ [TODAY]: [record] }, undefined, {
    evaluators: EVALUATORS,
    checks: (day) => ({ settings: SETTINGS, choicePoints: day === TODAY ? [report(TODAY, [done("Call Anna", [ans(Q1, BEH, "Behavioral Goal", 0.96)])])] : [] }),
  });
  assert.deepEqual(checksAsked, [TODAY]);
  assert.deepEqual(cardWarnings(ctx(), record), { situation: false, away: false, towards: false });

  actor.send({
    type: "lines.checked",
    ...report(TODAY, [done("Call Anna", [ans(Q1, BEH, "Behavioral Goal", 0.96)]), done(CALM, [ans(Q1, EMO, "Emotional Goal", 0.92)])]),
  });
  actor.send({ type: "lines.checked", ...report(EARLIER, []) });
  assert.deepEqual(cardWarnings(ctx(), record), { situation: false, away: false, towards: true }, "a red warning on the card's towards");

  actor.send({ type: "_open", id: A });
  assert.equal(statusOf(ctx(), A), "", "saving is not reported");
  actor.send({ type: "_point", source: "cursor", id: A, field: "towards", text: CALM });
  assert.equal(statusOf(ctx(), A), "Emotional Goal · you expect Behavioral Goal");
  actor.send({ type: "_point", source: "hover", id: A, field: "towards", text: "Call Anna" });
  assert.equal(statusOf(ctx(), A), "Behavioral Goal", "the pointer wins over the cursor");
  actor.send({ type: "_point", source: "hover", id: A, field: null });
  actor.send({ type: "_point", source: "cursor", id: A, field: null });
  actor.send({ type: "lines.checked", ...report(TODAY, [], "no-key") });
  assert.equal(statusOf(ctx(), A), "Jev could not check: add your Jev key in Settings.");

  actor.send({ type: "_edit", id: A, field: "towards", value: "Call Anna and ask" });
  actor.send({ type: "_point", source: "cursor", id: A, field: "towards", text: "Call Anna and ask" });
  assert.equal(statusOf(ctx(), A), "Jev could not check: add your Jev key in Settings.", "an edited line has no answer to say");

  actor.send({ type: "day.shown", day: EARLIER });
  await flush();
  assert.deepEqual(checksAsked, [TODAY, EARLIER]);
  assert.deepEqual(ctx().checks.reports, {});
  assert.equal(ctx().checks.settings, SETTINGS, "the settings are kept across days");
});

test("the sheets left unfolded open again after a reload; one gone or of another day does not", async () => {
  const unfolded = { read: (day) => (day === TODAY ? [B, "01K6TEST000000000000000GON", A] : []) };
  const { ctx } = await start({ [TODAY]: [cp(A, TODAY, { situation: "One" }), cp(B, TODAY, { situation: "Two" })] }, undefined, { unfolded });
  assert.deepEqual(ctx().drafts.map((d) => d.id), [B, A], "in the order they were opened");
});
