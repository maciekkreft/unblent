import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, pictureOf, lineOf, formatMs, levelOf, windowOf, cellTip, whoOf, mayAllOf, onMacOf } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

// Tuesday 3 November 2026, at noon local time.
const NOW = new Date(2026, 10, 3, 12).getTime();
const MIN = 60000;
const SETTINGS = { nav: [], viewportSwitchHidden: true, layoutSwitchHidden: true, arranging: false, vimKeys: false, keepOpen: false, usageCounting: true, editors: {}, profile: "product" };

test("a duration reads in whole minutes, then hours and minutes", () => {
  assert.equal(formatMs(0), "0 min");
  assert.equal(formatMs(25 * MIN + 20000), "25 min");
  assert.equal(formatMs(80 * MIN), "1 h 20 min");
  assert.equal(formatMs(120 * MIN), "2 h");
});

test("the calendar is the last 182 local days, today last, with five shades", () => {
  const days = windowOf(NOW);
  assert.equal(days.length, 182);
  assert.equal(days.at(-1), "2026-11-03");
  assert.equal(days[0], "2026-05-06");
  assert.deepEqual([0, 1, 24, 25, 50, 99, 100].map((m) => levelOf(m, 100)), [0, 1, 1, 2, 3, 4, 4]);
  assert.equal(levelOf(5, 0), 0);
});

test("a range keeps only its own days; the calendar keeps every day and marks the rest", () => {
  const summary = {
    accounts: 1,
    days: [
      { day: "2026-11-03", feature: "journal", ms: 30 * MIN },
      { day: "2026-10-28", feature: "reading", ms: 20 * MIN },
      { day: "2026-10-27", feature: "reading", ms: 50 * MIN },
      { day: "2026-06-01", feature: "chats", ms: 60 * MIN },
    ],
  };
  const week = pictureOf(summary, "week", NOW);
  assert.equal(week.total, 50 * MIN, "28 October is the seventh day back; 27 October is not in the week");
  assert.deepEqual(week.totals.map((f) => [f.id, f.ms]), [["journal", 30 * MIN], ["reading", 20 * MIN]]);
  assert.equal(week.active, 2);
  assert.equal(week.span, 7);
  assert.equal(week.cells.filter((c) => !c.out).length, 7);
  assert.equal(week.cells.at(-1).today, true);
  assert.equal(week.river.length, 7 * 9, "one point per feature per day");
  assert.deepEqual(week.river.at(-9), ["2026-11-03", 30, "Journal"]);

  const all = pictureOf(summary, "all", NOW);
  assert.equal(all.total, 160 * MIN);
  assert.equal(all.totals[0].id, "reading");
  assert.equal(all.river.length, 26 * 9, "one point per feature per week");
  assert.equal(all.first.long, "May");

  const followed = pictureOf(summary, "all", NOW, "reading");
  const level = (day) => followed.cells.find((c) => c.day === day).level;
  assert.equal(level("2026-10-27"), 4, "the busiest reading day");
  assert.equal(level("2026-11-03"), 0, "a day with no reading is unshaded while reading is followed");
  assert.equal(cellTip(followed.cells.find((c) => c.day === "2026-10-27"), "reading"), "Tue 27 Oct · 50 min in Reading");
  assert.equal(cellTip(followed.cells.find((c) => c.day === "2026-11-02"), null), "Mon 2 Nov · nothing");
});

test("the line names the range, whose time it is and the feature that took most", () => {
  const summary = { accounts: 3, days: [
    { day: "2026-11-02", feature: "journal", ms: 41 * MIN },
    { day: "2026-11-02", feature: "notes", ms: 59 * MIN },
  ] };
  const text = (range, who, accounts) => {
    const l = lineOf(pictureOf(summary, range, NOW), range, who, accounts);
    return l.lead + l.top + l.tail;
  };
  assert.equal(text("week", "you", 1), "This week you spent this long in Unblent, most of it in Notes (59%).");
  assert.equal(text("month", "all", 3), "In the last 30 days all 3 accounts spent this long in Unblent, most of it in Notes (59%).");
  assert.equal(text("all", "all", 1), "Since May 1 account spent this long in Unblent, most of it in Notes (59%).");
  const empty = lineOf(pictureOf({ days: [], accounts: 1 }, "week", NOW), "week", "you", 1);
  assert.equal(empty.lead, "This week nothing was counted.");
});

