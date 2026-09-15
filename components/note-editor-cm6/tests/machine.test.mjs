import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, titleOf, parseBody, serialize } from "../machine.js";

// The actor is note-editor's, tested there in full; here we test only what cm6 adds:
// the marker-stripping title and the parseBody/serialize transform between the wire
// markdown and the marker-free document (view.js edits the latter).
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const THROTTLE_MS = 200;

const answering = (replies) => (target, name) => Promise.resolve(replies[name] ?? {});

function editor({ ask = answering({ list: { notes: [] } }), mint = () => ID } = {}) {
  const clock = new SimulatedClock();
  const saved = [];
  const actor = createActor(machine, { input: { ask, mint, focus: () => {}, follows: false }, clock });
  actor.on("note.saved", (e) => saved.push(e));
  actor.start();
  return { actor, clock, saved };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("the title is the first line, with its level marker stripped", () => {
  assert.equal(titleOf("# Hello\nworld"), "Hello");
  assert.equal(titleOf("## Section\nbody"), "Section");
  assert.equal(titleOf("### Small\nbody"), "Small");
  assert.equal(titleOf("plain\nworld"), "plain");
  assert.equal(titleOf("\n\n  # Second  \nmore"), "Second");
  assert.equal(titleOf("#no-space stays"), "#no-space stays"); // a hashtag is not a marker
  assert.equal(titleOf(""), "");
});

test("parseBody splits markers into a marker-free doc plus per-line levels", () => {
  assert.deepEqual(parseBody("# T\n## H\nbody\n### S"), {
    doc: "T\nH\nbody\nS",
    levels: ["title", "heading", "body", "subheading"],
  });
  assert.deepEqual(parseBody("just text"), { doc: "just text", levels: ["body"] });
});

test("an empty note seeds a Title first line but serializes back to empty", () => {
  assert.deepEqual(parseBody(""), { doc: "", levels: ["title"] });
  assert.equal(serialize("", ["title"]), ""); // opening a blank note never mints a "# "
});

test("parseBody and serialize round-trip every level", () => {
  for (const md of ["# T\n## H\n### S\nbody", "plain only", "# a\nb\n\n## c", "line\nline2"]) {
    const { doc, levels } = parseBody(md);
    assert.equal(serialize(doc, levels), md, md);
  }
});

test("known edge: a Body line whose text begins with a marker re-parses as a heading", () => {
  // Accepted (Markdown's own ATX ambiguity): serialize keeps it bare, parseBody
  // reads it as a Title on the next load. Documented in machine.js.
  assert.equal(serialize("# typed as body", ["body"]), "# typed as body");
  assert.deepEqual(parseBody("# typed as body"), { doc: "typed as body", levels: ["title"] });
});

test("a save carries the stripped title and the markdown body verbatim", async () => {
  const { actor, clock, saved } = editor();
  await tick();
  actor.send({ type: "_typed", body: "# Kickoff\n## Agenda\nnotes" });
  clock.increment(THROTTLE_MS);
  assert.deepEqual(saved, [
    { type: "note.saved", id: ID, title: "Kickoff", body: "# Kickoff\n## Agenda\nnotes", baseVersion: null },
  ]);
});
