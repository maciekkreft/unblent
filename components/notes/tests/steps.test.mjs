import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// notes as an owner of steps (12, Undo): what it records for a stretch of typing, a delete
// and a move, and how it applies an Undo or Redo `undo` names to it.

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const changedSchema = schema("../events/note.changed.json");

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function memory(initial = []) {
  const notes = new Map(initial.map((n) => [n.id, n]));
  const outbox = new Map();
  const meta = new Map();
  return {
    notes,
    outbox,
    all: async () => [...notes.values()],
    put: async (r) => void notes.set(r.id, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
    empty: async () => (notes.clear(), outbox.clear()),
  };
}

async function start({ store = memory(), userId = null, api = null } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  let t = 100;
  const ask = () => Promise.resolve({ userId });
  const actor = createActor(machine, { input: { store, mint, now: () => ++t, ask, api } });
  const steps = [];
  const settled = [];
  const changed = [];
  const deleted = [];
  actor.on("step.recorded", ({ type, ...p }) => {
    assert.ok(recordedSchema.validate(p).valid, JSON.stringify(p));
    steps.push(p);
  });
  actor.on("step.settled", ({ type, ...p }) => {
    assert.ok(settledSchema.validate(p).valid, JSON.stringify(p));
    settled.push(p);
  });
  actor.on("note.changed", ({ type, ...p }) => {
    assert.ok(changedSchema.validate(p).valid, JSON.stringify(p));
    changed.push(p);
  });
  actor.on("note.deleted", (e) => deleted.push(e.id));
  actor.start();
  await flush();
  return { actor, steps, settled, changed, deleted, store };
}

const read = (actor, id) => new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: { id }, reply }));
const list = (actor) => new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }));
const undo = (step, owner = "notes") => ({ type: "step.undone", id: step.id, owner, payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "notes", payload: step.redo });
const save = (id, body, baseVersion, extra = {}) => ({ type: "note.saved", id, title: body.split("\n")[0], body, baseVersion, ...extra });

test("a stretch of typing in one note is one step, closed when the user leaves it", async () => {
  const { actor, steps } = await start();
  actor.send(save(A, "Sh", null));
  actor.send(save(A, "Shopping", 1));
  actor.send(save(A, "Shopping", 2, { left: true }));
  assert.equal(new Set(steps.map((s) => s.id)).size, 1);
  assert.equal(steps.at(-1).label, "add note Shopping");
  assert.deepEqual(steps.at(-1).undo, { kind: "note", id: A, deleted: true });
  assert.deepEqual(steps.at(-1).redo, { kind: "note", id: A, title: "Shopping", body: "Shopping", about: [], deleted: false });

  actor.send(save(A, "Shopping list", 2));
  assert.notEqual(steps.at(-1).id, steps[0].id, "the next stretch is a new step");
  assert.equal(steps.at(-1).label, "edit note Shopping list");
  assert.deepEqual(steps.at(-1).undo, { kind: "note", id: A, title: "Shopping", body: "Shopping", about: [], deleted: false, prior: steps[0].id });
});

test("several steps on one note are undone in a row, and redone in a row", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save(A, "First", null, { left: true }));
  actor.send(save(A, "Second", 1, { left: true }));
  actor.send({ type: "note.moved", id: A, after: null, before: null });
  const ids = [...new Set(steps.map((s) => s.id))];
  const byId = (id) => steps.findLast((s) => s.id === id);
  for (const id of [...ids].reverse()) actor.send(undo(byId(id)));
  assert.deepEqual(await read(actor, A), { error: "not-found" }, "back to before the note was written");
  for (const id of ids) actor.send(redo(byId(id)));
  assert.equal((await read(actor, A)).note.body, "Second");
  assert.ok(settled.every((s) => s.outcome === "applied"), JSON.stringify(settled));
});

test("another note opened, or typed in, ends the stretch", async () => {
  const { actor, steps } = await start();
  actor.send(save(A, "One", null));
  actor.send(save(B, "Two", null));
  actor.send(save(A, "One more", 1));
  assert.equal(new Set(steps.map((s) => s.id)).size, 3);
  actor.send({ type: "note.opened", id: B });
  actor.send(save(A, "One more again", 2));
  assert.equal(new Set(steps.map((s) => s.id)).size, 4);
});

