import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, kept, shortDate, KEPT_SIGNED_IN, KEPT_SIGNED_OUT } from "../machine.js";

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
  assert.deepEqual(rows(DAYS, MON, at(12, 22))[0], { id: null, day: MON, date: "Mon 12 Oct", first: "Woke up tired.", count: 1, pill: "today" });
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
