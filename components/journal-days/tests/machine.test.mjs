import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, kept, shortDate, counts, choiceLabel, KEPT_SIGNED_IN, KEPT_SIGNED_OUT, showing } from "../machine.js";

// The Days list's decisions (3.2): the rows, newest first, with the open day's pill, the
// line saying where the journal is kept, and what a pick emits. Times are built with the
// local Date constructor, so the midnight cases hold in any time zone.

const HERE = dirname(fileURLToPath(import.meta.url));
const SELECTED = JSON.parse(readFileSync(resolve(HERE, "..", "events", "day.selected.json"), "utf8"));

const at = (d, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();
const [SAT, SUN, MON] = ["01K7TEST00000000000000DY01", "01K7TEST00000000000000DY02", "01K7TEST00000000000000DY03"];
const day = (id, date, text, editedAt = at(12, 21)) => ({ id, day: date, text, editedAt, version: 1, waiting: [], unanswered: [] });
const DAYS = [day(SAT, "2026-10-10", "I should call.\nRead two chapters."), day(SUN, "2026-10-11", "\n Long walk. \nNothing to fix."), day(MON, "2026-10-12", "Woke up tired.")];

test("rows are newest first, with the short date, the first line and the paragraph count", () => {
  assert.deepEqual(
    rows(DAYS, null, at(13, 9)).map((r) => [r.date, r.first, r.count, r.pill]),
    [
      ["Tue 13 Oct", "", 0, "today"],
      ["Mon 12 Oct", "Woke up tired.", 1, null],
      ["Sun 11 Oct", "Long walk.", 2, null],
      ["Sat 10 Oct", "I should call.", 2, null],
    ],
    "with no day open, the new page for today comes first",
  );
});

test("the open day shows a pill instead of its count: today, or past midnight when it closes", () => {
  assert.deepEqual(rows(DAYS, MON, at(12, 22))[0], { id: null, day: MON, date: "Mon 12 Oct", first: "Woke up tired.", count: 1, pill: "today", choices: 0 });
  const late = [...DAYS.slice(0, 2), day(MON, "2026-10-12", "Woke up tired.", at(13, 0, 12))];
  assert.equal(rows(late, MON, at(13, 0, 25))[0].pill, "open till 01:12");
  assert.equal(rows(DAYS, MON, at(12, 22)).length, 3, "no new page while a day is open");
});

test("the line says where the journal is kept", () => {
  assert.equal(kept(false), KEPT_SIGNED_OUT);
  assert.equal(kept(true), KEPT_SIGNED_IN);
  assert.equal(KEPT_SIGNED_OUT, "Kept in this browser. Signing in keeps it on your account.");
  assert.equal(KEPT_SIGNED_IN, "Kept on your account, on every device.");
  assert.equal(shortDate("2026-10-06"), "Tue 6 Oct");
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function start({ userId = null } = {}) {
  const picture = { days: DAYS, projects: [], detectors: [], answers: [], open: MON, reason: null };
  const actor = createActor(machine, {
    input: { ask: (target) => Promise.resolve(target === "journal" ? picture : { userId, registrationOpen: true }) },
  });
  const emitted = [];
  actor.on("day.selected", (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted };
}

test("a pick emits day.selected, the open day as null, and is marked", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_pick", id: SUN });
  actor.send({ type: "_pick", id: null });
  actor.send({ type: "_pick", id: "01K7TEST00000000000000NONE" });
  assert.deepEqual(emitted, [{ type: "day.selected", id: SUN }, { type: "day.selected", id: null }]);
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SELECTED, "2020-12").validate(rest).valid, type);
  assert.equal(actor.getSnapshot().context.current, null);
});

test("signing in or out changes where the journal is kept", async () => {
  const { actor } = await start({ userId: "u1" });
  assert.equal(actor.getSnapshot().context.signedIn, true);
  actor.send({ type: "session.changed", userId: null });
  assert.equal(actor.getSnapshot().context.signedIn, false);
});

test("a picked day that is gone falls back to the open day", async () => {
  const { actor } = await start();
  actor.send({ type: "_pick", id: SAT });
  actor.send({ type: "journal.changed", days: DAYS.slice(1), projects: [], detectors: [], answers: [], open: MON, reason: null });
  assert.equal(actor.getSnapshot().context.current, null);
});

// --- Choice points: how many a day has ----------------------------------------------

const CP1 = "01K7TEST0000000000000CP001";
const CP2 = "01K7TEST0000000000000CP002";
const CP3 = "01K7TEST0000000000000CP003";
const cp = (id, date, version = 1, removing = false) => ({
  id,
  day: date,
  situation: "",
  thoughts: "",
  away: "",
  towards: "",
  createdAt: "2026-10-12T08:00:00.000Z",
  version,
  pending: false,
  removing,
});

async function withChoices(reply) {
  const picture = { days: DAYS, projects: [], detectors: [], answers: [], open: MON, reason: null };
  const answers = { journal: picture, session: { userId: null, registrationOpen: true }, "choice-points": reply };
  const actor = createActor(machine, { input: { ask: (target) => Promise.resolve(answers[target]) } });
  actor.start();
  await flush();
  const perDay = () => Object.fromEntries(rows(actor.getSnapshot().context.days, MON, at(12, 22), counts(actor.getSnapshot().context.choicePoints)).map((r) => [r.date, r.choices]));
  return { actor, perDay };
}

test("the starting list counts each day's choice points, and a day without any shows none", async () => {
  const { perDay } = await withChoices({ choicePoints: [cp(CP1, "2026-10-12"), cp(CP2, "2026-10-12"), cp(CP3, "2026-10-10")] });
  assert.deepEqual(perDay(), { "Mon 12 Oct": 2, "Sun 11 Oct": 0, "Sat 10 Oct": 1 });
  assert.equal(choiceLabel(1), "1 choice point");
  assert.equal(choiceLabel(2), "2 choice points");
});

test("a new choice point counts; one being removed does not, and counts again after an undo", async () => {
  const { actor, perDay } = await withChoices({ choicePoints: [cp(CP1, "2026-10-12")] });
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP2, "2026-10-11") });
  assert.equal(perDay()["Sun 11 Oct"], 1);
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP1, "2026-10-12", 1, true) });
  assert.equal(perDay()["Mon 12 Oct"], 0, "waiting out its undo window");
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP1, "2026-10-12", 1, false) });
  assert.equal(perDay()["Mon 12 Oct"], 1, "undone");
  actor.send({ type: "choice-point.deleted", id: CP1, day: "2026-10-12" });
  assert.equal(perDay()["Mon 12 Oct"], 0, "deleted");
});

