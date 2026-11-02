import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// conversations as an owner of steps (12, Undo): what it records for a delete, a rename, a
// move, a relink, the comments and highlights on the answers and a tool switch, and how it
// applies an Undo or Redo `undo` names to it.

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const A = U("A1");
const B = U("B1");
const Q = U("Q1");
const ANSWER = U("R1");
const OLD = U("R0");
const M1 = U("M1");
const M2 = U("M2");
const H1 = U("H1");

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const changedSchema = schema("../events/conversation.changed.json");

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const turns = [
  { id: OLD, role: "assistant", text: "An earlier answer.", status: "done" },
  { id: Q, role: "user", text: "And then?" },
  { id: ANSWER, role: "assistant", text: "The last answer, with words.", status: "done" },
];
const chatA = { id: A, title: "About books", about: [{ kind: "book", id: "b1" }], start: "s", turns, updatedAt: 5, position: "a" };
const chatB = { id: B, title: "Second", about: [{ kind: "book", id: "b1" }], start: "s", turns: [], updatedAt: 4, position: "b" };
const heading = ({ turns: _, start: __, ...h }) => h;

async function start({ lists, kept = { value: null } } = {}) {
  let minted = 0;
  const mint = () => U(`S${String.fromCharCode(65 + minted++)}`);
  const calls = { deleted: [], restored: [], saved: [], savedTools: [] };
  const queue = lists ? [...lists] : null;
  const input = {
    session: () => Promise.resolve({ userId: "u1" }),
    subject: () => Promise.resolve({ subject: null }),
    settings: () => Promise.resolve({}),
    contracts: () => Promise.resolve({ queries: [] }),
    complete: (request) => Promise.resolve({ id: request.id }),
    list: () => Promise.resolve(queue ? (queue.length > 1 ? queue.shift() : queue[0]) : { conversations: [heading(chatA), heading(chatB)], tools: { tools: {}, approval: "auto" } }),
    read: (id) => Promise.resolve(structuredClone(id === A ? chatA : chatB)),
    saveChat: (id, body) => (calls.saved.push({ id, body }), Promise.resolve({ updatedAt: 5 })),
    deleteChat: (id) => (calls.deleted.push(id), Promise.resolve()),
    restoreChat: (id) => (calls.restored.push(id), Promise.resolve({ updatedAt: 5 })),
    saveTools: (body) => (calls.savedTools.push(body), Promise.resolve()),
    store: { read: () => A, write: () => {}, readSteps: () => kept.value, writeSteps: (v) => (kept.value = structuredClone(v)) },
    ulid: () => U("ZZ"),
    mint,
    now: () => 1000,
  };
  const actor = createActor(machine, { input });
  const steps = [];
  const settled = [];
  const changed = [];
  const deleted = [];
  const tools = [];
  actor.on("step.recorded", ({ type, ...p }) => {
    assert.ok(recordedSchema.validate(p).valid, JSON.stringify(p));
    steps.push(p);
  });
  actor.on("step.settled", ({ type, ...p }) => {
    assert.ok(settledSchema.validate(p).valid, JSON.stringify(p));
    settled.push(p);
  });
  actor.on("conversation.changed", ({ type, ...p }) => {
    assert.ok(changedSchema.validate(p).valid, JSON.stringify(p));
    changed.push(p);
  });
  actor.on("conversation.deleted", (e) => deleted.push(e.id));
  actor.on("tools.changed", (e) => tools.push(e));
  actor.start();
  await flush();
  // The open chat is read, as the panel does when it shows it.
  actor.send({ type: "conversation.selected", id: A });
  await flush();
  return { actor, steps, settled, changed, deleted, tools, calls };
}

const list = (actor) => new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }));
const read = (actor, id) => new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: { id }, reply }));
const undo = (step) => ({ type: "step.undone", id: step.id, owner: "conversations", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "conversations", payload: step.redo });
const titles = async (actor) => (await list(actor)).conversations.map((c) => c.title);

