import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, FEATURES } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

// The fact with its server and its device storage faked (9).
function start({ cached = null, load = async () => ({ off: [], hidden: [] }), save = async () => ({ off: [], hidden: [] }) } = {}) {
  const kept = [];
  const emitted = [];
  const loads = [];
  const actor = createActor(machine, {
    input: { cached, load: () => (loads.push(1), load()), save, remember: (p) => kept.push(p) },
  });
  actor.on("flags.changed", (e) => emitted.push({ off: e.off, hidden: e.hidden }));
  actor.start();
  const read = () => new Promise((resolve) => actor.send({ type: "read?", cid: "c", payload: {}, reply: resolve }));
  return { actor, kept, emitted, loads, read };
}

test("with no answer yet every feature is hidden; the server's answer replaces it and is kept", async () => {
  let answer;
  const { emitted, kept, read } = start({ load: () => new Promise((r) => (answer = r)) });
  assert.deepEqual(await read(), { off: FEATURES, hidden: FEATURES });
  answer({ off: ["chats"], hidden: ["chats"] });
  await flush();
  assert.deepEqual(emitted, [{ off: ["chats"], hidden: ["chats"] }]);
  assert.deepEqual(kept, [{ off: ["chats"], hidden: ["chats"] }]);
  assert.deepEqual(await read(), { off: ["chats"], hidden: ["chats"] });
});

test("a reload or an offline start hides what the device kept", async () => {
  const { emitted, read } = start({ cached: { off: ["evaluators"], hidden: ["evaluators"] }, load: async () => Promise.reject(new Error("offline")) });
  await flush();
  assert.deepEqual(await read(), { off: ["evaluators"], hidden: ["evaluators"] });
  assert.deepEqual(emitted, [], "nothing changed, nothing is announced");
});

test("a change of account reads again; leaving forgets what was kept", async () => {
  const { actor, loads, kept } = start();
  await flush();
  assert.equal(loads.length, 1);
  actor.send({ type: "session.changed", userId: "u2" });
  await flush();
  assert.equal(loads.length, 2);
  actor.send({ type: "session.changed", userId: "u2", leaving: true });
  await flush();
  assert.equal(loads.length, 2, "leaving reads nothing");
  assert.equal(kept.at(-1), null);
});

test("a switch is saved and announced; a refused one announces the picture unchanged", async () => {
  const saved = [];
  let refuse = false;
  const { actor, emitted } = start({
    save: async (feature, on) => {
      saved.push([feature, on]);
      if (refuse) throw new Error("offline");
      return { off: on ? [] : [feature], hidden: [] };
    },
    load: async () => ({ off: [], hidden: [] }),
  });
  await flush();
  emitted.length = 0;
  actor.send({ type: "flag.switched", feature: "chats", on: false });
  await flush();
  assert.deepEqual(saved, [["chats", false]]);
  assert.deepEqual(emitted, [{ off: ["chats"], hidden: [] }]);
  refuse = true;
  actor.send({ type: "flag.switched", feature: "chats", on: true });
  await flush();
  assert.deepEqual(emitted.at(-1), { off: ["chats"], hidden: [] });
  actor.send({ type: "flag.switched", feature: "news", on: false });
  await flush();
  assert.equal(saved.length, 2, "a feature without a flag is not sent");
});

test("an answer that arrives after a newer one is dropped", async () => {
  const pending = [];
  const { actor, read } = start({ save: (feature, on) => new Promise((r) => pending.push(() => r({ off: on ? [] : [feature], hidden: [] }))) });
  await flush();
  actor.send({ type: "flag.switched", feature: "chats", on: false });
  actor.send({ type: "flag.switched", feature: "chats", on: true });
  await flush();
  pending[1]();
  await flush();
  pending[0]();
  await flush();
  assert.deepEqual(await read(), { off: [], hidden: [] });
});
