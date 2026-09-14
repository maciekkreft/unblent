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

const asker = (viewport, settings, log) => (target, name, payload) => {
  log?.push([target, name, payload]);
  if (target === "viewport") return Promise.resolve(viewport);
  return Promise.resolve(settings);
};
const shown = { viewportSwitchHidden: false, layoutLockHidden: false, layoutLocked: false, nav: [] };

test("asks viewport then settings and becomes ready, shown by default", async () => {
  const log = [];
  const s = await settle(createActor(machine, { input: { ask: asker({ viewport: "phone" }, shown, log) } }));
  assert.equal(s.value, "ready");
  assert.equal(s.context.viewport, "phone");
  assert.equal(s.context.hidden, false);
  assert.deepEqual(log, [
    ["viewport", "read", {}],
    ["settings", "read", {}],
  ]);
});

test("settings marks the switch hidden", async () => {
  const s = await settle(
    createActor(machine, { input: { ask: asker({ viewport: "desk" }, { ...shown, viewportSwitchHidden: true }) } }),
  );
  assert.equal(s.context.hidden, true);
});

test("a no-answerer for settings keeps the switch shown", async () => {
  const s = await settle(
    createActor(machine, { input: { ask: asker({ viewport: "desk" }, { error: "no-answerer" }) } }),
  );
  assert.equal(s.value, "ready");
  assert.equal(s.context.hidden, false);
});

test("a viewport error fails the view", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker({ error: "unavailable" }, shown) } }));
  assert.equal(s.value, "failed");
});

test("viewport.changed updates the shown viewport (4.3, fourth rule)", async () => {
  const actor = createActor(machine, { input: { ask: asker({ viewport: "desk" }, shown) } });
  await settle(actor);
  actor.send({ type: "viewport.changed", viewport: "phone" });
  assert.equal(actor.getSnapshot().context.viewport, "phone");
});

test("settings.changed hides or shows the switch", async () => {
  const actor = createActor(machine, { input: { ask: asker({ viewport: "desk" }, shown) } });
  await settle(actor);
  actor.send({ type: "settings.changed", ...shown, viewportSwitchHidden: true });
  assert.equal(actor.getSnapshot().context.hidden, true);
  actor.send({ type: "settings.changed", ...shown, viewportSwitchHidden: false });
  assert.equal(actor.getSnapshot().context.hidden, false);
});

test("a select gesture emits viewport.selected as-is", async () => {
  const actor = createActor(machine, { input: { ask: asker({ viewport: "desk" }, shown) } });
  const emitted = [];
  actor.on("viewport.selected", (e) => emitted.push(e));
  await settle(actor);
  actor.send({ type: "_select", viewport: "phone" });
  assert.deepEqual(emitted, [{ type: "viewport.selected", viewport: "phone" }]);
});
