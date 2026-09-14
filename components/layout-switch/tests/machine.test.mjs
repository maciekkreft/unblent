import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake ask, the
// shape the bus's `ask` returns (4.2).
function settle(actor) {
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready") || s.matches("failed")) resolve(s);
    });
    actor.start();
  });
}

const settings = (over = {}) => ({
  nav: [],
  viewportSwitchHidden: false,
  layoutSwitchHidden: false,
  arranging: true,
  ...over,
});
const asker = (reply, log) => (target, name, payload) => {
  log?.push([target, name, payload]);
  return Promise.resolve(reply);
};

test("asks settings for the starting picture and reflects arranging", async () => {
  const log = [];
  const s = await settle(createActor(machine, { input: { ask: asker(settings({ arranging: false }), log) } }));
  assert.equal(s.value, "ready");
  assert.equal(s.context.arranging, false);
  assert.equal(s.context.hidden, false);
  assert.deepEqual(log, [["settings", "read", {}]]);
});

test("no settings on the page fails the view (no arranging)", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker({ error: "no-answerer" }) } }));
  assert.equal(s.value, "failed");
});

test("a hidden switch is reflected", async () => {
  const s = await settle(
    createActor(machine, { input: { ask: asker(settings({ layoutSwitchHidden: true, arranging: false })) } }),
  );
  assert.equal(s.context.hidden, true);
  assert.equal(s.context.arranging, false);
});

test("a toggle emits layout.switched with the flipped state", async () => {
  const actor = createActor(machine, { input: { ask: asker(settings()) } });
  const emitted = [];
  actor.on("layout.switched", (e) => emitted.push(e));
  await settle(actor);
  actor.send({ type: "_toggle" });
  assert.deepEqual(emitted, [{ type: "layout.switched", arranging: false }]);
});

test("settings.changed re-applies arranging (4.3, fourth rule)", async () => {
  const actor = createActor(machine, { input: { ask: asker(settings()) } });
  await settle(actor);
  actor.send({ type: "settings.changed", ...settings({ arranging: false }) });
  assert.equal(actor.getSnapshot().context.arranging, false);
});
