import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, lineMarksOf } from "../machine.js";

// The entry's side of the hashtag checks (13, Hashtag check): it asks line-checks for the
// day it shows, earlier days too, says in its saves which lines were finished on today's
// page, and keeps only the report for the day shown.

const at = (d, h = 0) => new Date(2026, 9, d, h).getTime();
const id = (tag, n) => `01K7TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const [TODAY, SUNDAY] = [id("Y", 1), id("Y", 2)];
const TEXT = "Worries #thinking-traps\n- Nobody will talk to me";
const day = (did, date, text) => ({ id: did, day: date, text, editedAt: at(12, 21), version: 1, waiting: [], unanswered: [] });

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function start(p) {
  const clock = new SimulatedClock();
  const reads = [];
  let n = 0;
  const actor = createActor(machine, {
    input: {
      ask: (target, name, payload) => {
        if (target === "journal") return Promise.resolve(p);
        if (target === "line-checks") {
          reads.push(payload);
          return Promise.resolve({ source: { kind: "day", id: payload.id }, tags: [], lines: [{ text: "- Nobody will talk to me", status: "done", marks: [] }] });
        }
        return Promise.resolve({});
      },
      mint: () => id("F", n++),
      now: () => at(12, 21),
      throttleMs: 200,
    },
    clock,
  });
  const saved = [];
  actor.on("day.saved", (e) => saved.push(e));
  actor.start();
  await flush();
  return { actor, clock, reads, saved };
}

const p = { days: [day(SUNDAY, "2026-10-11", TEXT), day(TODAY, "2026-10-12", TEXT)], open: TODAY, today: "2026-10-12" };

test("it asks line-checks for the day shown, and for an earlier day picked", async () => {
  const { actor, reads } = await start(p);
  assert.deepEqual(reads, [{ kind: "day", id: TODAY, text: TEXT }]);
  actor.send({ type: "day.selected", id: SUNDAY });
  await flush();
  assert.deepEqual(reads.at(-1), { kind: "day", id: SUNDAY, text: TEXT });
  assert.equal(actor.getSnapshot().context.checks.source.id, SUNDAY);
});

test("finished lines ride the next save, or go at once when nothing waits; an earlier day sends none", async () => {
  const { actor, clock, saved } = await start(p);
  actor.send({ type: "_finished", lines: ["- Nobody will talk to me"] });
  assert.deepEqual(saved, [{ type: "day.saved", id: TODAY, text: TEXT, finished: ["- Nobody will talk to me"] }]);
  actor.send({ type: "_edit", text: TEXT + "\n- More" });
  actor.send({ type: "_finished", lines: ["- More"] });
  clock.increment(200);
  assert.deepEqual(saved.at(-1), { type: "day.saved", id: TODAY, text: TEXT + "\n- More", finished: ["- More"] });
  actor.send({ type: "day.selected", id: SUNDAY });
  const count = saved.length;
  actor.send({ type: "_finished", lines: ["- Nobody will talk to me"] });
  assert.equal(saved.length, count, "an earlier day takes no typing and checks nothing");
});

test("a mark carries its tone only when it has one", () => {
  const marks = lineMarksOf({
    tags: [],
    lines: [{ text: "Lie", status: "done", marks: [{ evaluator: TODAY, question: SUNDAY, name: "Serves Honesty", icon: "compass", p: 0.9, tone: "right" }, { evaluator: TODAY, question: SUNDAY, name: "Kind", p: 0.8 }] }],
  });
  assert.deepEqual(marks.get("Lie"), [{ name: "Serves Honesty", icon: "compass", tone: "right" }, { name: "Kind", icon: "check" }]);
});

test("a report for another day is not kept", async () => {
  const { actor } = await start(p);
  actor.send({ type: "text.checked", source: { kind: "day", id: SUNDAY }, tags: [], lines: [] });
  assert.equal(actor.getSnapshot().context.checks.source.id, TODAY);
  assert.equal(lineMarksOf(actor.getSnapshot().context.checks).size, 0);
});
