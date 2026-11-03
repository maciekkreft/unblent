import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, FEATURES } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

const ALL = { released: [...FEATURES], shown: [...FEATURES] };
const picture = (off, hidden = off, more = {}) => ({ off, hidden, released: FEATURES.filter((f) => !off.includes(f)), shown: [...FEATURES], ...more });

// The fact with its server and its device storage faked (9).
function start({ cached = null, load = async () => picture([]), save = async () => picture([]) } = {}) {
  const kept = [];
  const emitted = [];
  const loads = [];
  const actor = createActor(machine, {
    input: { cached, load: () => (loads.push(1), load()), save, remember: (p) => kept.push(p) },
  });
  actor.on("flags.changed", ({ type, ...rest }) => emitted.push(rest));
  actor.start();
  const read = () => new Promise((resolve) => actor.send({ type: "read?", cid: "c", payload: {}, reply: resolve }));
  return { actor, kept, emitted, loads, read };
}

test("with no answer yet every feature is hidden; the server's answer replaces it and is kept", async () => {
  let answer;
  const { emitted, kept, read } = start({ load: () => new Promise((r) => (answer = r)) });
  assert.deepEqual(await read(), { off: FEATURES, hidden: FEATURES, released: [], shown: FEATURES });
  answer(picture([], ["choice-points"], { shown: [] }));
  await flush();
  const expected = { off: [], hidden: ["choice-points"], released: [...FEATURES], shown: [] };
  assert.deepEqual(emitted, [expected]);
  assert.deepEqual(kept, [expected]);
  assert.deepEqual(await read(), expected);
});

test("a reload or an offline start hides what the device kept, a picture from before Release and Show included", async () => {
  const { emitted, read } = start({ cached: { off: ["choice-points"], hidden: ["choice-points"] }, load: async () => Promise.reject(new Error("offline")) });
  await flush();
  assert.deepEqual(await read(), { off: ["choice-points"], hidden: ["choice-points"], released: ["slip-box"], shown: FEATURES });
  assert.deepEqual(emitted, [], "nothing changed, nothing is announced");
});

test("a picture kept before Slip-Box existed hides it until the server answers", async () => {
  const cached = { off: [], hidden: [], released: ["choice-points"], shown: ["choice-points"] };
  const { read } = start({ cached, load: async () => Promise.reject(new Error("offline")) });
  await flush();
  assert.deepEqual(await read(), { off: ["slip-box"], hidden: ["slip-box"], released: ["choice-points"], shown: ["choice-points"] });
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

test("a switch is saved with its column and announced; a refused one announces the picture unchanged", async () => {
  const saved = [];
  let refuse = false;
  const { actor, emitted } = start({
    save: async (feature, on, column) => {
      saved.push([feature, on, column]);
      if (refuse) throw new Error("offline");
      return column === "show" ? picture([], on ? [] : [feature], { shown: on ? FEATURES : FEATURES.filter((f) => f !== feature) }) : picture(on ? [] : [feature], []);
    },
  });
  await flush();
  emitted.length = 0;
  actor.send({ type: "flag.switched", feature: "choice-points", on: false });
  await flush();
  assert.deepEqual(saved, [["choice-points", false, "release"]], "a switch without a column is a Release");
  assert.deepEqual(emitted, [{ off: ["choice-points"], hidden: [], released: ["slip-box"], shown: FEATURES }]);
  actor.send({ type: "flag.switched", feature: "choice-points", on: false, column: "show" });
  await flush();
  assert.deepEqual(saved.at(-1), ["choice-points", false, "show"]);
  assert.deepEqual(emitted.at(-1), { off: [], hidden: ["choice-points"], ...ALL, shown: ["slip-box"] });
  refuse = true;
  actor.send({ type: "flag.switched", feature: "choice-points", on: true, column: "show" });
  await flush();
  assert.deepEqual(emitted.at(-1), emitted.at(-2), "the same picture again");
  actor.send({ type: "flag.switched", feature: "chats", on: false });
  actor.send({ type: "flag.switched", feature: "undo", on: false });
  await flush();
  assert.equal(saved.length, 3, "a feature without a flag, Undo included, is not sent");
});

test("an answer that arrives after a newer one is dropped", async () => {
  const pending = [];
  const { actor, read } = start({ save: (feature, on) => new Promise((r) => pending.push(() => r(picture(on ? [] : [feature])))) });
  await flush();
  actor.send({ type: "flag.switched", feature: "choice-points", on: false });
  actor.send({ type: "flag.switched", feature: "choice-points", on: true });
  await flush();
  pending[1]();
  await flush();
  pending[0]();
  await flush();
  assert.deepEqual(await read(), picture([]));
});
