import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, adminOf, tabsOf, shownOf, slottedOf } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

// The product's sheet: Settings, then the two parts of Administration (12).
const CHILDREN = [
  { label: "Settings", admin: false },
  { label: "Administration", admin: true },
  { label: "Administration", admin: true },
];

test("only the admin counts as the admin, and not while viewing as someone", () => {
  assert.equal(adminOf({ userId: "a", admin: true }), true);
  assert.equal(adminOf({ userId: "a", admin: true, viewingAs: "Guest 3" }), false);
  assert.equal(adminOf({ userId: "g", guest: true }), false);
  assert.equal(adminOf({ userId: null, admin: true }), false);
  assert.equal(adminOf({ error: "no-answerer" }), false);
});

test("everyone else sees one tab, Settings; the admin sees Administration too, its parts together", () => {
  assert.deepEqual(tabsOf(CHILDREN, false), ["Settings"]);
  assert.deepEqual(tabsOf(CHILDREN, true), ["Settings", "Administration"]);
  assert.deepEqual(slottedOf(CHILDREN, true, null), [0], "Settings is shown first");
  assert.deepEqual(slottedOf(CHILDREN, true, "Administration"), [1, 2]);
  assert.equal(shownOf(CHILDREN, false, "Administration"), "Settings", "without the role the sheet falls back to Settings");
  assert.deepEqual(slottedOf(CHILDREN, false, "Administration"), [0]);
});

test("it asks session at start and follows session.changed after", async () => {
  const asked = [];
  const actor = createActor(machine, {
    input: { ask: async (...a) => (asked.push(a), { userId: "a", registrationOpen: false, admin: true }), children: CHILDREN },
  }).start();
  await flush();
  assert.deepEqual(asked, [["session", "read", {}]]);
  assert.equal(actor.getSnapshot().context.admin, true);
  actor.send({ type: "_pick", label: "Administration" });
  assert.deepEqual(slottedOf(CHILDREN, true, actor.getSnapshot().context.picked), [1, 2]);
  // Viewing as someone hides Administration, and the sheet shows Settings.
  actor.send({ type: "session.changed", userId: "g", admin: false, viewingAs: "Guest 3" });
  const { admin, picked } = actor.getSnapshot().context;
  assert.equal(admin, false);
  assert.equal(shownOf(CHILDREN, admin, picked), "Settings");
});

// The view hands back the tab picked before a reload; it is shown once session says
// the admin is here, and Settings is shown until then and for anyone else.
test("a pick handed back by the view is shown to the admin and kept for anyone else", async () => {
  const start = (picture) =>
    createActor(machine, { input: { ask: async () => picture, children: CHILDREN, picked: "Administration" } }).start();
  const admin = start({ userId: "a", admin: true });
  assert.equal(shownOf(CHILDREN, admin.getSnapshot().context.admin, "Administration"), "Settings", "before session answers");
  await flush();
  assert.equal(shownOf(CHILDREN, admin.getSnapshot().context.admin, admin.getSnapshot().context.picked), "Administration");
  const guest = start({ userId: "g", guest: true });
  await flush();
  const { admin: isAdmin, picked } = guest.getSnapshot().context;
  assert.equal(shownOf(CHILDREN, isAdmin, picked), "Settings");
  assert.equal(picked, "Administration");
});
