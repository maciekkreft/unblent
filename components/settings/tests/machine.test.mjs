import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake store and its
// reply/emit are read directly, so no browser is needed.
const start = (stored, saved = []) => {
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v) } });
  const emitted = [];
  actor.on("settings.changed", (e) => emitted.push(e));
  actor.start();
  return { actor, saved, emitted };
};

const read = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  return reply;
};

test("garbage parses to defaults, arranging on", () => {
  const { actor } = start("not json");
  assert.deepEqual(read(actor), {
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
  });
});

test("settings.edited dedupes nav by path and applies the invariant", () => {
  const { actor, saved, emitted } = start(null);
  actor.send({
    type: "settings.edited",
    nav: [
      { path: "/a", hidden: true },
      { path: "/a", hidden: false },
      { path: "/b", hidden: false },
    ],
    viewportSwitchHidden: false,
    layoutSwitchHidden: true,
    arranging: true,
  });
  const s = read(actor);
  assert.deepEqual(s.nav, [
    { path: "/a", hidden: true },
    { path: "/b", hidden: false },
  ]);
  assert.equal(s.arranging, false, "a hidden switch forces arranging off");
  assert.equal(emitted.length, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual({ ...emitted[0], type: undefined }, { ...s, type: undefined });
});

test("unhiding the switch keeps arranging off until the switch turns it on", () => {
  const { actor, emitted } = start(
    JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: true, arranging: false }),
  );
  // The sheet unhides, sending back the arranging it last saw (off).
  actor.send({ type: "settings.edited", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: false });
  assert.equal(read(actor).arranging, false, "unhiding does not turn arranging back on");
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(read(actor).arranging, true);
  assert.equal(emitted.length, 2);
});

test("layout.switched toggles arranging and emits", () => {
  const { actor, emitted } = start(null);
  actor.send({ type: "layout.switched", arranging: false });
  assert.equal(read(actor).arranging, false);
  assert.equal(emitted.length, 1);
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(read(actor).arranging, true);
  assert.equal(emitted.length, 2);
});

test("a hidden switch ignores layout.switched", () => {
  const { actor, emitted } = start(
    JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: true, arranging: false }),
  );
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(read(actor).arranging, false, "the desk stays unarrangeable while the switch is hidden");
  assert.equal(emitted.length, 0);
});

test("layout.switched on a no-op emits and saves nothing", () => {
  const { actor, saved, emitted } = start(null);
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(emitted.length, 0, "arranging is already on by default");
  assert.equal(saved.length, 0);
});

test("a repeat write emits and saves nothing", () => {
  const { actor, saved, emitted } = start(null);
  const same = {
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
  };
  actor.send({ type: "settings.edited", ...same });
  assert.equal(emitted.length, 0);
  assert.equal(saved.length, 0);
});

test("read replies a copy, not the live nav", () => {
  const { actor } = start(JSON.stringify({ nav: [{ path: "/a", hidden: true }] }));
  const a = read(actor);
  a.nav[0].hidden = false;
  assert.equal(read(actor).nav[0].hidden, true, "mutating a reply does not change the fact");
});