test("undo puts the text back, redo makes it again, and neither is a step", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save(A, "First", null, { left: true }));
  actor.send(save(A, "Second", 1, { left: true }));
  const edit = steps.at(-1);
  const count = steps.length;
  actor.send(undo(edit));
  assert.equal((await read(actor, A)).note.body, "First");
  assert.deepEqual(settled.at(-1), { id: edit.id, owner: "notes", outcome: "applied" });
  actor.send(redo(edit));
  assert.equal((await read(actor, A)).note.body, "Second");
  assert.deepEqual(settled.at(-1), { id: edit.id, owner: "notes", outcome: "applied" });
  assert.equal(steps.length, count, "applying records nothing");
});

test("undo of a new note deletes it, and redo brings it back", async () => {
  const { actor, steps, deleted } = await start();
  actor.send(save(A, "Fresh", null, { left: true }));
  const made = steps.at(-1);
  actor.send(undo(made));
  assert.deepEqual(deleted, [A]);
  assert.deepEqual(await read(actor, A), { error: "not-found" });
  actor.send(redo(made));
  assert.equal((await read(actor, A)).note.body, "Fresh");
});

test("a delete is one step that asks for the notice; undo restores the note where it was", async () => {
  const { actor, steps, deleted } = await start();
  actor.send(save(A, "Keep me\nbody", null, { left: true }));
  actor.send(save(B, "Other", null, { left: true }));
  const before = (await list(actor)).notes.map((n) => n.id);
  actor.send({ type: "note.discarded", id: A });
  const removal = steps.at(-1);
  assert.equal(removal.label, "delete note Keep me");
  assert.equal(removal.notice, true);
  assert.deepEqual(deleted, [A]);
  actor.send(undo(removal));
  assert.equal((await read(actor, A)).note.body, "Keep me\nbody");
  assert.deepEqual((await list(actor)).notes.map((n) => n.id), before, "back in its place");
  actor.send(redo(removal));
  assert.deepEqual(deleted, [A, A]);
});

test("a highlight's steps are named as a highlight", async () => {
  const { actor, steps } = await start();
  const place = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } };
  const about = [{ kind: "book", id: "book-1", place, quote: { exact: "Hello", prefix: "", suffix: "" } }];
  actor.send(save(A, "", null, { about, left: true }));
  assert.equal(steps.at(-1).label, "add highlight");
  actor.send({ type: "note.discarded", id: A });
  assert.equal(steps.at(-1).label, "delete highlight");
});

test("a move is one step; undo puts the note back in its place", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save(A, "A", null, { left: true }));
  actor.send(save(B, "B", null, { left: true }));
  assert.deepEqual((await list(actor)).notes.map((n) => n.id), [B, A]);
  actor.send({ type: "note.moved", id: B, after: A, before: null });
  const move = steps.at(-1);
  assert.equal(move.label, "move note B");
  assert.deepEqual((await list(actor)).notes.map((n) => n.id), [A, B]);
  actor.send(undo(move));
  assert.deepEqual((await list(actor)).notes.map((n) => n.id), [B, A]);
  actor.send(redo(move));
  assert.deepEqual((await list(actor)).notes.map((n) => n.id), [A, B]);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("a step whose note was written since is refused as changed", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save(A, "One", null, { left: true }));
  actor.send(save(A, "Two", 1, { left: true }));
  const first = steps.at(-1);
  actor.send(save(A, "Three", 2, { left: true }));
  actor.send(undo(first));
  assert.deepEqual(settled.at(-1), { id: first.id, owner: "notes", outcome: "refused", reason: "changed" });
  assert.equal((await read(actor, A)).note.body, "Three");
  actor.send(undo(first, "values"));
  assert.equal(settled.length, 1, "another owner's step is not this fact's to answer");
});

test("a move is refused once the note's place was written since", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save(A, "A", null, { left: true }));
  actor.send(save(B, "B", null, { left: true }));
  actor.send({ type: "note.moved", id: B, after: A, before: null });
  const first = steps.at(-1);
  actor.send({ type: "note.moved", id: B, after: null, before: A });
  actor.send(undo(first));
  assert.deepEqual(settled.at(-1), { id: first.id, owner: "notes", outcome: "refused", reason: "changed" });
});

const C = "01ARZ3NDEKTSV4RRFFQ69G5FC1";

