import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, merge } from "../machine.js";

const PAGES = [
  { path: "/a", title: "A", kind: "stem" },
  { path: "/b", title: "B", kind: "stem" },
  { path: "/c", title: "C", kind: "app" },
];

// Drive the actor with a fake ask (4.2): pages first, then settings.
const start = (settings, current = "/a") => {
  const ask = (target) =>
    Promise.resolve(
      target === "pages"
        ? { pages: PAGES }
        : { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, ...settings },
    );
  const actor = createActor(machine, { input: { ask, current } });
  const emitted = [];
  actor.on("settings.edited", (e) => emitted.push(e));
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready") || s.matches("failed")) resolve({ actor, emitted, snapshot: s });
    });
    actor.start();
  });
};

test("merge lists nav order first, then unlisted pages, keeping only real pages", () => {
  const rows = merge(PAGES, [
    { path: "/c", hidden: true },
    { path: "/gone", hidden: false },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.path, r.hidden]),
    [
      ["/c", true],
      ["/a", false],
      ["/b", false],
    ],
  );
});

test("a rejected pages load fails the view", async () => {
  const actor = createActor(machine, { input: { ask: () => Promise.reject(new Error("x")), current: "/a" } });
  const s = await new Promise((resolve) => {
    actor.subscribe((snap) => snap.matches("failed") && resolve(snap));
    actor.start();
  });
  assert.equal(s.value, "failed");
});

test("_down materialises the whole order and swaps", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_down", path: "/a" });
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].nav, [
    { path: "/b", hidden: false },
    { path: "/a", hidden: false },
    { path: "/c", hidden: false },
  ]);
});

test("_up at the top and _down at the bottom are guarded out", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_up", path: "/a" });
  actor.send({ type: "_down", path: "/c" });
  assert.equal(emitted.length, 0);
});

test("hiding the current page is guarded out; another page hides", async () => {
  const { actor, emitted } = await start(undefined, "/a");
  actor.send({ type: "_hide", path: "/a" });
  assert.equal(emitted.length, 0, "the sheet's own page keeps no hide control");
  actor.send({ type: "_hide", path: "/b" });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].nav.find((r) => r.path === "/b").hidden, true);
});

test("the switch toggles flip their flag", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_toggleViewport" });
  assert.equal(emitted[0].viewportSwitchHidden, true);
  actor.send({ type: "_toggleLayout" });
  assert.equal(emitted[1].layoutSwitchHidden, true);
});

test("_reset emits the defaults", async () => {
  const { actor, emitted } = await start({ nav: [{ path: "/a", hidden: true }], viewportSwitchHidden: true });
  actor.send({ type: "_reset" });
  assert.deepEqual(emitted[0], {
    type: "settings.edited",
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
  });
});

test("settings.changed is adopted (4.3, fourth rule)", async () => {
  const { actor } = await start();
  actor.send({
    type: "settings.changed",
    nav: [{ path: "/c", hidden: false }],
    viewportSwitchHidden: true,
    layoutSwitchHidden: false,
    arranging: true,
  });
  assert.equal(actor.getSnapshot().context.settings.viewportSwitchHidden, true);
  assert.deepEqual(actor.getSnapshot().context.settings.nav, [{ path: "/c", hidden: false }]);
});
