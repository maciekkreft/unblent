import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, margins, entry, banner, reasonLine, toJudge, canJudge, conflictOn, shown, paragraphs, longDate } from "../machine.js";

// The entry's decisions (3.2): what each paragraph's margin says, when the banner shows,
// which reason line fits, what Judge this day counts, and what is saved when. Times are
// built with the local Date constructor, so the midnight cases hold in any time zone.

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["day.saved", "day.judging.requested"].map((n) => [n, schema(n)]));

const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();

const id = (tag, n) => `01K7TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const [PA, PB] = [id("P", 1), id("P", 2)];
const [DA, DB] = [id("D", 1), id("D", 2)];
const [QP, QY] = [id("Q", 1), id("Q", 2)];
const [GOAL, VALUE] = [id("O", 1), id("O", 2)];
const [TODAY, SUNDAY, FRESH] = [id("Y", 1), id("Y", 2), id("F", 1)];

const project = (pid, name, on = true) => ({ id: pid, name, on, version: 1, removing: false });
const option = (oid, name) => ({ id: oid, name, description: "", removing: false });
const pickQ = (text = "Goal or value?") => ({ id: QP, kind: "pick", text, yes: "", no: "", options: [option(GOAL, "Goal"), option(VALUE, "Value")], removing: false });
const yesQ = (text = "Is it a goal?") => ({ id: QY, kind: "yesno", text, yes: "", no: "", options: [], removing: false });
const detector = (did, pid, name, questions, on = true) => ({ id: did, project: pid, name, on, questions, version: 1, removing: false });
const day = (did, date, text, extra = {}) => ({ id: did, day: date, text, editedAt: at(12, 21), version: 1, waiting: [], unanswered: [], ...extra });
const wording = (q) => ({ text: q.text, yes: q.yes, no: q.no, options: q.kind === "pick" ? q.options.map((o) => ({ id: o.id, name: o.name })) : [] });
const answer = (text, q, ans, earlier = null) => ({
  text,
  wording: earlier ? { ...wording(q), text: earlier } : wording(q),
  answer: { id: q.id, ...ans },
  at: at(12, 21),
  earlier: Boolean(earlier),
});

const one = () => ({ projects: [project(PA, "Goals")], detectors: [detector(DA, PA, "Goal or value", [pickQ()])] });
const two = () => ({
  projects: [project(PA, "Goals"), project(PB, "Checks")],
  detectors: [detector(DA, PA, "Goal or value", [pickQ()]), detector(DB, PB, "Goal yes / no", [yesQ()])],
});
const picture = (over = {}) => ({ days: [], answers: [], open: null, reason: null, ...one(), ...over });

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

// --- The margin ------------------------------------------------------------------------

test("each paragraph has a margin row; the one being written is not finished yet", () => {
  const p = picture({ answers: [answer("I want to run.", pickQ(), { p: 0.82, choice: GOAL })] });
  const d = day(TODAY, "2026-10-12", "I want to run.\nCare for my family.\nStill typ");
  const rows = margins(d.text, true, d, p);
  assert.deepEqual(rows.map((r) => [r.text, r.state]), [
    ["I want to run.", "answered"],
    ["Care for my family.", "answered"],
    ["Still typ", "unfinished"],
  ]);
  assert.deepEqual(rows[0].projects, [{ id: PA, name: null, detectors: [{ id: DA, name: "Goal or value", entries: [
    { id: QP, kind: "pick", pick: "Goal", sure: "sure 82%", earlier: null },
  ] }] }], "one project on: no project name");
  assert.deepEqual(rows[1].projects, [], "not answered yet: an empty margin");
  assert.equal(margins(d.text, false, d, p)[2].state, "answered", "leaving the box finishes the last paragraph");
});

test("a paragraph waiting for Jev says so", () => {
  const d = day(TODAY, "2026-10-12", "One.\nTwo.", { waiting: ["Two."] });
  assert.deepEqual(margins(d.text, false, d, picture()).map((r) => r.state), ["answered", "waiting"]);
});

test("with more than one project on, answers are grouped under each project's name", () => {
  const p = picture({ ...two(), answers: [answer("A.", pickQ(), { p: 0.9, choice: VALUE }), answer("A.", yesQ(), { p: 0.3 })] });
  const [row] = margins("A.", false, day(TODAY, "2026-10-12", "A."), p);
  assert.deepEqual(row.projects.map((g) => [g.name, g.detectors.map((d) => d.name)]), [
    ["Goals", ["Goal or value"]],
    ["Checks", ["Goal yes / no"]],
  ]);
  // Unticking a project leaves one, so the names go.
  const off = { ...p, projects: [project(PA, "Goals"), project(PB, "Checks", false)] };
  assert.deepEqual(margins("A.", false, day(TODAY, "2026-10-12", "A."), off)[0].projects.map((g) => g.name), [null]);
});

test("a pick shows sure n%, or unsure below 40%; a yes / no its chance in Judge's colours", () => {
  assert.equal(entry(pickQ(), answer("A.", pickQ(), { p: 0.4, choice: GOAL })).sure, "sure 40%");
  assert.equal(entry(pickQ(), answer("A.", pickQ(), { p: 0.39, choice: GOAL })).sure, "unsure");
  const tone = (p) => entry(yesQ(), answer("A.", yesQ(), { p })).tone;
  assert.deepEqual([tone(0.6), tone(0.59), tone(0.41), tone(0.4)], ["yes", "", "", "no"]);
  assert.equal(entry(yesQ(), answer("A.", yesQ(), { p: 0.6 })).pct, 60);
});

test("an answer to an earlier wording carries the old wording, and its pick keeps the name it was offered", () => {
  const q = pickQ("Is this a goal or a value?");
  const a = answer("A.", pickQ(), { p: 0.7, choice: GOAL }, "Goal or value?");
  a.wording.options[0].name = "Aim";
  const e = entry(q, a);
  assert.equal(e.earlier, "Asked as: Goal or value?\nOptions: Aim, Value");
  const yn = { ...answer("A.", yesQ(), { p: 0.7 }, "Goal?"), wording: { text: "Goal?", yes: "it can be finished", no: "", options: [] } };
  assert.equal(entry(yesQ(), yn).earlier, "Asked as: Goal?\nYes means: it can be finished");
  assert.equal(e.pick, "Aim");
  assert.equal(entry(q, answer("A.", q, { p: 0.7, choice: id("O", 9) })).pick, "Removed option");
});

test("paragraphs split at line breaks, as the journal splits them, each knowing its line", () => {
  assert.deepEqual(paragraphs(" One \n\nTwo\n", true), [{ text: "One", finished: true, line: 1 }, { text: "Two", finished: true, line: 3 }]);
  assert.deepEqual(paragraphs("One\nTw", true).at(-1), { text: "Tw", finished: false, line: 2 });
  assert.deepEqual(margins("A.\n\nB.", false, day(TODAY, "2026-10-12", "A.\n\nB."), picture()).map((r) => r.line), [1, 3], "a margin row names the line it sits beside");
});

// --- The open day, the banner and Judge this day ---------------------------------------

test("past midnight the open day's banner names an hour after its last edit", () => {
  const d = day(TODAY, "2026-10-12", "Late.", { editedAt: at(13, 0, 12) });
  assert.equal(banner(d, true, at(12, 23, 50)), null, "before midnight there is none");
  assert.equal(banner(d, true, at(13, 0, 25)), "Keep writing. This entry closes at 01:12.");
  assert.equal(banner(d, false, at(13, 0, 25)), null, "a day that is not open has none");
});

test("the entry shows the picked earlier day read only, else the open day, else a new page", () => {
  const today = day(TODAY, "2026-10-12", "Now.");
  const sunday = day(SUNDAY, "2026-10-11", "Then.");
  const p = picture({ days: [sunday, today], open: TODAY });
  assert.deepEqual([shown(p, SUNDAY, FRESH, at(12, 9)).day.id, shown(p, SUNDAY, FRESH, at(12, 9)).editable], [SUNDAY, false]);
  assert.deepEqual([shown(p, TODAY, FRESH, at(12, 9)).day.id, shown(p, null, FRESH, at(12, 9)).editable], [TODAY, true]);
  const blank = shown({ ...p, open: null }, null, FRESH, at(13, 9));
  assert.deepEqual([blank.day.id, blank.day.day, blank.editable], [FRESH, "2026-10-13", true]);
  assert.equal(longDate("2026-10-12"), "Monday 12 October");
});

test("Judge this day counts what an earlier day lacks, and the open day never offers it", () => {
  const sunday = day(SUNDAY, "2026-10-11", "A.\nB.", { unanswered: ["A.", "B."] });
  assert.equal(toJudge(sunday, false), 2);
  assert.equal(toJudge({ ...sunday, unanswered: [] }, false), 0);
  assert.equal(toJudge(sunday, true), 0);
  assert.equal(canJudge(picture({ reason: "rate-limited" })), true, "pressing it tries again after a failure");
  assert.equal(canJudge(picture({ reason: "signed-out" })), false);
});

test("the reason line uses Judge's words", () => {
  const line = (reason, over = {}, usedUp = false) => reasonLine(picture({ reason, ...over }), usedUp);
  assert.equal(line(null), null);
  assert.equal(line("signed-out"), "Sign in to judge.");
  assert.equal(line("no-key"), "Add your Jev key in Settings.");
  assert.equal(line("no-key", {}, true), "The 100 starter requests are used up. Add your Jev key in Settings.");
  assert.equal(line("no-detector", { detectors: [] }), "Make a detector in Detectors to judge.");
  assert.equal(line("no-detector", { detectors: [detector(DA, PA, "Off", [pickQ()], false)] }), "Switch on a detector in Detectors to judge.");
  assert.equal(line("no-detector", { detectors: [detector(DA, PA, "Empty", [])] }), "Add a question to a detector to judge.");
  assert.equal(line("bad-key"), "Jev did not accept the key. Replace it in Settings.");
  assert.equal(line("unavailable"), "Jev is unavailable.");
});

test("a conflict on the shown day can be kept only while the day is open", () => {
  const c = { id: TODAY, mine: { text: "Mine.", baseVersion: 1 }, theirs: { text: "Theirs.", version: 2, editedAt: at(12, 9) } };
  assert.deepEqual(conflictOn(c, day(TODAY, "2026-10-12", "Theirs."), true), { mine: "Mine.", theirs: "Theirs.", keepable: true });
  assert.equal(conflictOn(c, day(TODAY, "2026-10-12", "Theirs."), false).keepable, false);
  assert.equal(conflictOn(c, day(SUNDAY, "2026-10-11", "Other."), false), null);
  assert.equal(conflictOn(null, day(TODAY, "2026-10-12", ""), true), null);
});

// --- The actor -------------------------------------------------------------------------

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function start(p, { now = at(12, 21), llm = { signedIn: true, jev: { keySet: true } } } = {}) {
  const clock = new SimulatedClock();
  let n = 0;
  const actor = createActor(machine, {
    input: {
      ask: (target) => Promise.resolve(target === "journal" ? p : llm),
      mint: () => (n++ === 0 ? FRESH : id("F", n)),
      now: () => now,
      throttleMs: 200,
    },
    clock,
  });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted, clock };
}

const changed = (p) => ({ type: "journal.changed", ...p });

test("typing is saved at the throttle, and leaving the box saves once more, saying so", async () => {
  const today = day(TODAY, "2026-10-12", "First.");
  const { actor, emitted, clock } = await start(picture({ days: [today], open: TODAY }));
  actor.send({ type: "_edit", text: "First.\nSec" });
  actor.send({ type: "_edit", text: "First.\nSecond" });
  assert.equal(emitted.length, 0);
  clock.increment(200);
  assert.deepEqual(emitted, [{ type: "day.saved", id: TODAY, text: "First.\nSecond" }]);
  // The journal's echo keeps what is on screen while it matches the draft.
  actor.send(changed(picture({ days: [{ ...today, text: "First.\nSecond" }], open: TODAY })));
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted[1], { type: "day.saved", id: TODAY, text: "First.\nSecond", left: true });
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 2, "a second blur with nothing typed saves nothing");
  valid(emitted);
});

test("a new page is saved under a fresh id, and the next new page gets another", async () => {
  const { actor, emitted, clock } = await start(picture());
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 0, "an untouched new page saves nothing");
  actor.send({ type: "_edit", text: "Hello" });
  clock.increment(200);
  assert.deepEqual(emitted, [{ type: "day.saved", id: FRESH, text: "Hello" }]);
  const made = day(FRESH, "2026-10-12", "Hello");
  actor.send(changed(picture({ days: [made], open: FRESH })));
  assert.equal(actor.getSnapshot().context.draft.id, FRESH);
  // The day closes: the new page is a new day.
  actor.send(changed(picture({ days: [made], open: null })));
  assert.notEqual(actor.getSnapshot().context.fresh, FRESH);
  assert.equal(actor.getSnapshot().context.draft.id, actor.getSnapshot().context.fresh);
});

test("an earlier day is read only, and Judge this day asks for it", async () => {
  const sunday = day(SUNDAY, "2026-10-11", "A.", { unanswered: ["A."] });
  const today = day(TODAY, "2026-10-12", "Now.");
  const { actor, emitted, clock } = await start(picture({ days: [sunday, today], open: TODAY }));
  actor.send({ type: "day.selected", id: SUNDAY });
  assert.equal(actor.getSnapshot().context.draft, null);
  actor.send({ type: "_edit", text: "Rewritten." });
  clock.increment(200);
  assert.equal(emitted.length, 0, "nothing on an earlier day is saved");
  actor.send({ type: "_judge" });
  assert.deepEqual(emitted, [{ type: "day.judging.requested", id: SUNDAY }]);
  actor.send({ type: "day.selected", id: null });
  actor.send({ type: "_judge" });
  assert.equal(emitted.length, 1, "the open day has no Judge this day");
  valid(emitted);
});

test("picking another day while typing saves the typing first", async () => {
  const sunday = day(SUNDAY, "2026-10-11", "A.");
  const today = day(TODAY, "2026-10-12", "Now.");
  const { actor, emitted } = await start(picture({ days: [sunday, today], open: TODAY }));
  actor.send({ type: "_edit", text: "Now and then." });
  actor.send({ type: "day.selected", id: SUNDAY });
  assert.deepEqual(emitted, [{ type: "day.saved", id: TODAY, text: "Now and then." }]);
});

test("a conflict shows both copies, and Keep yours saves the user's copy in one step", async () => {
  const today = day(TODAY, "2026-10-12", "Theirs.", { version: 3 });
  const { actor, emitted } = await start(picture({ days: [today], open: TODAY }));
  actor.send({ type: "journal.conflicted", id: TODAY, mine: { text: "Mine.", baseVersion: 2 }, theirs: { text: "Theirs.", version: 3, editedAt: at(12, 20) } });
  assert.equal(actor.getSnapshot().context.conflict.mine.text, "Mine.");
  actor.send({ type: "_keepMine" });
  assert.deepEqual(emitted, [{ type: "day.saved", id: TODAY, text: "Mine." }]);
  assert.equal(actor.getSnapshot().context.conflict, null);
  assert.equal(actor.getSnapshot().context.draft.text, "Mine.");
});

test("on a closed day the other copy stays: Keep yours does nothing, Done clears it", async () => {
  const sunday = day(SUNDAY, "2026-10-11", "Theirs.");
  const { actor, emitted } = await start(picture({ days: [sunday], open: null }));
  actor.send({ type: "journal.conflicted", id: SUNDAY, mine: { text: "Mine.", baseVersion: 1 }, theirs: { text: "Theirs.", version: 2, editedAt: at(11, 20) } });
  actor.send({ type: "_keepMine" });
  assert.equal(emitted.length, 0);
  actor.send({ type: "_keepTheirs" });
  assert.equal(actor.getSnapshot().context.conflict, null);
});

test("Vim keys start from settings: read and follow settings.changed", async () => {
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    input: {
      ask: (target) => Promise.resolve(target === "settings" ? { vimKeys: true } : target === "journal" ? picture() : {}),
      mint: () => FRESH,
      now: () => at(12, 9),
    },
    clock,
  });
  actor.start();
  assert.equal(actor.getSnapshot().context.vimKeys, false, "off before the reply");
  await flush();
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
});

test("the starter requests used up are read from llm", async () => {
  const { actor } = await start(picture({ reason: "no-key" }), { llm: { signedIn: true, jev: { keySet: false, starterLeft: 0 } } });
  assert.equal(actor.getSnapshot().context.usedUp, true);
  actor.send({ type: "llm.changed", signedIn: true, jev: { keySet: true } });
  assert.equal(actor.getSnapshot().context.usedUp, false);
});

test("a journal that cannot answer is an honest failure", async () => {
  const { actor } = await start({ error: "no-answerer" });
  assert.ok(actor.getSnapshot().matches("failed"));
});
