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

const asker = (reply, log) => (target, name, payload) => {
  log?.push([target, name, payload]);
  return Promise.resolve(reply);
};

test("asks settings for the starting picture and adopts the profile", async () => {
  const log = [];
  const s = await settle(createActor(machine, { input: { ask: asker({ profile: "product" }, log) } }));
  assert.equal(s.value, "ready");
  assert.equal(s.context.profile, "product");
  assert.deepEqual(log, [["settings", "read", {}]]);
});

test("no settings on the page fails the view (nothing to switch)", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker({ error: "no-answerer" }) } }));
  assert.equal(s.value, "failed");
});

test("a reply without a profile (an older settings) fails the view", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker({ arranging: true }) } }));
  assert.equal(s.value, "failed");
});

test("a toggle in the product emits profile.switched naming the workshop", async () => {
  const actor = createActor(machine, { input: { ask: asker({ profile: "product" }) } });
  const emitted = [];
  actor.on("profile.switched", (e) => emitted.push(e));
  await settle(actor);
  actor.send({ type: "_toggle" });
  assert.deepEqual(emitted, [{ type: "profile.switched", profile: "workshop" }]);
});

test("a toggle in the workshop emits profile.switched naming the product", async () => {
  const actor = createActor(machine, { input: { ask: asker({ profile: "workshop" }) } });
  const emitted = [];
  actor.on("profile.switched", (e) => emitted.push(e));
  await settle(actor);
  actor.send({ type: "_toggle" });
  assert.deepEqual(emitted, [{ type: "profile.switched", profile: "product" }]);
});

test("settings.changed re-applies the active profile (4.3, fourth rule)", async () => {
  const actor = createActor(machine, { input: { ask: asker({ profile: "product" }) } });
  await settle(actor);
  actor.send({ type: "settings.changed", profile: "workshop" });
  assert.equal(actor.getSnapshot().context.profile, "workshop");
});
