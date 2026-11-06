import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, knownTags, lineMarksOf, CHECK_ERRORS } from "../machine.js";

// The editor's side of the hashtag checks (13, Hashtag check): when it asks line-checks,
// which lines its saves say were finished, which reports it keeps, and what the view
// draws from them.

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const Q = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const TEXT = "Tonight #in-my-control #nope\n- The job\n- Calling her";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

function editor(notes) {
  const clock = new SimulatedClock();
  const reads = [];
  const saved = [];
  const ask = (target, name, payload) => {
    if (target === "line-checks") {
      reads.push(payload);
      return Promise.resolve({ source: { kind: "note", id: payload.id }, tags: [{ tag: "in-my-control", evaluator: EV }], lines: [] });
    }
    if (name === "list") return Promise.resolve({ notes: Object.values(notes) });
    if (name === "read") return Promise.resolve(notes[payload.id] ? { note: notes[payload.id] } : { error: "not-found" });
    return Promise.resolve({ error: "no-answerer" });
  };
  const actor = createActor(machine, { input: { ask, mint: () => ID2, focus: () => {} }, clock });
  actor.on("note.saved", (e) => saved.push(e));
  actor.start();
  return { actor, clock, reads, saved };
}

const note = (id, body) => ({ id, title: "T", body, version: 3, pending: false, updatedAt: 1 });

test("it asks line-checks for the note it opens, again for a change from elsewhere, and never for its own typing", async () => {
  const { actor, clock, reads } = editor({ [ID]: note(ID, TEXT) });
  await settle();
  assert.deepEqual(reads, [{ kind: "note", id: ID, text: TEXT }]);
  assert.deepEqual([...knownTags(actor.getSnapshot().context.checks)], ["in-my-control"]);
  actor.send({ type: "_typed", body: TEXT + "\n- More" });
  clock.increment(200);
  actor.send({ type: "note.changed", id: ID, title: "T", body: TEXT + "\n- More", version: 4, pending: false });
  await settle();
  assert.equal(reads.length, 1, "the save told line-checks; typing asks nothing");
  actor.send({ type: "note.changed", id: ID, title: "T", body: "Other #in-my-control\n- x", version: 5, pending: false });
  await settle();
  assert.equal(reads.length, 2, "a change from elsewhere is asked about");
});

test("a note without a # is not asked about", async () => {
  const { reads } = editor({ [ID]: note(ID, "Plain\nwords") });
  await settle();
  assert.deepEqual(reads, []);
});

test("finished lines ride the next save, or go at once in a save of the same text when nothing waits", async () => {
  const { actor, clock, saved } = editor({ [ID]: note(ID, TEXT) });
  await settle();
  actor.send({ type: "_typed", body: TEXT + "\n- More" });
  actor.send({ type: "_finished", lines: ["- Calling her"] });
  assert.equal(saved.length, 0, "the throttle carries them");
  clock.increment(200);
  assert.deepEqual(saved.at(-1).finished, ["- Calling her"]);
  actor.send({ type: "note.changed", id: ID, title: "T", body: TEXT + "\n- More", version: 4, pending: false });
  actor.send({ type: "_finished", lines: ["- More"] });
  assert.deepEqual(saved.at(-1), { type: "note.saved", id: ID, title: "Tonight #in-my-control #nope", body: TEXT + "\n- More", baseVersion: 4, finished: ["- More"] });
  actor.send({ type: "_typed", body: TEXT + "\n- More!" });
  clock.increment(200);
  assert.equal(saved.at(-1).finished, undefined, "each finished line is sent once");
});

test("only a report for the note shown is kept", async () => {
  const { actor } = editor({ [ID]: note(ID, TEXT) });
  await settle();
  const other = { source: { kind: "note", id: ID2 }, tags: [], lines: [{ text: "- x", status: "pending", marks: [] }] };
  actor.send({ type: "text.checked", ...other });
  assert.equal(actor.getSnapshot().context.checks.source.id, ID);
  actor.send({ type: "text.checked", source: { kind: "day", id: ID }, tags: [], lines: [] });
  assert.equal(actor.getSnapshot().context.checks.source.kind, "note");
});

test("a mark carries its tone only when it has one", () => {
  const marks = lineMarksOf({
    tags: [],
    lines: [{ text: "Lie", status: "done", marks: [{ evaluator: EV, question: Q, name: "Goes against Honesty, Health", icon: "compass", p: 0.9, tone: "wrong" }, { evaluator: EV, question: Q, name: "Kind", p: 0.8 }] }],
  });
  assert.deepEqual(marks.get("Lie"), [{ name: "Goes against Honesty, Health", icon: "compass", tone: "wrong" }, { name: "Kind", icon: "check" }]);
});

test("the marks: icon and name per answer, a check without an icon, a dot while asked, a warning with the reason", () => {
  const marks = lineMarksOf({
    error: "no-key",
    tags: [],
    lines: [
      { text: "- The job", status: "done", marks: [{ evaluator: EV, question: Q, name: "Not in my control", icon: "prohibit", p: 0.9 }, { evaluator: EV, question: Q, name: "Kind", p: 0.8 }] },
      { text: "- Calling her", status: "pending", marks: [] },
      { text: "## Heading", status: "failed", marks: [] },
      { text: "- Said no", status: "done", marks: [] },
    ],
  });
  assert.deepEqual(marks.get("- The job"), [{ name: "Not in my control", icon: "prohibit" }, { name: "Kind", icon: "check" }]);
  assert.deepEqual(marks.get("- Calling her"), [{ pending: true }]);
  assert.deepEqual(marks.get("Heading"), [{ failed: true, error: CHECK_ERRORS["no-key"] }], "keyed by the text the editor shows");
  assert.equal(marks.has("- Said no"), false);
});
