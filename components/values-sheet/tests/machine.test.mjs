import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, dateOf, dayName, writable, shownValues, earlierDays, changedLine } from "../machine.js";

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
async function start(versions = {}, { vimKeys, undoMs = 3000 } = {}) {
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
