import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, SHEETS, listed, listOpen, cursorOf, writable, listKey, listTarget } from "../machine.js";

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const TODAY = "2026-10-14";
const EARLIER = "2026-10-06";
const W = "01K6TEST000000000000000WH1";
const flush = () => new Promise((r) => setTimeout(r, 0));

async function start({ hidden = [], placed = {}, wheels = [], vimKeys = false, noFlags = false } = {}) {
  const sent = [];
  const asked = [];
  const answers = {
    "settings read": () => ({ vimKeys }),
    "flags read": () => (noFlags ? { error: "no-answerer" } : { off: [], hidden }),
    "wheels list": () => ({ wheels }),
    "values read": (payload) => ({ day: null, values: [], changedSince: false, placed: placed[payload.day] === true }),
  };
  const actor = createActor(machine, {
    input: {
      ask: async (target, name, payload) => {
        asked.push([target, name, payload]);
        return answers[`${target} ${name}`](payload);
      },
      send: (...call) => sent.push(call),
      now: () => NOW,
    },
  });
  actor.start();
  await flush();
  return { actor, sent, asked, ctx: () => actor.getSnapshot().context, ids: () => listed(actor.getSnapshot().context).map((s) => s.id) };
}

test("the fixed list says each sheet's name, category and description", () => {
  assert.deepEqual(SHEETS.map((s) => [s.name, s.category, s.target, s.feature]), [
    ["Your values", "ACT", "values-sheet", "choice-points"],
    ["Choice point", "ACT", "choice-point-cards", "choice-points"],
    ["Wheel of Life", "Coaching", "wheel-sheet", "wheel-of-life"],
  ]);
  assert.ok(SHEETS.every((s) => s.what.endsWith(".")));
});

test("a sheet whose feature is hidden is not listed, and with nothing to list there is no row", async () => {
  const { ctx, ids, actor } = await start({ hidden: ["wheel-of-life"] });
  assert.deepEqual(ids(), ["values", "choice-point"]);
  actor.send({ type: "flags.changed", off: [], hidden: ["choice-points"] });
  assert.deepEqual(ids(), ["wheel"]);
  actor.send({ type: "flags.changed", off: [], hidden: ["choice-points", "wheel-of-life"] });
  assert.deepEqual(ids(), []);
  actor.send({ type: "_toggle" });
  assert.equal(ctx().open, false, "no row to press");
});

test("a page without flags hides nothing, as journal-entry reads it", async () => {
  const { ids } = await start({ noFlags: true });
  assert.deepEqual(ids(), ["values", "choice-point", "wheel"]);
});

test("nothing is listed until flags has said, and a sheet held once only when its fact has said", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const actor = createActor(machine, {
    input: {
      ask: (target, name) => (target === "flags" ? held : new Promise(() => {})),
      send: () => {},
      now: () => NOW,
    },
  });
  actor.start();
  assert.deepEqual(listed(actor.getSnapshot().context), []);
  release({ off: [], hidden: [] });
  await flush();
  assert.deepEqual(listed(actor.getSnapshot().context).map((s) => s.id), ["choice-point"], "Choice point needs no fact to be offered");
});

test("Your values and Wheel of Life leave the list while on the shown day, and Choice point stays", async () => {
  const { actor, ids } = await start();
  assert.deepEqual(ids(), ["values", "choice-point", "wheel"]);
  actor.send({ type: "values.changed", day: TODAY, values: [], placed: true });
  assert.deepEqual(ids(), ["choice-point", "wheel"]);
  actor.send({ type: "wheel.changed", wheel: { id: W, day: TODAY, actual: [], wanted: [], version: 1 } });
  assert.deepEqual(ids(), ["choice-point"]);
  actor.send({ type: "wheel.deleted", id: W, day: TODAY });
  actor.send({ type: "values.changed", day: TODAY, values: [], placed: false });
  assert.deepEqual(ids(), ["values", "choice-point", "wheel"], "taking them off puts them back");
  actor.send({ type: "values.changed", day: EARLIER, values: [], placed: true });
  assert.ok(ids().includes("values"), "another day's placement is not this day's");
});

test("a wheel on another day leaves the Wheel of Life listed; what is on the day comes from the facts' first answers", async () => {
  const other = await start({ wheels: [{ id: W, day: EARLIER }] });
  assert.ok(other.ids().includes("wheel"));
  const same = await start({ wheels: [{ id: W, day: TODAY }], placed: { [TODAY]: true } });
  assert.deepEqual(same.ids(), ["choice-point"]);
});

test("an earlier day has no row, and moving to it asks that day's placement and closes the list", async () => {
  const { actor, ctx, ids, asked } = await start({ wheels: [{ id: W, day: TODAY }], placed: { [EARLIER]: true } });
  actor.send({ type: "_toggle" });
  assert.equal(ctx().open, true);
  actor.send({ type: "day.shown", day: EARLIER, writable: false });
  await flush();
  assert.equal(writable(ctx()), false);
  assert.deepEqual(ids(), []);
  assert.equal(ctx().open, false);
  assert.deepEqual(asked.at(-1), ["values", "read", { day: EARLIER }]);
  assert.equal(ctx().placed, true);
});