test("a delete is one step with the notice, and Undo brings the chat back with a restore write", async () => {
  const { actor, steps, settled, deleted, changed, calls } = await start();
  actor.send({ type: "conversation.discarded", id: A });
  await flush();
  assert.deepEqual(deleted, [A]);
  assert.deepEqual(calls.deleted, [A]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "delete chat About books");
  assert.equal(steps[0].notice, true);
  assert.deepEqual(steps[0].undo, { kind: "chat", id: A, deleted: false });

  actor.send(undo(steps[0]));
  await flush();
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "conversations", outcome: "applied" });
  assert.deepEqual(calls.restored, [A]);
  assert.deepEqual(await titles(actor), ["About books", "Second"], "back in its place");
  assert.equal(changed.at(-1).id, A, "the list learns of it from the whole chat");
  assert.equal((await read(actor, A)).conversation.turns.length, 3);

  actor.send(redo(steps[0]));
  await flush();
  assert.equal(settled.at(-1).outcome, "applied");
  assert.deepEqual(await titles(actor), ["Second"]);
  assert.deepEqual(calls.deleted, [A, A]);
});

test("a chat only listed comes back read from the server after its restore", async () => {
  const { actor, steps, changed } = await start();
  actor.send({ type: "conversation.discarded", id: B });
  await flush();
  const before = changed.length;
  actor.send(undo(steps[0]));
  await flush();
  assert.deepEqual(await titles(actor), ["About books", "Second"]);
  assert.equal(changed.slice(before).at(-1).id, B);
});

test("a rename is one step, Undo gives the old title back and Redo the new one", async () => {
  const { actor, steps, settled } = await start();
  actor.send({ type: "conversation.renamed", id: A, title: "Reading notes" });
  await flush();
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "rename chat About books");
  assert.deepEqual(steps[0].undo, { kind: "title", id: A, title: "About books" });
  assert.deepEqual(steps[0].redo, { kind: "title", id: A, title: "Reading notes" });
  actor.send(undo(steps[0]));
  await flush();
  assert.equal(settled.at(-1).outcome, "applied");
  assert.equal((await read(actor, A)).conversation.title, "About books");
  actor.send(redo(steps[0]));
  await flush();
  assert.equal((await read(actor, A)).conversation.title, "Reading notes");
});

test("several renames undo in a row, and a generated title written since refuses the Undo", async () => {
  const { actor, steps, settled } = await start();
  actor.send({ type: "conversation.renamed", id: A, title: "One" });
  actor.send({ type: "conversation.renamed", id: A, title: "Two" });
  await flush();
  assert.equal(steps[1].undo.prior, steps[0].id);
  actor.send(undo(steps[1]));
  actor.send(undo(steps[0]));
  await flush();
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.equal((await read(actor, A)).conversation.title, "About books");

  actor.send(redo(steps[0]));
  await flush();
  actor.send({ type: "generation.changed", result: { generator: "chat-title", item: A, text: "Made by the model" } });
  await flush();
  actor.send(undo(steps[0]));
  await flush();
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "conversations", outcome: "refused", reason: "changed" });
  assert.equal((await read(actor, A)).conversation.title, "Made by the model");
});

test("the generator's copy of a title the user typed, before the chat is read, keeps the Undo", async () => {
  const { actor, steps, settled } = await start();
  actor.send({ type: "conversation.renamed", id: B, title: "Typed" });
  actor.send({ type: "generation.changed", result: { generator: "chat-title", item: B, text: "Typed" } });
  await flush();
  actor.send(undo(steps[0]));
  await flush();
  assert.equal(settled.at(-1).outcome, "applied");
  assert.equal((await read(actor, B)).conversation.title, "Second");
});

test("a move is one step whose Undo puts the chat back where it was", async () => {
  const { actor, steps, settled } = await start();
  actor.send({ type: "conversation.moved", id: A, after: B, before: null });
  await flush();
  assert.deepEqual(await titles(actor), ["Second", "About books"]);
  assert.equal(steps[0].label, "move chat About books");
  assert.deepEqual(steps[0].undo, { kind: "place", id: A, position: "a" });
  actor.send(undo(steps[0]));
  await flush();
  assert.equal(settled.at(-1).outcome, "applied");
  assert.deepEqual(await titles(actor), ["About books", "Second"]);
  actor.send(redo(steps[0]));
  await flush();
  assert.deepEqual(await titles(actor), ["Second", "About books"]);
});

