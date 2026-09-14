import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake `ask` (the shape
// view.js builds), so no bus and no network. fromPromise settles on a microtask.
const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function start(ask) {
  const emitted = [];
  const actor = createActor(machine, { input: { ask } });
  actor.on("signin.requested", (e) => emitted.push(e.type));
  actor.on("signout.requested", (e) => emitted.push(e.type));
  actor.start();
  return { actor, emitted };
}

const ctx = (actor) => actor.getSnapshot().context;

test("the starting picture from session: read lands the switch in ready", async () => {
  const anon = start(() => Promise.resolve({ userId: null, registrationOpen: true }));
  await flush();
  assert.equal(anon.actor.getSnapshot().value, "ready");
  assert.equal(ctx(anon.actor).userId, null);
  assert.equal(ctx(anon.actor).registrationOpen, true);

  const signedIn = start(() => Promise.resolve({ userId: "u1", registrationOpen: false }));
  await flush();
  assert.equal(signedIn.actor.getSnapshot().value, "ready");
  assert.equal(ctx(signedIn.actor).userId, "u1");
});

test("no answerer (no session on the page) fails the switch, so the view renders nothing", async () => {
  const { actor } = start(() => Promise.resolve({ error: "no-answerer" }));
  await flush();
  assert.equal(actor.getSnapshot().value, "failed");
});

test("a click emits the gesture that matches the current user (4.3 fifth rule)", async () => {
  const anon = start(() => Promise.resolve({ userId: null, registrationOpen: true }));
  await flush();
  anon.actor.send({ type: "_toggle" });
  assert.deepEqual(anon.emitted, ["signin.requested"]);

  const signedIn = start(() => Promise.resolve({ userId: "u1", registrationOpen: false }));
  await flush();
  signedIn.actor.send({ type: "_toggle" });
  assert.deepEqual(signedIn.emitted, ["signout.requested"]);
});

test("session.changed is adopted, carrying registrationOpen for the label (4.3 fourth rule)", async () => {
  const { actor } = start(() => Promise.resolve({ userId: "u1", registrationOpen: false }));
  await flush();
  actor.send({ type: "session.changed", userId: null, registrationOpen: true });
  assert.equal(ctx(actor).userId, null);
  assert.equal(ctx(actor).registrationOpen, true);

  // A change that omits registrationOpen leaves the cached value untouched.
  actor.send({ type: "session.changed", userId: "u2" });
  assert.equal(ctx(actor).userId, "u2");
  assert.equal(ctx(actor).registrationOpen, true);
});