test("a day that stops being written loses its row and its open list; the journal's word wins over the calendar", async () => {
  const { actor, ctx, ids } = await start();
  actor.send({ type: "_toggle" });
  actor.send({ type: "day.shown", day: TODAY, writable: false });
  assert.deepEqual(ids(), []);
  assert.equal(listOpen(ctx()), false);
  actor.send({ type: "day.shown", day: TODAY, writable: true });
  assert.equal(ctx().open, false, "it does not reopen by itself");
  actor.send({ type: "day.shown", day: EARLIER, writable: true });
  await flush();
  assert.ok(ids().includes("choice-point"), "yesterday until 2:00");
});

test("a reply for a day left meanwhile is dropped", async () => {
  const replies = {};
  const actor = createActor(machine, {
    input: {
      ask: (target, name, payload) => {
        if (target !== "values") return Promise.resolve(target === "wheels" ? { wheels: [] } : { off: [], hidden: [] });
        return new Promise((r) => (replies[payload.day] = r));
      },
      send: () => {},
      now: () => NOW,
    },
  });
  actor.start();
  await flush();
  actor.send({ type: "day.shown", day: EARLIER, writable: true });
  await flush();
  replies[TODAY]({ values: [], placed: true });
  await flush();
  assert.equal(actor.getSnapshot().context.placed, null);
  replies[EARLIER]({ values: [], placed: false });
  await flush();
  assert.equal(actor.getSnapshot().context.placed, false);
});

test("the row opens and closes the list, and a pick sends add to that sheet and closes it", async () => {
  const { actor, ctx, sent } = await start();
  actor.send({ type: "_toggle" });
  assert.equal(listOpen(ctx()), true);
  actor.send({ type: "_toggle" });
  assert.equal(listOpen(ctx()), false);
  for (const [id, target] of [["values", "values-sheet"], ["choice-point", "choice-point-cards"], ["wheel", "wheel-sheet"]]) {
    actor.send({ type: "_toggle" });
    actor.send({ type: "_pick", id });
    assert.deepEqual(sent.at(-1), [target, "add", {}]);
    assert.equal(ctx().open, false);
  }
});

test("a pick that is no longer listed sends nothing", async () => {
  const { actor, sent } = await start({ placed: { [TODAY]: true } });
  actor.send({ type: "_toggle" });
  actor.send({ type: "_pick", id: "values" });
  assert.deepEqual(sent, []);
});

test("the cursor stays inside a list that got shorter, and a new opening starts at the top", async () => {
  const { actor, ctx } = await start();
  actor.send({ type: "_toggle" });
  actor.send({ type: "_cursor", to: 2 });
  assert.equal(cursorOf(ctx()), 2);
  actor.send({ type: "values.changed", day: TODAY, values: [], placed: true });
  assert.equal(cursorOf(ctx()), 1);
  actor.send({ type: "_close" });
  actor.send({ type: "_toggle" });
  assert.equal(cursorOf(ctx()), 0);
});

test("the focus command counts, so the view gives the row the keyboard once per command", async () => {
  const { actor, ctx } = await start();
  actor.send({ type: "focus" });
  actor.send({ type: "focus" });
  assert.equal(ctx().landing, 2);
});

test("the keys: arrows always; j, k, gg and G only with Vim keys on; never with a modifier", () => {
  const key = (k, extra = {}) => ({ key: k, ...extra });
  assert.deepEqual(listKey(key("ArrowDown"), false), { move: "down" });
  assert.deepEqual(listKey(key("ArrowUp"), false), { move: "up" });
  assert.equal(listKey(key("j"), false), null);
  assert.equal(listKey(key("G"), false), null);
  assert.deepEqual(listKey(key("j"), true), { move: "down" });
  assert.deepEqual(listKey(key("k"), true), { move: "up" });
  assert.deepEqual(listKey(key("G"), true), { move: "last" });
  assert.deepEqual(listKey(key("g"), true), { wait: true });
  assert.deepEqual(listKey(key("g"), true, true), { move: "first" });
  assert.equal(listKey(key("j", { ctrlKey: true }), true), null);
  assert.equal(listKey(key("x"), true), null);
});

test("a move past either end stays in the list", () => {
  assert.equal(listTarget("down", 0, 3), 1);
  assert.equal(listTarget("down", 2, 3), 2);
  assert.equal(listTarget("up", 1, 3), 0);
  assert.equal(listTarget("up", 0, 3), 0);
  assert.equal(listTarget("first", 2, 3), 0);
  assert.equal(listTarget("last", 0, 3), 2);
});