test("a move another device made since refuses the Undo", async () => {
  const moved = { conversations: [heading(chatA), { ...heading(chatB), position: "0V" }], tools: { tools: {}, approval: "auto" } };
  const { actor, steps, settled } = await start({ lists: [{ conversations: [heading(chatA), heading(chatB)], tools: { tools: {}, approval: "auto" } }] });
  actor.send({ type: "conversation.moved", id: B, after: null, before: A });
  await flush();
  // The server took the move; then another device moved it again.
  actor.send({ type: "_saved", chatId: B, turnIds: [], sendPosition: true, position: steps[0].redo.position });
  actor.send({ type: "_listed", result: moved });
  await flush();
  actor.send(undo(steps[0]));
  await flush();
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "conversations", outcome: "refused", reason: "changed" });
});

test("linking to a chapter is one step whose Undo gives back the links", async () => {
  const { actor, steps, settled } = await start();
  const linked = [{ kind: "book", id: "b1", chapter: "one", chapterTitle: "One" }];
  actor.send({ type: "conversation.relinked", id: A, about: linked });
  await flush();
  assert.equal(steps[0].label, "link chat About books");
  actor.send(undo(steps[0]));
  await flush();
  assert.equal(settled.at(-1).outcome, "applied");
  assert.deepEqual((await read(actor, A)).conversation.about, chatA.about);
  actor.send(redo(steps[0]));
  await flush();
  assert.deepEqual((await read(actor, A)).conversation.about, linked);
});

const mark = (id, comment) => ({ id, start: 4, end: 8, quote: "last", comment });

test("typing in one comment is one step, and a second comment is another", async () => {
  const { actor, steps, settled } = await start();
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "W")] });
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why")] });
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why so?")] });
  await flush();
  assert.equal(new Set(steps.map((s) => s.id)).size, 1);
  assert.equal(steps.at(-1).label, "comment on an answer");
  assert.deepEqual(steps.at(-1).undo, { kind: "answers", id: A, marks: null, highlights: null });
  assert.deepEqual(steps.at(-1).redo.marks, { answerId: ANSWER, marks: [mark(M1, "Why so?")] });

  const second = { ...mark(M2, "And?"), start: 14, end: 19, quote: "words" };
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why so?"), second] });
  await flush();
  const [one, two] = [steps[0], steps.at(-1)];
  assert.notEqual(two.id, one.id);
  assert.equal(two.undo.prior, one.id);

  actor.send(undo(two));
  actor.send(undo(one));
  await flush();
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.equal((await read(actor, A)).conversation.marks, undefined, "no comments left");
  actor.send(redo(one));
  actor.send(redo(two));
  await flush();
  assert.deepEqual((await read(actor, A)).conversation.marks.marks, [mark(M1, "Why so?"), second]);
});

test("leaving a comment box ends its stretch: typing in it again after coming back is another step", async () => {
  const { actor, steps, settled } = await start();
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why")] });
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why")], left: true });
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why so")] });
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why so?")], left: true });
  await flush();
  const ids = [...new Set(steps.map((s) => s.id))];
  assert.equal(ids.length, 2);
  const [one, two] = ids.map((id) => steps.findLast((s) => s.id === id));
  assert.deepEqual(two.undo.marks.marks, [mark(M1, "Why")]);
  actor.send(undo(two));
  await flush();
  assert.deepEqual((await read(actor, A)).conversation.marks.marks, [mark(M1, "Why")], "one Undo takes back the second visit");
  actor.send(undo(one));
  await flush();
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.equal((await read(actor, A)).conversation.marks, undefined);
});

test("a comment box left empty becomes its highlight in the same step", async () => {
  const { actor, steps } = await start();
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Hm")] });
  await flush();
  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [] });
  actor.send({ type: "highlights.edited", conversationId: A, highlights: [{ id: M1, answerId: ANSWER, start: 4, end: 8, quote: "last" }] });
  await flush();
  assert.equal(new Set(steps.map((s) => s.id)).size, 2, "the comment, then its removal with the highlight");
  assert.equal(steps.at(-1).redo.highlights.length, 1);
  assert.equal(steps.at(-1).redo.marks, null);
  assert.deepEqual(steps.at(-1).undo.marks.marks, [mark(M1, "Hm")]);
});

