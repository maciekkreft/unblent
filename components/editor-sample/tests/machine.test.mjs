import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake ask, the shape the
// bus's `ask` returns (4.2).
function settle(actor) {
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready")) resolve(s);
    });
    actor.start();
  });
}

const asker = (reply, log) => (target, name, payload) => {
  log?.push([target, name, payload]);
  return Promise.resolve(reply);
};

test("asks settings for the starting picture and takes vimKeys from it", async () => {
  const log = [];
  const s = await settle(createActor(machine, { input: { ask: asker({ vimKeys: true }, log) } }));
  assert.equal(s.context.vimKeys, true);
  assert.deepEqual(log, [["settings", "read", {}]]);
});

test("no settings on the page leaves Vim off", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker({ error: "no-answerer" }) } }));
  assert.equal(s.context.vimKeys, false);
});

test("settings.changed turns Vim on and off (4.3, fourth rule)", async () => {
  const actor = createActor(machine, { input: { ask: asker({}) } });
  await settle(actor);
  actor.send({ type: "settings.changed", vimKeys: true });
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "settings.changed" });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
});
