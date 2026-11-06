import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// A note's type (13), noteType: kept like the links, a save without it keeping it, a
// change of it one step that Undo and Redo reverse, and it rides note.changed, the list
// and a read, and the write to the server.

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const changedSchema = schema("../events/note.changed.json");
const queries = (name) => JSON.parse(readFileSync(new URL(`../queries/${name}.json`, import.meta.url)));
const listSchema = new Validator(queries("list").reply, "2020-12");
const readSchema = new Validator(queries("read").reply, "2020-12");

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function memory() {
  const notes = new Map();
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

async function start({ userId = null, api = null } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  let t = 100;
  const store = memory();
  const actor = createActor(machine, { input: { store, mint, now: () => ++t, ask: () => Promise.resolve({ userId }), api } });
  const steps = [];
  const changed = [];
  actor.on("step.recorded", ({ type, ...p }) => steps.push(p));
  actor.on("note.changed", ({ type, ...p }) => {
    assert.ok(changedSchema.validate(p).valid, JSON.stringify(changedSchema.validate(p).errors?.[0]));
    changed.push(p);
  });
  actor.start();
  await flush();
  return { actor, steps, changed, store };
}

const read = (actor, id) => new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: { id }, reply }));
const list = (actor) => new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }));
const save = (id, body, baseVersion, extra = {}) => ({ type: "note.saved", id, title: body.split("\n")[0], body, baseVersion, ...extra });

test("a new note's type rides note.changed, the list and a read; a save without one keeps it", async () => {
  const { actor, changed } = await start();
  actor.send(save(A, "Idea", null, { noteType: "permanent" }));
  actor.send(save(A, "Idea grown", 1));
  assert.equal(changed.at(-1).noteType, "permanent");
  assert.equal(changed.at(-1).type, undefined, "the event's own name is never a field");
  const rows = await list(actor);
  assert.ok(listSchema.validate(rows).valid);
  assert.equal(rows.notes[0].noteType, "permanent");
  const one = await read(actor, A);
  assert.ok(readSchema.validate(one).valid);
  assert.equal(one.note.noteType, "permanent");
});

test("a note without a type has no noteType field, which reads as fleeting", async () => {
  const { actor, changed } = await start();
  actor.send(save(A, "Idea", null));
  assert.equal("noteType" in changed.at(-1), false);
  assert.equal("noteType" in (await list(actor)).notes[0], false);
});

test("a change of type with the same text is one step of its own; Undo puts the type back and Redo sets it again", async () => {
  const { actor, steps, changed } = await start();
  actor.send(save(A, "Idea", null));
  actor.send(save(A, "Idea", 1, { noteType: "literature" }));
  assert.equal(steps.length, 2, "typing, then the type");
  assert.equal(changed.at(-1).noteType, "literature");
  assert.equal(steps[1].label, "edit note Idea");
  actor.send({ type: "step.undone", id: steps[1].id, owner: "notes", payload: steps[1].undo });
  assert.equal("noteType" in changed.at(-1), false);
  actor.send({ type: "step.redone", id: steps[1].id, owner: "notes", payload: steps[1].redo });
  assert.equal(changed.at(-1).noteType, "literature");
  // The same type again is no change.
  const before = steps.length;
  actor.send(save(A, "Idea", 3, { noteType: "literature", left: true }));
  assert.equal(steps.length, before);
});

test("a save of a place and a type together is one step; Undo takes both back", async () => {
  const { actor, steps, changed } = await start();
  actor.send(save(A, "Idea", null));
  const place = { kind: "note", id: "00000000000000000000000SBX" };
  actor.send(save(A, "Idea", 1, { about: [place], noteType: "permanent" }));
  assert.equal(steps.length, 2, "typing, then the place and the type");
  assert.deepEqual(changed.at(-1).about, [place]);
  actor.send({ type: "step.undone", id: steps[1].id, owner: "notes", payload: steps[1].undo });
  assert.deepEqual(changed.at(-1).about, []);
  assert.equal("noteType" in changed.at(-1), false);
});

test("signed in, the outbox row carries the type, null for fleeting, and a pull takes the server's", async () => {
  const puts = [];
  const api = {
    put: async (row) => {
      puts.push(row);
      return { id: row.id, title: row.title, body: row.body, version: 1, updatedAt: 1, deleted: false, about: row.about ?? [], position: row.position ?? null, noteType: row.noteType };
    },
    // The account holds nothing at the start; another device sets the type later.
    pull: async (since) => (since === 0 && !puts.length ? { notes: [], cursor: 0 } : { notes: [{ id: A, title: "Idea", body: "Idea", version: 2, updatedAt: 2, deleted: false, about: [], position: null, noteType: "literature" }], cursor: 1 }),
  };
  const { actor, changed, store } = await start({ userId: "u", api });
  actor.send(save(A, "Idea", null));
  await flush();
  assert.equal(store.outbox.get(A).noteType, null);
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(puts.at(-1).noteType, null);
  assert.equal(changed.at(-1).noteType, "literature");
});
