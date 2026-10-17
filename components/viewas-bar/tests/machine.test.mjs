import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The bar's decisions (12): shown only while the admin views as someone, Back to you is
// the admin's gesture once, and while the browser changes back it waits.
const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

async function start(picture) {
  const out = [];
  const actor = createActor(machine, { input: { ask: async () => picture } });
  actor.on("viewas.requested", (e) => out.push(e));
  actor.start();
  await flush();
  return { actor, out, context: () => actor.getSnapshot().context };
}

test("the bar shows whom the admin is viewing as, from session's starting picture", async () => {
  const { context } = await start({ userId: "g14", registrationOpen: false, guest: true, name: "Guest 14", viewingAs: "Guest 14" });
  assert.equal(context().viewingAs, "Guest 14");
});

test("nobody else ever sees it, and Back to you does nothing there", async () => {
  const { actor, out, context } = await start({ userId: "a1", registrationOpen: false, admin: true, name: "Admin" });
  assert.equal(context().viewingAs, null);
  actor.send({ type: "_back" });
  assert.deepEqual(out, []);
});

test("Back to you asks session once, and waits while the browser changes back", async () => {
  const picture = { userId: "g14", registrationOpen: false, guest: true, name: "Guest 14", viewingAs: "Guest 14" };
  const { actor, out, context } = await start(picture);
  actor.send({ type: "_back" });
  assert.deepEqual(out, [{ type: "viewas.requested", user: null }]);
  actor.send({ type: "session.changed", ...picture, leaving: true });
  assert.equal(context().leaving, true);
  actor.send({ type: "_back" });
  assert.equal(out.length, 1, "a second press while switching is not sent");
  // The change could not be made (offline): the bar offers Back to you again.
  actor.send({ type: "session.changed", ...picture });
  assert.equal(context().leaving, false);
});
