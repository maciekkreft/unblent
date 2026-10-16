import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, readout } from "../machine.js";

// The editing rule itself is the editor kit's, tested in editor/tests.

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
