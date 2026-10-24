import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, BACK_MS } from "../machine.js";

// The decisions of the Account tab (3.4), with session's answers faked and a simulated
// clock: which screen it shows and what it tells session.
const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function start(read) {
  const clock = new SimulatedClock();
  const emitted = [];
  const actor = createActor(machine, { clock, input: { ask: async () => read } });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, clock, emitted, state: () => actor.getSnapshot().value };
}

const LOCAL = { userId: "d1", registrationOpen: false, admin: true };

test("outside the local edition it shows nothing", async () => {
  const { state } = await start({ userId: "u1", registrationOpen: false });
  assert.equal(state(), "hidden");
});

test("Connect account opens Safari and waits; back in the window with nothing ready, it offers Connect again", async () => {
  const { actor, clock, emitted, state } = await start({ ...LOCAL, connect: "off" });
  assert.equal(state(), "notConnected");
  actor.send({ type: "_connect" });
  assert.deepEqual(emitted, [{ type: "connect.requested" }]);
  assert.deepEqual(state(), { waiting: "away" });
  actor.send({ type: "_again" });
  assert.equal(emitted.length, 2, "Open Safari again asks once more");
  actor.send({ type: "session.changed", ...LOCAL, connect: "off" });
  assert.deepEqual(state(), { waiting: "away" }, "still off is no news while the user is in Safari");
  actor.send({ type: "_focused" });
  clock.increment(BACK_MS - 1);
  assert.deepEqual(state(), { waiting: "back" });
  clock.increment(1);
  assert.equal(state(), "notConnected");
});

test("a sign-in that arrives after the user comes back asks to connect, and Connect always keeps", async () => {
  const { actor, clock, emitted, state } = await start({ ...LOCAL, connect: "off" });
  actor.send({ type: "_connect" });
  actor.send({ type: "_focused" });
  actor.send({ type: "session.changed", ...LOCAL, connect: "ready", remote: "Maciek" });
  clock.increment(BACK_MS);
  assert.equal(state(), "choosing");
  assert.equal(actor.getSnapshot().context.remote, "Maciek");
  actor.send({ type: "_confirm" });
  assert.deepEqual(emitted.at(-1), { type: "connect.confirmed", keep: true });
  assert.equal(state(), "switching");
  // session tells the facts the browser is leaving; the tab keeps saying Connecting.
  actor.send({ type: "session.changed", ...LOCAL, connect: "ready", remote: "Maciek", leaving: true, keep: true });
  assert.equal(state(), "switching");
});

test("Cancel in Waiting goes back, and Cancel on the choice forgets the sign-in", async () => {
  const waiting = await start({ ...LOCAL, connect: "off" });
  waiting.actor.send({ type: "_connect" });
  waiting.actor.send({ type: "_cancel" });
  assert.equal(waiting.state(), "notConnected");

  const { actor, emitted, state } = await start({ ...LOCAL, connect: "ready", remote: "Maciek" });
  actor.send({ type: "_cancel" });
  assert.deepEqual(emitted, [{ type: "disconnect.requested" }]);
  actor.send({ type: "session.changed", ...LOCAL, connect: "off" });
  assert.equal(state(), "notConnected");
});

test("connected, Disconnect asks session; a refusal for unsent changes says they wait on this Mac", async () => {
  const { actor, emitted, state } = await start({ userId: "a1", registrationOpen: false, connect: "on", remote: "Maciek" });
  assert.equal(state(), "connected");
  actor.send({ type: "_disconnect" });
  assert.deepEqual(emitted, [{ type: "disconnect.requested" }]);
  assert.equal(state(), "switching");
  actor.send({ type: "session.changed", userId: "a1", connect: "on", remote: "Maciek", leaving: true });
  assert.equal(state(), "switching");
  // As session stops leaving: the picture again, then why.
  actor.send({ type: "session.changed", userId: "a1", connect: "on", remote: "Maciek" });
  actor.send({ type: "session.refused", reason: "unsent" });
  assert.equal(state(), "connected");
  assert.equal(actor.getSnapshot().context.waiting, true);
  actor.send({ type: "_disconnect" });
  assert.equal(actor.getSnapshot().context.waiting, false, "trying again clears it");
});

test("connected but signed out means sync was turned off, and there is no Disconnect", async () => {
  const { actor, emitted, state } = await start({ userId: null, registrationOpen: false, connect: "on", remote: "Maciek" });
  assert.equal(state(), "syncOff");
  actor.send({ type: "_disconnect" });
  assert.deepEqual(emitted, [], "the Mac's server would refuse it");
  assert.equal(state(), "syncOff");
});

test("a Disconnect refused because sync was just turned off ends on the sync-off screen", async () => {
  const { actor, emitted, state } = await start({ userId: "a1", registrationOpen: false, connect: "on", remote: "Maciek" });
  actor.send({ type: "_disconnect" });
  assert.deepEqual(emitted, [{ type: "disconnect.requested" }]);
  actor.send({ type: "session.changed", userId: "a1", connect: "on", remote: "Maciek", leaving: true, keep: true });
  assert.equal(state(), "switching");
  // session stops leaving, then its look at the server finds the account refusing this Mac.
  actor.send({ type: "session.changed", userId: "a1", connect: "on", remote: "Maciek" });
  assert.equal(state(), "connected");
  actor.send({ type: "session.changed", userId: null, registrationOpen: false, connect: "on", remote: "Maciek" });
  assert.equal(state(), "syncOff");
});
