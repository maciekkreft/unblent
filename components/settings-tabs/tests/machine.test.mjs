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