test("a highlight on an earlier answer is one step, and a sent message refuses undoing a comment", async () => {
  const { actor, steps, settled } = await start();
  const hl = { id: H1, answerId: OLD, start: 0, end: 2, quote: "An" };
  actor.send({ type: "highlights.edited", conversationId: A, highlights: [hl] });
  await flush();
  assert.equal(steps[0].label, "highlight a passage");
  actor.send(undo(steps[0]));
  await flush();
  assert.equal((await read(actor, A)).conversation.highlights, undefined);
  actor.send(redo(steps[0]));
  await flush();
  assert.deepEqual((await read(actor, A)).conversation.highlights, [hl]);

  actor.send({ type: "marks.edited", conversationId: A, answerId: ANSWER, marks: [mark(M1, "Why?")] });
  await flush();
  actor.send({ type: "turn.submitted", conversationId: A, turn: { id: U("Q2"), text: "Next" } });
  await flush();
  actor.send(undo(steps.at(-1)));
  await flush();
  assert.deepEqual(settled.at(-1), { id: steps.at(-1).id, owner: "conversations", outcome: "refused", reason: "changed" });
});

test("a tool switch is one step; Undo switches it back, and another device's change refuses it", async () => {
  const { actor, steps, settled, tools } = await start();
  actor.send({ type: "tools.edited", tools: { "notes: list": false, "notes: read": false } });
  await flush();
  assert.equal(steps[0].label, "switch off what the chat may read");
  assert.deepEqual(steps[0].undo, { kind: "tools", tools: { "notes: list": true, "notes: read": true } });
  actor.send(undo(steps[0]));
  await flush();
  assert.equal(settled.at(-1).outcome, "applied");
  assert.deepEqual(tools.at(-1).tools, { "notes: list": true, "notes: read": true });
  actor.send(redo(steps[0]));
  await flush();
  assert.deepEqual(tools.at(-1).tools, { "notes: list": false, "notes: read": false });

  actor.send({ type: "_listed", result: { conversations: [heading(chatA), heading(chatB)], tools: { tools: { "values: read": false }, approval: "auto" } } });
  await flush();
  actor.send(undo(steps[0]));
  await flush();
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "conversations", outcome: "refused", reason: "changed" });
});

test("a flip that changes nothing, a rename to the same title and an unchanged move record no step", async () => {
  const { actor, steps } = await start();
  actor.send({ type: "tools.edited", tools: { "notes: list": true } });
  actor.send({ type: "conversation.renamed", id: A, title: "About books" });
  actor.send({ type: "conversation.relinked", id: A, about: chatA.about });
  await flush();
  assert.equal(steps.length, 0);
});

test("a step owned by another fact is ignored, and one for a chat this page never held is refused", async () => {
  const { actor, settled } = await start();
  actor.send({ type: "step.undone", id: U("X1"), owner: "notes", payload: { kind: "chat", id: A, deleted: false } });
  actor.send({ type: "step.undone", id: U("X2"), owner: "conversations", payload: { kind: "chat", id: U("X3"), deleted: false } });
  await flush();
  assert.deepEqual(settled, [{ id: U("X2"), owner: "conversations", outcome: "refused", reason: "changed" }]);
});

test("after a reload an Undo still applies, and a deleted chat comes back from the server", async () => {
  const kept = { value: null };
  const first = await start({ kept });
  first.actor.send({ type: "conversation.renamed", id: A, title: "Renamed" });
  first.actor.send({ type: "conversation.discarded", id: B });
  await flush();
  const [rename, remove] = first.steps;
  first.actor.stop();

  const again = await start({ kept, lists: [{ conversations: [{ ...heading(chatA), title: "Renamed" }], tools: { tools: {}, approval: "auto" } }] });
  again.actor.send(undo(remove));
  await flush();
  assert.equal(again.settled.at(-1).outcome, "applied");
  assert.deepEqual(again.calls.restored, [B]);
  assert.ok((await titles(again.actor)).includes("Second"), "read back from the server");
  again.actor.send(undo(rename));
  await flush();
  assert.equal(again.settled.at(-1).outcome, "applied");
  assert.equal((await read(again.actor, A)).conversation.title, "About books");
});
