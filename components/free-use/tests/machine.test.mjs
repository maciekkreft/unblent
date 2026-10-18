import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shareOf, levelOf, percentOf, blockedOf, TRIAL } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

test("the share: all of it before the guest exists, the guest's own after, nothing for an account", () => {
  assert.equal(shareOf({ signedIn: false }), 1);
  assert.equal(shareOf({ signedIn: true, freeUse: { left: 0.66, blocked: false, paused: ["jev"] } }), 0.66, "paused still shows the guest's own share");
  assert.equal(shareOf({ signedIn: true }), null);
  assert.equal(shareOf({ error: "no-answerer" }), null);
});

test("the looks: plenty, 10% or less, used up; never 0% while something is left", () => {
  assert.deepEqual([0.66, 0.1, 0.08, 0, null].map(levelOf), ["plenty", "low", "low", "out", null]);
  assert.deepEqual([1, 0.664, 0.004, 0].map(percentOf), [100, 66, 1, 0]);
});

test("it reads llm at start and follows llm.changed after", async () => {
  const actor = createActor(machine, { input: { ask: async () => ({ signedIn: false }) } }).start();
  await flush();
  assert.equal(actor.getSnapshot().context.share, 1);
  actor.send({ type: "llm.changed", signedIn: true, freeUse: { left: 0.9, blocked: false, paused: [] } });
  assert.equal(actor.getSnapshot().context.share, 0.9);
  actor.send({ type: "llm.changed", signedIn: true });
  assert.equal(actor.getSnapshot().context.share, null);
});

test("a blocked guest's bar reads ended, whatever share is left", async () => {
  assert.equal(levelOf(0.4, true), "ended");
  assert.equal(levelOf(null, true), null, "nothing for an account that is not a guest");
  assert.equal(blockedOf({ signedIn: true, freeUse: { left: 0.4, blocked: true, paused: [] } }), true);
  assert.equal(blockedOf({ signedIn: false }), false);
  const actor = createActor(machine, { input: { ask: async () => ({ signedIn: true, freeUse: { left: 0.4, blocked: true, paused: [] } }) } }).start();
  await flush();
  assert.deepEqual([actor.getSnapshot().context.share, actor.getSnapshot().context.blocked], [0.4, true]);
  actor.send({ type: "llm.changed", signedIn: true, freeUse: { left: 0.4, blocked: false, paused: [] } });
  assert.equal(actor.getSnapshot().context.blocked, false, "unblocked, the share shows again");
});

test("Start over leaves as a removal of the trial, with one fixed id", () => {
  const actor = createActor(machine, { input: { ask: async () => ({ signedIn: false }) } }).start();
  const emitted = [];
  actor.on("removal.started", (e) => emitted.push(e));
  actor.send({ type: "_startOver" });
  actor.send({ type: "_startOver" });
  assert.deepEqual(emitted, [
    { type: "removal.started", kind: "trial", id: TRIAL, name: "" },
    { type: "removal.started", kind: "trial", id: TRIAL, name: "" },
  ]);
});
