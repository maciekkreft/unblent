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
  layoutLockHidden: false,
  layoutLocked: false,
  ...over,
});
const asker = (reply, log) => (target, name, payload) => {
  log?.push([target, name, payload]);
  return Promise.resolve(reply);
};

test("asks settings for the starting picture and reflects the lock", async () => {
  const log = [];
  const s = await settle(createActor(machine, { input: { ask: asker(settings({ layoutLocked: true }), log) } }));
  assert.equal(s.value, "ready");
  assert.equal(s.context.locked, true);
  assert.equal(s.context.hidden, false);
  assert.deepEqual(log, [["settings", "read", {}]]);
});

test("no settings on the page fails the view (no lock)", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker({ error: "no-answerer" }) } }));
  assert.equal(s.value, "failed");
});

test("a hidden switch is reflected", async () => {
  const s = await settle(
    createActor(machine, { input: { ask: asker(settings({ layoutLockHidden: true, layoutLocked: true })) } }),
  );
  assert.equal(s.context.hidden, true);
  assert.equal(s.context.locked, true);
});

test("a toggle emits layout.locked with the flipped state", async () => {
  const actor = createActor(machine, { input: { ask: asker(settings()) } });
  const emitted = [];
  actor.on("layout.locked", (e) => emitted.push(e));
  await settle(actor);
  actor.send({ type: "_toggle" });
  assert.deepEqual(emitted, [{ type: "layout.locked", locked: true }]);
});

test("settings.changed re-applies the lock (4.3, fourth rule)", async () => {
  const actor = createActor(machine, { input: { ask: asker(settings()) } });
  await settle(actor);
  actor.send({ type: "settings.changed", ...settings({ layoutLocked: true }) });
  assert.equal(actor.getSnapshot().context.locked, true);
});
