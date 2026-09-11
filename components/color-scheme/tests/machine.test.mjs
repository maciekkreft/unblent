import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2), so it is tested directly, with the
// environment faked: media whose value the test can flip, apply that records.
function fakeMedia(initial) {
  const listeners = new Set();
  return {
    matches: initial,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    flip(matches) {
      this.matches = matches;
      for (const fn of listeners) fn(matches);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function start(initial) {
  const applied = [];
  const emitted = [];
  const media = fakeMedia(initial);
  const actor = createActor(machine, { input: { media, apply: (s) => applied.push(s) } });
  actor.on("color-scheme.changed", (e) => emitted.push(e));
  actor.start();
  return { actor, media, applied, emitted };
}

test("applies the initial scheme on start, without emitting", () => {
  const { applied, emitted } = start(true);
  assert.deepEqual(applied, ["dark"]);
  assert.deepEqual(emitted, []);
});

test("a flip applies and emits the new scheme", () => {
  const { media, applied, emitted } = start(false);
  assert.deepEqual(applied, ["light"]);
  media.flip(true);
  assert.deepEqual(applied, ["light", "dark"]);
  assert.deepEqual(emitted, [{ type: "color-scheme.changed", scheme: "dark" }]);
});

test("an unchanged value neither applies nor emits", () => {
  const { media, applied, emitted } = start(false);
  media.flip(false);
  assert.deepEqual(applied, ["light"]);
  assert.deepEqual(emitted, []);
});

test("stopping the actor unsubscribes from media", () => {
  const { actor, media } = start(false);
  assert.equal(media.listenerCount, 1);
  actor.stop();
  assert.equal(media.listenerCount, 0);
});