test("All accounts is the admin's on the website alone, not while viewing as someone", () => {
  assert.equal(mayAllOf({ userId: "a", admin: true }), true);
  assert.equal(mayAllOf({ userId: "a", admin: true, viewingAs: "Guest 2" }), false);
  assert.equal(mayAllOf({ userId: "a", admin: true, connect: "off" }), false);
  assert.equal(mayAllOf({ userId: "g", guest: true }), false);
  assert.equal(whoOf({ who: "all", session: { userId: "g" } }), "you");
  assert.equal(onMacOf({ userId: "a", connect: "off" }), true);
  assert.equal(onMacOf({ userId: "a", connect: "on" }), false);
  assert.equal(onMacOf({ userId: "a" }), false);
});

test("the summary is asked when shown and when You or All accounts changes, the switch is emitted whole", async () => {
  const asked = [];
  const answers = { settings: SETTINGS, session: { userId: "a", admin: true, registrationOpen: false }, usage: { days: [], accounts: 1 } };
  const actor = createActor(machine, { input: { now: () => NOW, ask: async (...a) => (asked.push(a), answers[a[0]]) } });
  const emitted = [];
  actor.on("settings.edited", ({ type, ...rest }) => emitted.push(rest));
  actor.start();
  await flush();
  assert.deepEqual(asked, [["settings", "read", {}], ["session", "read", {}]], "nothing about usage until the tab is shown");
  actor.send({ type: "_show" });
  await flush();
  assert.deepEqual(asked.at(-1), ["usage", "summary", { who: "you" }]);
  actor.send({ type: "_who", who: "all" });
  await flush();
  assert.deepEqual(asked.at(-1), ["usage", "summary", { who: "all" }]);
  actor.send({ type: "_range", range: "month" });
  await flush();
  assert.equal(asked.length, 4, "a range is filtered here, not asked");

  // Viewing as someone takes All accounts away, so the summary is asked for you again.
  actor.send({ type: "session.changed", userId: "a", admin: false, viewingAs: "Guest 2", registrationOpen: false });
  await flush();
  assert.deepEqual(asked.at(-1), ["usage", "summary", { who: "you" }]);

  actor.send({ type: "_toggle" });
  const { profile: _profile, ...fields } = SETTINGS;
  assert.deepEqual(emitted, [{ ...fields, usageCounting: false }], "the whole settings, the switch flipped, no profile");
  assert.equal(actor.getSnapshot().context.settings.usageCounting, true, "nothing changes until settings says so");
  actor.send({ type: "settings.changed", ...SETTINGS, usageCounting: false });
  assert.equal(actor.getSnapshot().context.settings.usageCounting, false);
  actor.stop();
});

test("a feature is followed by a second click or Escape back to all", () => {
  const actor = createActor(machine, { input: { now: () => NOW, ask: async () => null } }).start();
  actor.send({ type: "_focus", feature: "reading" });
  assert.equal(actor.getSnapshot().context.focus, "reading");
  actor.send({ type: "_focus", feature: "journal" });
  assert.equal(actor.getSnapshot().context.focus, "journal");
  actor.send({ type: "_focus", feature: "journal" });
  assert.equal(actor.getSnapshot().context.focus, null);
  actor.send({ type: "_focus", feature: "notes" });
  actor.send({ type: "_clear" });
  assert.equal(actor.getSnapshot().context.focus, null);
  actor.stop();
});
