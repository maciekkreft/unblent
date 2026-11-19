import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shownOf, isFolded, besideOf, stopKey, moveKey, firstPosition } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

const A = { id: "0000000000PRMPTSET00000001", name: "Small truths", occasion: "Relationship", basedOn: "The Seven Principles", prompts: ["One?", "Two?", "Three?"], position: "2", version: 1, pending: false };
const B = { id: "0000000000PRMPTSET00000002", name: "Evening review", occasion: "Evening", basedOn: "", prompts: ["Well?"], position: "4", version: 1, pending: false };
const NEW = "01K7TEST00000000000000NEW1";

// The tab with its two facts faked.
async function start({ sets = [A, B], folds } = {}) {
  const asked = [];
  const answers = { "prompt-sets list": { sets }, "settings read": { vimKeys: true } };
  const actor = createActor(machine, {
    input: { ask: async (t, n) => (asked.push(`${t}: ${n}`), structuredClone(answers[`${t} ${n}`])), mint: () => NEW, folds },
  });
  const emitted = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted, asked, ctx: () => actor.getSnapshot().context };
}

const saves = (emitted) => emitted.filter((e) => e.type === "prompt-set.saved").map(({ type, ...set }) => set);

test("it asks its two facts and lists the sets in order, folded until opened, with occasion and book beside", async () => {
  const { actor, asked, ctx } = await start({ sets: [B, A] });
  assert.deepEqual(asked.sort(), ["prompt-sets: list", "settings: read"]);
  assert.equal(ctx().vimKeys, true);
  assert.deepEqual(shownOf(ctx()).map((s) => [s.name, s.folded, besideOf(s)]), [
    ["Small truths", true, "Relationship · The Seven Principles"],
    ["Evening review", true, "Evening"],
  ]);
  actor.send({ type: "_fold", id: A.id });
  assert.equal(isFolded(ctx(), A.id), false);
  assert.deepEqual(ctx().folds, { [A.id]: false });
});

test("typing is saved as the whole set only when its box is left, one save per stretch", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_edit", id: A.id, field: "name", value: "S" });
  actor.send({ type: "_edit", id: A.id, field: "name", value: "Small things" });
  assert.deepEqual(saves(emitted), [], "nothing leaves while typing");
  actor.send({ type: "_blur" });
  actor.send({ type: "_blur" });
  assert.deepEqual(saves(emitted), [{ id: A.id, name: "Small things", occasion: "Relationship", basedOn: "The Seven Principles", prompts: ["One?", "Two?", "Three?"], position: "2" }]);
  actor.send({ type: "_editPrompt", id: A.id, index: 1, value: "Two!" });
  actor.send({ type: "_blur" });
  assert.deepEqual(saves(emitted)[1].prompts, ["One?", "Two!", "Three?"]);
  actor.send({ type: "_edit", id: A.id, field: "occasion", value: "Relationship" });
  actor.send({ type: "_blur" });
  assert.equal(saves(emitted).length, 2, "leaving a box unchanged saves nothing");
});

test("typing on screen is kept over a change from the fact until the box is left", async () => {
  const { actor, ctx } = await start();
  actor.send({ type: "_edit", id: A.id, field: "name", value: "Typed" });
  actor.send({ type: "prompt-set.changed", set: { ...A, name: "From elsewhere", version: 2 } });
  assert.equal(shownOf(ctx())[0].name, "Typed");
  actor.send({ type: "prompt-set.deleted", id: A.id });
  assert.deepEqual(shownOf(ctx()).map((s) => s.id), [B.id], "a set deleted elsewhere goes with what was typed in it");
});

test("New prompt adds an empty prompt kept only once written in; an emptied prompt is not kept", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "_addPrompt", id: B.id });
  assert.deepEqual(shownOf(ctx())[1].prompts, ["Well?", ""]);
  actor.send({ type: "_blur" });
  assert.deepEqual(saves(emitted), [], "an empty prompt left is no change");
  assert.deepEqual(shownOf(ctx())[1].prompts, ["Well?"]);
  actor.send({ type: "_addPrompt", id: B.id });
  actor.send({ type: "_editPrompt", id: B.id, index: 1, value: "Badly?" });
  actor.send({ type: "_blur" });
  assert.deepEqual(saves(emitted).map((s) => s.prompts), [["Well?", "Badly?"]]);
  actor.send({ type: "_editPrompt", id: B.id, index: 0, value: "  " });
  actor.send({ type: "_blur" });
  assert.deepEqual(saves(emitted).map((s) => s.prompts)[1], ["Badly?"]);
});

