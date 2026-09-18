import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, visible, grouped } from "../machine.js";

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
  { path: "/workshop/design/tokens", title: "Tokens", kind: "tokens" },
  { path: "/workshop/design/notes", title: "Notes", kind: "stem" },
  { path: "/workshop/apps/notes", title: "Notes", kind: "app" },
];

// A fake ask that answers pages and settings; settings defaults to no order,
// nothing hidden.
const asker = (settings, log) => (target, name, payload) => {
  log?.push([target, name, payload]);
  if (target === "pages") return Promise.resolve({ pages: PAGES });
  return Promise.resolve(
    settings === "error"
      ? { error: "no-answerer" }
      : { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, ...settings },
  );
};

test("visible drops hidden pages but always keeps the current one", () => {
  const rows = visible(
    PAGES,
    [
      { path: "/workshop/design/notes", hidden: true },
      { path: "/workshop/design/tokens", hidden: true },
    ],
    "/workshop/design/tokens",
  );
  assert.deepEqual(
    rows.map((r) => r.path),
    ["/workshop/design/tokens", "/workshop/apps/notes"],
  );
});

test("grouped bins pages by kind in composition order, with a label each", () => {
  const groups = grouped(PAGES, [], "/workshop/design/tokens");
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Design", "Stems", "Apps"],
  );
  assert.deepEqual(
    groups.map((g) => g.rows.map((r) => r.path)),
    [["/workshop/design/tokens"], ["/workshop/design/notes"], ["/workshop/apps/notes"]],
  );
});

test("grouped keeps the user's order within a group and drops empty groups", () => {
  const pages = [
    { path: "/workshop/design/tokens", title: "Tokens", kind: "tokens" },
    { path: "/workshop/design/contracts", title: "Contracts", kind: "contracts" },
    { path: "/workshop/apps/notes", title: "Notes", kind: "app" },
  ];
  const nav = [{ path: "/workshop/design/contracts", hidden: false }, { path: "/workshop/design/tokens", hidden: false }];
  const groups = grouped(pages, nav, "/workshop/design/tokens");
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Design", "Apps"],
    "no stem page, so no Stems group",
  );
  assert.deepEqual(
    groups[0].rows.map((r) => r.path),
    ["/workshop/design/contracts", "/workshop/design/tokens"],
    "the user's order holds inside the Design group",
  );
});

test("grouped drops hidden pages but keeps the current one", () => {
  const nav = [{ path: "/workshop/design/notes", hidden: true }, { path: "/workshop/apps/notes", hidden: true }];
  const groups = grouped(PAGES, nav, "/workshop/apps/notes");
  assert.deepEqual(
    groups.map((g) => [g.label, g.rows.map((r) => r.path)]),
    [["Design", ["/workshop/design/tokens"]], ["Apps", ["/workshop/apps/notes"]]],
    "the hidden stem is gone; the hidden current app stays",
  );
});

test("grouped shows no links in the product profile", () => {
  assert.deepEqual(grouped(PAGES, [], "/workshop/apps/notes", "product"), [], "the product bar carries no page links");
});

test("grouped falls to the full nav when the profile is absent", () => {
  assert.deepEqual(
    grouped(PAGES, [], "/workshop/design/tokens", undefined).map((g) => g.label),
    ["Design", "Stems", "Apps"],
    "no profile means workshop, the full nav as before profiles existed",
  );
});

test("the profile from settings drops every link in product", async () => {
  const s = await settle(
    createActor(machine, { input: { ask: asker({ profile: "product" }), current: "/notes" } }),
  );
  assert.equal(s.context.profile, "product");
  assert.deepEqual(grouped(s.context.pages, s.context.nav, s.context.current, s.context.profile), []);
});

test("a settings reply without a profile stays in workshop", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker({}), current: "/workshop/design/tokens" } }));
  assert.equal(s.context.profile, "workshop");
});

test("settings.changed adopts a new profile", async () => {
  const actor = createActor(machine, { input: { ask: asker({}), current: "/notes" } });
  await settle(actor);
  assert.equal(actor.getSnapshot().context.profile, "workshop");
  actor.send({
    type: "settings.changed",
    nav: [],
    viewportSwitchHidden: true,
    layoutSwitchHidden: true,
    arranging: false,
    profile: "product",
  });
  assert.equal(actor.getSnapshot().context.profile, "product");
});

test("asks pages then settings and becomes ready", async () => {
  const log = [];
  const s = await settle(createActor(machine, { input: { ask: asker({}, log), current: "/workshop/design/tokens" } }));
  assert.equal(s.value, "ready");
  assert.deepEqual(s.context.pages, PAGES);
  assert.deepEqual(log, [
    ["pages", "list", {}],
    ["settings", "read", {}],
  ]);
});

test("the settings order and hidden pages are applied", async () => {
  const nav = [
    { path: "/workshop/apps/notes", hidden: false },
    { path: "/workshop/design/notes", hidden: true },
  ];
  const s = await settle(createActor(machine, { input: { ask: asker({ nav }), current: "/workshop/design/tokens" } }));
  assert.deepEqual(
    visible(s.context.pages, s.context.nav, s.context.current).map((r) => r.path),
    ["/workshop/apps/notes", "/workshop/design/tokens"],
    "listed first in order, the hidden one dropped, the rest appended",
  );
});

test("a no-answerer for settings keeps every page in the default order", async () => {
  const s = await settle(createActor(machine, { input: { ask: asker("error"), current: "/workshop/design/tokens" } }));
  assert.equal(s.value, "ready", "a page without settings does not fail");
  assert.deepEqual(
    visible(s.context.pages, s.context.nav, s.context.current).map((r) => r.path),
    PAGES.map((p) => p.path),
  );
});

test("a pages error fails the view and keeps the reason", async () => {
  const ask = (target) =>
    target === "pages" ? Promise.resolve({ error: "unavailable" }) : Promise.resolve({ nav: [] });
  const s = await settle(createActor(machine, { input: { ask, current: "/workshop/design/tokens" } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "unavailable");
});

test("settings.changed re-applies the order (4.3, fourth rule)", async () => {
  const actor = createActor(machine, { input: { ask: asker({}), current: "/workshop/design/tokens" } });
  await settle(actor);
  actor.send({
    type: "settings.changed",
    nav: [{ path: "/workshop/design/notes", hidden: true }],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
  });
  const c = actor.getSnapshot().context;
  assert.deepEqual(
    visible(c.pages, c.nav, c.current).map((r) => r.path),
    ["/workshop/design/tokens", "/workshop/apps/notes"],
  );
});
