import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, visible } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake ask, the
// shape the bus's `ask` returns (4.2), and a `current` the view would read from
// `location`.
function settle(actor) {
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready") || s.matches("failed")) resolve(s);
    });
    actor.start();
  });
}

const PAGES = [
  { path: "/design/tokens", title: "Tokens", kind: "tokens" },
  { path: "/design/notes", title: "Notes", kind: "stem" },
  { path: "/apps/notes", title: "Notes", kind: "app" },
];

// A fake ask that answers pages and settings; settings defaults to no order,
// nothing hidden.
const asker = (settings, log) => (target, name, payload) => {
  log?.push([target, name, payload]);
  if (target === "pages") return Promise.resolve({ pages: PAGES });
  return Promise.resolve(
    settings === "error"
      ? { error: "no-answerer" }
      : { nav: [], viewportSwitchHidden: false, layoutLockHidden: false, layoutLocked: false, ...settings },
  );
};

test("visible drops hidden pages but always keeps the current one", () => {
  const rows = visible(
    PAGES,
    [
      { path: "/design/notes", hidden: true },
      { path: "/design/tokens", hidden: true },
    ],
    "/design/tokens",
  );
  assert.deepEqual(
    rows.map((r) => r.path),
    ["/design/tokens", "/apps/notes"],
  );
});

test("asks pages then settings and becomes ready", async () => {
  const log = [];
  const s = await settle(createActor(machine, { input: { ask: asker({}, log), current: "/design/tokens" } }));
  assert.equal(s.value, "ready");
  assert.deepEqual(s.context.pages, PAGES);
  assert.deepEqual(log, [
    ["pages", "list", {}],
    ["settings", "read", {}],
  ]);
});

test("the settings order and hidden pages are applied", async () => {
  const nav = [
    { path: "/apps/notes", hidden: false },
    { path: "/design/notes", hidden: true },
  ];
  const s = await settle(createActor(machine, { input: { ask: asker({ nav }), current: "/design/tokens" } }));
  assert.deepEqual(
    visible(s.context.pages, s.context.nav, s.context.current).map((r) => r.path),
    ["/apps/notes", "/design/tokens"],
    "listed first in order, the hidden one dropped, the rest appended",
  );
});

test("a no-answerer for settings keeps every page in the default order", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker("error"), current: "/design/tokens" } }));
  assert.equal(s.value, "ready", "a page without settings does not fail");
  assert.deepEqual(
    visible(s.context.pages, s.context.nav, s.context.current).map((r) => r.path),
    PAGES.map((p) => p.path),
  );
});

test("a pages error fails the view and keeps the reason", async () => {
  const ask = (target) =>
    target === "pages" ? Promise.resolve({ error: "unavailable" }) : Promise.resolve({ nav: [] });
  const s = await settle(createActor(machine, { input: { ask, current: "/design/tokens" } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "unavailable");
});

test("settings.changed re-applies the order (4.3, fourth rule)", async () => {
  const actor = createActor(machine, { input: { ask: asker({}), current: "/design/tokens" } });
  await settle(actor);
  actor.send({
    type: "settings.changed",
    nav: [{ path: "/design/notes", hidden: true }],
    viewportSwitchHidden: false,
    layoutLockHidden: false,
    layoutLocked: false,
  });
  const c = actor.getSnapshot().context;
  assert.deepEqual(
    visible(c.pages, c.nav, c.current).map((r) => r.path),
    ["/design/tokens", "/apps/notes"],
  );
});