test("an older version of a choice point does not overwrite a newer one", async () => {
  const { actor, perDay } = await withChoices({ choicePoints: [cp(CP1, "2026-10-12", 3, true)] });
  actor.send({ type: "choice-point.changed", choicePoint: cp(CP1, "2026-10-12", 2, false) });
  assert.equal(perDay()["Mon 12 Oct"], 0);
});

test("with no choice points to ask, the list still works and shows no counts", async () => {
  const { actor, perDay } = await withChoices({ error: "no-answerer" });
  assert.ok(actor.getSnapshot().matches("ready"));
  assert.deepEqual(Object.values(perDay()), [0, 0, 0]);
});

test("the new page for today counts today's choice points", () => {
  const today = rows(DAYS, null, at(13, 9), { "2026-10-13": 2 })[0];
  assert.deepEqual([today.date, today.choices], ["Tue 13 Oct", 2]);
});

// --- Signed out (14) -------------------------------------------------------------------

const SIGNED_IN = { userId: "u1", registrationOpen: false, guest: false, name: "Ann" };
const SIGNED_OUT = { userId: null, registrationOpen: true, guest: false, name: null };

// The list with days kept in this browser; session as given, or missing.
async function listed(session, tryPage = false) {
  const picture = { days: DAYS, projects: [], detectors: [], answers: [], open: MON, reason: null };
  const actor = createActor(machine, {
    input: {
      ask: (target) => Promise.resolve(target === "journal" ? picture : target === "session" ? (session ?? { error: "no-answerer" }) : { error: "no-answerer" }),
      tryPage,
    },
  });
  actor.start();
  await flush();
  return { actor, ctx: () => actor.getSnapshot().context };
}

test("signed out the days are not shown; signed in, or with no session to ask, they are", async () => {
  assert.equal(showing({ tryPage: false, signedIn: null }), "wait", "nothing until session answers");
  assert.equal(showing((await listed(SIGNED_OUT)).ctx()), "sign-in");
  assert.equal(showing((await listed(SIGNED_IN)).ctx()), "show");
  assert.equal(showing((await listed()).ctx()), "show", "a page without session counts as signed in");
});

test("on a try page a visitor not yet signed in sees the days, kept in this browser", async () => {
  const { ctx } = await listed(SIGNED_OUT, true);
  assert.equal(showing(ctx()), "show");
  assert.equal(kept(ctx().signedIn), KEPT_SIGNED_OUT);
});

test("signing in brings the days back without a reload, and signing out hides them again", async () => {
  const { actor, ctx } = await listed(SIGNED_OUT);
  assert.equal(ctx().days.length, DAYS.length, "still kept while hidden");
  actor.send({ type: "session.changed", ...SIGNED_IN });
  assert.equal(showing(ctx()), "show");
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(ctx()), "sign-in");
});
