import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with fake loaders whose
// promises the test settles, and fake queries shaped as the bus delivers them (4.2).
// Each query has its own loader, so the two regions are exercised independently.
function start() {
  const listCalls = [];
  const contractsCalls = [];
  const loader = (calls) => () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  const actor = createActor(machine, {
    input: { list: loader(listCalls), contracts: loader(contractsCalls) },
  });
  actor.start();
  const send = (type) => {
    const replies = [];
    actor.send({ type, cid: "c", payload: {}, reply: (v) => replies.push(v) });
    return replies;
  };
  return { actor, listCalls, contractsCalls, list: () => send("list?"), contracts: () => send("contracts?") };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a list query is answered with the loaded components", async () => {
  const { listCalls, list } = start();
  const replies = list();
  assert.equal(listCalls.length, 1);
  listCalls[0].resolve({ components: [{ name: "x" }] });
  await tick();
  assert.deepEqual(replies, [{ components: [{ name: "x" }] }]);
});

test("a contracts query is answered with the loaded vocabulary", async () => {
  const { contractsCalls, contracts } = start();
  const replies = contracts();
  assert.equal(contractsCalls.length, 1);
  const output = { events: [{ name: "e" }], queries: [{ name: "q" }], commands: [] };
  contractsCalls[0].resolve(output);
  await tick();
  assert.deepEqual(replies, [output]);
});

test("contracts queries during one load share it and are all answered", async () => {
  const { contractsCalls, contracts } = start();
  const first = contracts();
  const second = contracts();
  assert.equal(contractsCalls.length, 1);
  const output = { events: [], queries: [], commands: [] };
  contractsCalls[0].resolve(output);
  await tick();
  assert.deepEqual(first, [output]);
  assert.deepEqual(second, [output]);
});

test("a failed contracts load replies unavailable", async () => {
  const { contractsCalls, contracts } = start();
  const replies = contracts();
  contractsCalls[0].reject(new Error("503"));
  await tick();
  assert.deepEqual(replies, [{ error: "unavailable" }]);
});

test("list and contracts do not wait on each other", async () => {
  const { listCalls, contractsCalls, list, contracts } = start();
  const listReplies = list();
  const contractsReplies = contracts();
  assert.equal(listCalls.length, 1);
  assert.equal(contractsCalls.length, 1);
  // Contracts settles first; list is still in flight and unaffected.
  contractsCalls[0].resolve({ events: [], queries: [], commands: [] });
  await tick();
  assert.deepEqual(contractsReplies, [{ events: [], queries: [], commands: [] }]);
  assert.deepEqual(listReplies, []);
  listCalls[0].resolve({ components: [] });
  await tick();
  assert.deepEqual(listReplies, [{ components: [] }]);
});
