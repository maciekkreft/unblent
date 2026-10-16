import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, enterAt, breakAt, backspaceAt, deleteAt, isGap, pastGap, readout } from "../machine.js";

// The editing rule (machine.js): paragraphs apart by one blank line, a line break a
// single "\n". Each function returns the change, applied here as the editor would.

const run = (text, edit) => (edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : text);

test("Enter starts a paragraph with one blank line; Shift+Enter breaks the line", () => {
  assert.equal(run("OneTwo", enterAt("OneTwo", 3)), "One\n\nTwo");
  assert.equal(enterAt("OneTwo", 3).cursor, 5);
  assert.equal(run("OneTwo", breakAt("OneTwo", 3)), "One\nTwo");
  assert.equal(breakAt("OneTwo", 3).cursor, 4);
  // A selection is replaced.
  assert.equal(run("One xx Two", enterAt("One xx Two", 3, 7)), "One\n\nTwo");
});

test("Backspace at a paragraph's start removes the whole gap and joins", () => {
  assert.equal(run("One\n\nTwo", backspaceAt("One\n\nTwo", 5)), "OneTwo");
  assert.equal(backspaceAt("One\n\nTwo", 5).cursor, 3);
  // A run of blank lines goes at once.
  assert.equal(run("One\n\n\n\nTwo", backspaceAt("One\n\n\n\nTwo", 7)), "OneTwo");
  // An empty paragraph being started joins back.
  assert.equal(run("One\n\n", backspaceAt("One\n\n", 5)), "One");
  // After a line break, or mid-line, it is an ordinary Backspace.
  assert.equal(backspaceAt("One\nTwo", 4), null);
  assert.equal(backspaceAt("One\n\nTwo", 6), null);
  assert.equal(backspaceAt("One", 0), null);
});

test("Delete at a paragraph's end removes the gap forwards", () => {
  assert.equal(run("One\n\nTwo", deleteAt("One\n\nTwo", 3)), "OneTwo");
  assert.equal(run("One\n\n\n\nTwo", deleteAt("One\n\n\n\nTwo", 3)), "OneTwo");
  assert.equal(deleteAt("One\nTwo", 3), null);
  assert.equal(deleteAt("One", 3), null);
});

test("a blank line is a gap unless the cursor is on it", () => {
  assert.equal(isGap({ text: "", number: 2 }, 3), true);
  assert.equal(isGap({ text: "", number: 2 }, 2), false);
  assert.equal(isGap({ text: "One", number: 1 }, 3), false);
});

test("a move landing on a gap carries on to text, or stops at the first or last line", () => {
  const lines = ["One", "", "", "Two", ""];
  const blank = (n) => lines[n] === "";
  assert.equal(pastGap(blank, lines.length, 1, 1), 3);
  assert.equal(pastGap(blank, lines.length, 2, -1), 0);
  assert.equal(pastGap(blank, lines.length, 4, 1), 4);
  assert.equal(pastGap(blank, lines.length, 3, 1), null);
  const top = ["", "", "One"];
  assert.equal(pastGap((n) => top[n] === "", top.length, 1, -1), 0);
});

test("the readout marks each line break and each blank line", () => {
  assert.deepEqual(readout("One\n\nTwo\nthree"), [
    { text: "One", blank: false, broken: true },
    { text: "", blank: true, broken: true },
    { text: "Two", blank: false, broken: true },
    { text: "three", blank: false, broken: false },
  ]);
  // The last line is where typing goes, never a blank line.
  assert.deepEqual(readout("One\n\n").at(-1), { text: "", blank: false, broken: false });
});

test("the machine keeps the draft, saves each edit and follows Vim keys", async () => {
  const saved = [];
  const actor = createActor(machine, {
    input: { ask: async () => ({ vimKeys: true }), draft: "Hello", save: (t) => saved.push(t) },
  }).start();
  assert.equal(actor.getSnapshot().context.text, "Hello");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "_edit", text: "Hello\n\nWorld" });
  assert.equal(actor.getSnapshot().context.text, "Hello\n\nWorld");
  assert.deepEqual(saved, ["Hello\n\nWorld"]);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
  // A page without settings leaves Vim off.
  const bare = createActor(machine, { input: { ask: async () => ({ error: "no-answerer" }), save: () => {} } }).start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bare.getSnapshot().context.vimKeys, false);
  assert.equal(bare.getSnapshot().context.text, "");
});