test("removing and moving a prompt are saved at once, after what was typed, each its own save", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_editPrompt", id: A.id, index: 0, value: "First?" });
  actor.send({ type: "_movePrompt", id: A.id, index: 0, by: 1 });
  assert.deepEqual(saves(emitted).map((s) => s.prompts), [
    ["First?", "Two?", "Three?"],
    ["Two?", "First?", "Three?"],
  ]);
  actor.send({ type: "_movePrompt", id: A.id, index: 1, by: -1 });
  assert.deepEqual(saves(emitted)[2].prompts, ["First?", "Two?", "Three?"], "the opposite move puts it back");
  actor.send({ type: "_movePrompt", id: A.id, index: 0, by: -1 });
  assert.equal(saves(emitted).length, 3, "the first prompt does not move up");
  actor.send({ type: "_removePrompt", id: A.id, index: 2 });
  assert.deepEqual(saves(emitted)[3].prompts, ["First?", "Two?"]);
});

test("New set adds an empty set at the top, open, kept once something is written in it", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "_new" });
  const [fresh] = shownOf(ctx());
  assert.equal(fresh.id, NEW);
  assert.equal(fresh.folded, false);
  assert.ok(fresh.position < A.position, "its key sorts before every other");
  assert.equal(ctx().news, 1);
  actor.send({ type: "_blur" });
  assert.equal(shownOf(ctx())[0].id, NEW, "an empty New set stays while its boxes are left");
  actor.send({ type: "_new" });
  assert.equal(shownOf(ctx()).length, 3, "pressed again while empty, it stays the one");
  assert.equal(ctx().news, 2);
  actor.send({ type: "_edit", id: NEW, field: "name", value: "Mine" });
  actor.send({ type: "_blur" });
  assert.deepEqual(saves(emitted), [{ id: NEW, name: "Mine", occasion: "", basedOn: "", prompts: [], position: fresh.position }]);
  assert.deepEqual(shownOf(ctx()).map((s) => s.id), [NEW, A.id, B.id]);
});

test("Delete set saves what was typed, then deletes the set; a New set not kept is only dropped", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "_edit", id: B.id, field: "name", value: "Night review" });
  actor.send({ type: "_delete", id: B.id });
  assert.deepEqual(saves(emitted).map((s) => [s.name, s.deleted ?? false]), [
    ["Night review", false],
    ["Night review", true],
  ]);
  assert.deepEqual(shownOf(ctx()).map((s) => s.id), [A.id]);
  actor.send({ type: "_new" });
  actor.send({ type: "_delete", id: NEW });
  assert.equal(saves(emitted).length, 2);
  assert.deepEqual(shownOf(ctx()).map((s) => s.id), [A.id]);
});

test("the keys: arrows always move, j k gg G only with Vim keys and never in a box, Alt+arrows move a prompt", () => {
  const key = (k, extra = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra });
  assert.equal(stopKey(key("ArrowDown"), { typing: true, vim: false }), "down");
  assert.equal(stopKey(key("ArrowUp"), { typing: false, vim: false }), "up");
  assert.equal(stopKey(key("j"), { typing: false, vim: false }), null);
  assert.equal(stopKey(key("j"), { typing: true, vim: true }), null);
  assert.equal(stopKey(key("k"), { typing: false, vim: true }), "up");
  assert.equal(stopKey(key("g"), { typing: false, vim: true }), "g");
  assert.equal(stopKey(key("g"), { typing: false, vim: true, afterG: true }), "first");
  assert.equal(stopKey(key("G"), { typing: false, vim: true }), "last");
  assert.equal(stopKey(key("ArrowDown", { altKey: true }), { typing: true, vim: false }), null);
  assert.equal(moveKey(key("ArrowUp", { altKey: true })), -1);
  assert.equal(moveKey(key("ArrowDown", { altKey: true })), 1);
  assert.equal(moveKey(key("ArrowDown")), null);
});

test("a first set's key sorts before the first, with room left before it", () => {
  assert.ok(firstPosition([{ position: "2" }]) < "2");
  const one = firstPosition([{ position: "1" }]);
  assert.ok(one < "1" && one > "");
  assert.ok(firstPosition([{ position: one }]) < one);
  assert.equal(typeof firstPosition([]), "string");
});
