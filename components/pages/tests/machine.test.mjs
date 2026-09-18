import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake load whose
// promise the test settles, and fake queries shaped as the bus delivers them (4.2).
function start() {
  const calls = [];
  const load = () =>
    new Promise((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  const actor = createActor(machine, { input: { load } });
  actor.start();
  const query = () => {
    const replies = [];
    actor.send({ type: "list?", cid: "c", payload: {}, reply: (v) => replies.push(v) });
    return replies;
  };
  return { actor, calls, query };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a list query is answered with the loaded pages", async () => {
  const { calls, query } = start();
  const replies = query();
  assert.equal(calls.length, 1);
  calls[0].resolve({ pages: [{ path: "/workshop/design/tokens" }] });
  await tick();
  assert.deepEqual(replies, [{ pages: [{ path: "/workshop/design/tokens" }] }]);
});

test("queries during one load share it and are all answered", async () => {
  const { calls, query } = start();
  const first = query();
  const second = query();
  assert.equal(calls.length, 1);
  calls[0].resolve({ pages: [] });
  await tick();
  assert.deepEqual(first, [{ pages: [] }]);
  assert.deepEqual(second, [{ pages: [] }]);
});

test("a failed load replies unavailable", async () => {
  const { calls, query } = start();
  const replies = query();
  calls[0].reject(new Error("503"));
  await tick();
  assert.deepEqual(replies, [{ error: "unavailable" }]);
});

test("after settling, the next query loads again", async () => {
  const { actor, calls, query } = start();
  query();
  calls[0].resolve({ pages: [] });
  await tick();
  assert.equal(actor.getSnapshot().value, "idle");
  const replies = query();
  assert.equal(calls.length, 2);
  calls[1].resolve({ pages: [{ path: "/workshop/design/components" }] });
  await tick();
  assert.deepEqual(replies, [{ pages: [{ path: "/workshop/design/components" }] }]);
});
