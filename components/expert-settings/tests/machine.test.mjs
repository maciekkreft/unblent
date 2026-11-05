import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shownOf, isFolded, stopKey, boxEdge, signedIn } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const JOURNAL = { id: "00000000000000000000000JRN", title: "Journal", author: "", written: true };
const MED = { id: "01K00000000000000000000MED", title: "Meditations", author: "Marcus Aurelius", shelfPlace: "a" };
const NBP = { id: "01K00000000000000000000NBP", title: "No Bad Parts", author: "Richard C. Schwartz", shelfPlace: "b" };

// The tab with its four facts faked.
async function start({ experts = [{ id: MED.id, prompt: "Talk like a Stoic.", on: true, version: 2 }], folds, session = { userId: "u1" } } = {}) {
  const asked = [];
  const answers = {
    "experts list": { experts },
    "books list": { books: [JOURNAL, MED, NBP] },
    "settings read": { vimKeys: true },
    "session read": session,
  };
  const actor = createActor(machine, {
    input: { ask: async (t, n) => (asked.push(`${t}: ${n}`), structuredClone(answers[`${t} ${n}`])), throttleMs: 20, folds },
  });
  const emitted = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted, asked };
}

test("it asks its four facts and lists every book read in shelf order, the Journal left out", async () => {
  const { actor, asked } = await start();
  assert.deepEqual(asked.sort(), ["books: list", "experts: list", "session: read", "settings: read"]);
  const shown = shownOf(actor.getSnapshot().context);
  assert.deepEqual(
    shown.map((b) => [b.title, b.author, b.prompt, b.on, b.folded]),
    [
      ["Meditations", "Marcus Aurelius", "Talk like a Stoic.", true, false],
      ["No Bad Parts", "Richard C. Schwartz", "", false, true],
    ],
  );
});

test("a book without a prompt starts folded, and a fold chosen by the user is kept over that", async () => {
  const { actor } = await start({ folds: { [MED.id]: true, [NBP.id]: false } });
  const { context } = actor.getSnapshot();
  assert.equal(isFolded(context, MED.id), true);
  assert.equal(isFolded(context, NBP.id), false);
  actor.send({ type: "_fold", id: MED.id });
  assert.equal(isFolded(actor.getSnapshot().context, MED.id), false);
  assert.deepEqual(actor.getSnapshot().context.folds, { [MED.id]: false, [NBP.id]: false });
});

test("typing is saved at the throttle as one edit, and leaving the box ends the stretch", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_type", id: NBP.id, value: "W" });
  actor.send({ type: "_type", id: NBP.id, value: "Warm" });
  assert.deepEqual(emitted, [], "nothing leaves before the throttle");
  await wait(40);
  assert.deepEqual(emitted, [{ type: "expert.edited", id: NBP.id, prompt: "Warm" }]);
  // Typing settles the fold as open, so emptying the box never folds it away.
  assert.equal(actor.getSnapshot().context.folds[NBP.id], false);
  actor.send({ type: "_type", id: NBP.id, value: "Warm and kind" });
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted.slice(1), [{ type: "expert.edited", id: NBP.id, prompt: "Warm and kind", left: true }]);
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 2, "a second leave says nothing");
});

test("On is refused while the prompt is empty, saved at once after what was typed, and an emptied prompt switches off", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_switch", id: NBP.id, on: true });
  assert.deepEqual(emitted, [], "no prompt, no On");
  actor.send({ type: "_type", id: NBP.id, value: "Be curious." });
  actor.send({ type: "_switch", id: NBP.id, on: true });
  assert.deepEqual(emitted, [
    { type: "expert.edited", id: NBP.id, prompt: "Be curious." },
    { type: "expert.edited", id: NBP.id, on: true },
  ]);
  emitted.length = 0;
  actor.send({ type: "_type", id: MED.id, value: "  " });
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted, [{ type: "expert.edited", id: MED.id, prompt: "  ", on: false, left: true }]);
});

test("a change from the fact is shown unless the box holds typing not yet saved", async () => {
  const { actor } = await start();
  actor.send({ type: "expert.changed", expert: { id: NBP.id, prompt: "From Undo", on: false, version: 3 } });
  assert.equal(shownOf(actor.getSnapshot().context)[1].prompt, "From Undo");
  actor.send({ type: "_type", id: MED.id, value: "Mine" });
  actor.send({ type: "expert.changed", expert: { id: MED.id, prompt: "Other", on: true, version: 4 } });
  assert.equal(shownOf(actor.getSnapshot().context)[0].prompt, "Mine");
});

test("books follow book.changed and book.deleted, the Journal never listed", async () => {
  const { actor } = await start();
  actor.send({ type: "book.changed", ...NBP, title: "No Bad Parts (2nd)", shelfPlace: "0" });
  actor.send({ type: "book.changed", ...JOURNAL });
  assert.deepEqual(shownOf(actor.getSnapshot().context).map((b) => b.title), ["No Bad Parts (2nd)", "Meditations"]);
  actor.send({ type: "book.deleted", id: MED.id });
  assert.deepEqual(shownOf(actor.getSnapshot().context).map((b) => b.id), [NBP.id]);
});

test("signed out the tab says so; a reply without a userId counts as signed in", async () => {
  const { actor } = await start({ session: { userId: null } });
  assert.equal(actor.getSnapshot().context.signedIn, false);
  assert.equal(signedIn({ error: "no-answerer" }), true);
  actor.send({ type: "session.changed", userId: "u2" });
  assert.equal(actor.getSnapshot().context.signedIn, true);
});

test("the keyboard path: arrows always, j, k, gg and G with Vim keys; a box is left only from its edge in normal mode", () => {
  const key = (k) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false });
  assert.equal(stopKey(key("ArrowDown"), { vim: false }), "down");
  assert.equal(stopKey(key("j"), { vim: false }), null);
  assert.equal(stopKey(key("j"), { vim: true }), "down");
  assert.equal(stopKey(key("g"), { vim: true }), "g");
  assert.equal(stopKey(key("g"), { vim: true, afterG: true }), "first");
  assert.equal(stopKey(key("G"), { vim: true }), "last");
  const normal = { insertMode: false, visualMode: false, inputState: {} };
  assert.equal(boxEdge(key("j"), normal, 2, 2, true), "down");
  assert.equal(boxEdge(key("j"), normal, 1, 2, true), null);
  assert.equal(boxEdge(key("k"), { ...normal, insertMode: true }, 1, 2, true), null);
  assert.equal(boxEdge(key("ArrowUp"), null, 1, 2, false), "up");
});