test("a move of a deleted note restores it there as one step; Undo deletes it again, and the delete's Undo puts it back in its row", async () => {
  const { actor, steps, settled, deleted } = await start();
  actor.send(save(A, "A", null, { left: true }));
  actor.send(save(B, "B", null, { left: true }));
  actor.send(save(C, "Back\nbody", null, { left: true }));
  const ids = async () => (await list(actor)).notes.map((n) => n.id);
  assert.deepEqual(await ids(), [C, B, A]);
  actor.send({ type: "note.discarded", id: C });
  const removal = steps.at(-1);
  actor.send({ type: "note.moved", id: C, after: A, before: null });
  const restore = steps.at(-1);
  assert.equal(restore.label, "restore note Back");
  assert.notEqual(restore.id, removal.id);
  assert.equal(restore.notice, undefined);
  assert.deepEqual(await ids(), [B, A, C], "back where it was placed");
  assert.equal((await read(actor, C)).note.body, "Back\nbody");
  actor.send(undo(restore));
  assert.deepEqual(deleted, [C, C]);
  assert.deepEqual(await ids(), [B, A]);
  actor.send(undo(removal));
  assert.deepEqual(await ids(), [C, B, A], "the delete's Undo puts it back in its first row");
  actor.send(redo(removal));
  actor.send(redo(restore));
  assert.deepEqual(await ids(), [B, A, C], "Redo restores it at the place it was moved to");
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied", "applied", "applied"]);
});

test("a deleted highlight moved into the list stays deleted", async () => {
  const { actor, steps } = await start();
  actor.send(save(A, "comment", null, { about: highlight(at(0, 5), "Hello"), left: true }));
  actor.send({ type: "note.discarded", id: A });
  const count = steps.length;
  actor.send({ type: "note.moved", id: A, after: null, before: null });
  assert.equal(steps.length, count);
  assert.equal((await read(actor, A)).error, "not-found");
});

test("signed in, an Undo of a delete is a restore write naming the tombstone's version", async () => {
  const puts = [];
  const server = new Map();
  const api = {
    put: async (row) => {
      puts.push(row);
      const held = server.get(row.id);
      const version = (held?.version ?? row.baseVersion ?? 0) + 1;
      const note = { id: row.id, title: row.title, body: row.body, version, updatedAt: 900, deleted: Boolean(row.deleted), about: row.about ?? [], position: row.position ?? held?.position ?? null };
      server.set(row.id, note);
      return note;
    },
    pull: async (since) => ({ notes: [], cursor: since }),
  };
  const { actor, steps } = await start({ userId: "u1", api });
  actor.send(save(A, "Signed", null, { left: true }));
  actor.send({ type: "_sync", pull: false });
  await flush();
  actor.send({ type: "note.discarded", id: A });
  actor.send({ type: "_sync", pull: false });
  await flush();
  const tomb = server.get(A);
  assert.equal(tomb.deleted, true);
  actor.send(undo(steps.at(-1)));
  assert.equal((await read(actor, A)).note.body, "Signed", "back at once, before the server knows");
  actor.send({ type: "_sync", pull: false });
  await flush();
  const restore = puts.at(-1);
  assert.equal(restore.baseVersion, tomb.version);
  assert.equal(restore.deleted, undefined);
  assert.equal(server.get(A).deleted, false);
});

// Highlights of one book, as the reader saves them (13, Highlight).
const BOOK = "book-1";
const at = (start, end) => ({ chapter: 0, contentVersion: 1, start: { block: 0, offset: start }, end: { block: 0, offset: end } });
const highlight = (place, exact) => [{ kind: "book", id: BOOK, place, quote: { exact, prefix: "", suffix: "" } }];

test("joining overlapping highlights is one step: Undo brings both back as they were, Redo joins them again", async () => {
  const { actor, steps, settled, deleted } = await start();
  actor.send(save(A, "first", null, { about: highlight(at(0, 5), "Hello"), left: true }));
  actor.send(save(B, "second", null, { about: highlight(at(4, 11), "o world"), left: true }));
  const count = steps.length;
  // The reader's join: the earlier highlight grown over both, then the other deleted.
  actor.send(save(A, "first\n\nsecond", 1, { about: highlight(at(0, 11), "Hello world"), left: true }));
  actor.send({ type: "note.discarded", id: B });
  assert.equal(steps.length, count + 1, "one step for the whole join");
  const join = steps.at(-1);
  assert.equal(join.label, "join highlights");
  assert.equal(join.notice, undefined);
  assert.deepEqual(deleted, [B]);

  actor.send(undo(join));
  assert.deepEqual(settled.at(-1), { id: join.id, owner: "notes", outcome: "applied" });
  const a = (await read(actor, A)).note;
  const b = (await read(actor, B)).note;
  assert.equal(a.body, "first");
  assert.deepEqual(a.about[0].place, at(0, 5));
  assert.equal(b.body, "second");
  assert.deepEqual(b.about[0].place, at(4, 11));

  actor.send(redo(join));
  assert.deepEqual(settled.at(-1), { id: join.id, owner: "notes", outcome: "applied" });
  assert.equal((await read(actor, A)).note.body, "first\n\nsecond");
  assert.deepEqual(await read(actor, B), { error: "not-found" });
  assert.equal(steps.length, count + 1, "applying records nothing");
});

