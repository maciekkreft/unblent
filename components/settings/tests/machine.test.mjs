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

test("garbage parses to defaults", () => {
  const { actor } = start("not json");
  assert.deepEqual(read(actor), {
    nav: [],
    viewportSwitchHidden: false,
    layoutLockHidden: false,
    layoutLocked: false,
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
    layoutLockHidden: true,
    layoutLocked: false,
  });
  const s = read(actor);
  assert.deepEqual(s.nav, [
    { path: "/a", hidden: true },
    { path: "/b", hidden: false },
  ]);
  assert.equal(s.layoutLocked, true, "a hidden lock forces layoutLocked");
  assert.equal(emitted.length, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual({ ...emitted[0], type: undefined }, { ...s, type: undefined });
});

test("layout.locked toggles the lock and emits", () => {
  const { actor, emitted } = start(null);
  actor.send({ type: "layout.locked", locked: true });
  assert.equal(read(actor).layoutLocked, true);
  assert.equal(emitted.length, 1);
  actor.send({ type: "layout.locked", locked: false });
  assert.equal(read(actor).layoutLocked, false);
  assert.equal(emitted.length, 2);
});

test("a hidden switch ignores layout.locked", () => {
  const { actor, emitted } = start(
    JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutLockHidden: true, layoutLocked: true }),
  );
  actor.send({ type: "layout.locked", locked: false });
  assert.equal(read(actor).layoutLocked, true, "the desk stays locked while the switch is hidden");
  assert.equal(emitted.length, 0);
});

test("a repeat write emits and saves nothing", () => {
  const { actor, saved, emitted } = start(null);
  const same = {
    nav: [],
    viewportSwitchHidden: false,
    layoutLockHidden: false,
    layoutLocked: false,
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
