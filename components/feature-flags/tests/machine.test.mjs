import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, onOf, settle, rowsOf, mayReleaseOf } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

const FLAGS = { off: ["choice-points"], hidden: ["choice-points"], released: [], shown: ["choice-points"] };

test("a waiting switch shows what was asked; the next picture settles or refuses it", () => {
  const context = { released: ["choice-points"], shown: ["choice-points"], waiting: { "show:choice-points": false } };
  assert.equal(onOf(context, "release", "choice-points"), true);
  assert.equal(onOf(context, "show", "choice-points"), false, "shown as asked while it waits");
  assert.deepEqual(settle({ "show:choice-points": false }, { released: [], shown: [] }), { waiting: {}, refused: null });
  assert.deepEqual(settle({ "show:choice-points": false }, { released: [], shown: ["choice-points"] }), {
    waiting: {},
    refused: { column: "show", id: "choice-points" },
  });
});

test("only the admin on the website sees Release and the rows of features not released", () => {
  assert.equal(mayReleaseOf({ userId: "a", admin: true }), true);
  assert.equal(mayReleaseOf({ userId: "a", admin: true, viewingAs: "Guest 3" }), false);
  assert.equal(mayReleaseOf({ userId: "a", admin: true, connect: "off" }), false, "not on a Mac");
  assert.equal(mayReleaseOf({ userId: "g", guest: true }), false);
  assert.deepEqual(rowsOf({ mayRelease: false, released: ["choice-points"] }).map((f) => f.id), ["choice-points"]);
  assert.deepEqual(rowsOf({ mayRelease: false, released: [] }).map((f) => f.id), []);
  assert.deepEqual(rowsOf({ mayRelease: true, released: [] }).map((f) => f.id), ["choice-points"]);
});

test("it asks flags and session at start, emits each switch with its column and follows flags.changed", async () => {
  const asked = [];
  const emitted = [];
  const answers = { flags: FLAGS, session: { userId: "a", admin: true } };
  const actor = createActor(machine, { input: { ask: async (...a) => (asked.push(a), answers[a[0]]) } });
  actor.on("flag.switched", ({ type, ...rest }) => emitted.push(rest));
  actor.start();
  await flush();
  assert.deepEqual(asked, [["flags", "read", {}], ["session", "read", {}]]);
  actor.send({ type: "_switch", column: "release", feature: "choice-points", on: true });
  assert.deepEqual(emitted, [{ feature: "choice-points", on: true, column: "release" }]);
  assert.equal(onOf(actor.getSnapshot().context, "release", "choice-points"), true);
  actor.send({ type: "flags.changed", ...FLAGS });
  assert.deepEqual(actor.getSnapshot().context.refused, { column: "release", id: "choice-points" });
  assert.equal(onOf(actor.getSnapshot().context, "release", "choice-points"), false, "a refused switch goes back");
  actor.send({ type: "_switch", column: "show", feature: "choice-points", on: false });
  assert.equal(actor.getSnapshot().context.refused, null, "the next switch clears the line");
  actor.send({ type: "session.changed", userId: "a", admin: true, viewingAs: "Guest 3" });
  actor.send({ type: "_switch", column: "release", feature: "choice-points", on: true });
  assert.equal(emitted.length, 2, "no Release while viewing as someone");
  actor.send({ type: "session.changed", userId: null });
  actor.send({ type: "_switch", column: "show", feature: "choice-points", on: true });
  assert.equal(emitted.length, 2, "no Show while signed out");
});