test("moving a highlight to its passage after a re-import records no step", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save(A, "comment", null, { about: highlight(at(0, 5), "Hello"), left: true }));
  const made = steps.at(-1);
  const count = steps.length;
  const moved = highlight({ ...at(3, 8), contentVersion: 2 }, "Hello");
  actor.send(save(A, "comment", 1, { about: moved, left: true }));
  assert.equal(steps.length, count, "the reader's upkeep is not a step");
  assert.deepEqual((await read(actor, A)).note.about, moved);
  actor.send(undo(made));
  assert.deepEqual(settled.at(-1), { id: made.id, owner: "notes", outcome: "refused", reason: "changed" }, "an older step no longer describes the highlight");
});

test("a deleted note moved into a list about another thing comes back under it, its other links kept, as one step", async () => {
  const { actor, steps, settled } = await start();
  const journal = { kind: "book", id: "journal", chapter: "2026-11-03", chapterTitle: "3 November" };
  const parent = { kind: "note", id: B };
  actor.send(save(B, "Parent", null, { left: true }));
  actor.send(save(A, "Child", null, { about: [journal], left: true }));
  actor.send({ type: "note.discarded", id: A });
  const removal = steps.at(-1);
  actor.send({ type: "note.moved", id: A, after: null, before: null, about: parent });
  const restore = steps.at(-1);
  assert.equal(restore.label, "restore note Child");
  assert.deepEqual((await read(actor, A)).note.about, [journal, parent], "a parent added beside the book");
  actor.send({ type: "note.discarded", id: A });
  const other = { kind: "note", id: C };
  actor.send({ type: "note.moved", id: A, after: null, before: null, about: other });
  assert.deepEqual((await read(actor, A)).note.about, [journal, other], "the parent replaced, the book kept");
  const second = steps.at(-1);
  actor.send(undo(second));
  actor.send(undo(steps.at(-2)));
  assert.deepEqual((await read(actor, A)).note.about, [journal, parent], "the delete's Undo brings back the links it had");
  actor.send(undo(restore));
  actor.send(undo(removal));
  assert.deepEqual((await read(actor, A)).note.about, [journal]);
  assert.ok(settled.every((s) => s.outcome === "applied"), JSON.stringify(settled));
});

test("a passage added with Add to note is one step at the end of the note's links; Undo takes it out", async () => {
  const H = "01ARZ3NDEKTSV4RRFFQ69G5H01";
  const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
  const passage = { kind: "book", id: BOOK, place: { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } }, quote: { exact: "Hello", prefix: "", suffix: "" } };
  const { actor, steps, changed } = await start();
  actor.send(save(H, "", null, { about: [passage], left: true }));
  actor.send(save(A, "Notes on it", null, { about: [{ kind: "book", id: BOOK }], left: true }));
  const before = steps.length;
  actor.send({ type: "passage.added", note: A, highlight: H });
  assert.equal(steps.length, before + 1, "one step");
  const link = { kind: "highlight", id: H };
  assert.deepEqual(changed.at(-1).about, [{ kind: "book", id: BOOK }, link], "announced at the end of its links");
  assert.equal(changed.at(-1).body, "Notes on it", "the text is kept");

  actor.send({ type: "passage.added", note: A, highlight: H });
  actor.send({ type: "passage.added", note: B, highlight: H });
  actor.send({ type: "passage.added", note: A, highlight: B });
  actor.send({ type: "passage.added", note: H, highlight: H });
  assert.equal(steps.length, before + 1, "twice, a note that does not exist, or a highlight that is not one, change nothing");

  actor.send(undo(steps.at(-1)));
  assert.deepEqual((await read(actor, A)).note.about, [{ kind: "book", id: BOOK }]);
  actor.send(redo(steps.at(-1)));
  assert.deepEqual((await read(actor, A)).note.about, [{ kind: "book", id: BOOK }, link]);
});
