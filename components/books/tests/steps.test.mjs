import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, JOURNAL } from "../machine.js";

// books as an owner of steps (12, Undo): what it records for adding, renaming and
// deleting a book, and how it applies an Undo or Redo `undo` names to it. The server is a
// small fake that versions rows the way books/server/router.py does, so a restore write
// is checked against the tombstone's version.

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const C = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
const SYNC_IDLE_MS = 2000;

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const changedSchema = schema("../events/book.changed.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const row = (id, over = {}) => ({
  id,
  title: "Dune",
  fileTitle: "Dune",
  author: "Herbert",
  fileAuthor: "Herbert",
  cover: null,
  chapters: [{ title: "One" }, { title: "Two" }],
  toc: [],
  position: { chapter: 0, block: 0 },
  version: 1,
  contentVersion: 1,
  addedAt: 10,
  updatedAt: 10,
  deleted: false,
  ...over,
});

function memory(initial = []) {
  const books = new Map(initial.map((b) => [b.id, b]));
  const outbox = new Map();
  const meta = new Map([["userId", "u1"]]);
  return {
    books,
    outbox,
    all: async () => [...books.values()],
    put: async (r) => void books.set(r.id, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
    clear: async () => (books.clear(), outbox.clear()),
    empty: async () => (books.clear(), outbox.clear()),
  };
}

// The server's rows, each written with the next version, as the router does.
function server(initial = []) {
  const rows = new Map(initial.map((b) => [b.id, { ...b, userTitle: null, userAuthor: null }]));
  const restores = [];
  const out = (r) => {
    const { userTitle, userAuthor, ...rest } = r;
    return { ...rest, title: userTitle ?? r.fileTitle, author: userAuthor ?? r.fileAuthor };
  };
  const bump = (id, over) => {
    const r = { ...rows.get(id), ...over, version: rows.get(id).version + 1 };
    rows.set(id, r);
    return out(r);
  };
  const purged = [];
  return {
    rows,
    restores,
    purged,
    // The files of a deleted book go; a restore after that is refused as changed (409).
    purge: async (id) => {
      if (!rows.get(id)?.deleted) throw new Error("books purge 404");
      purged.push(id);
    },
    upload: async (id) => {
      rows.set(id, { ...row(id), userTitle: null, userAuthor: null });
      return { row: out(rows.get(id)) };
    },
    remove: async (id) => (rows.get(id).deleted ? out(rows.get(id)) : bump(id, { deleted: true })),
    restore: async (id, base) => {
      restores.push([id, base]);
      const r = rows.get(id);
      if (!r) return { error: "not-found" };
      if (r.deleted && r.version === base && purged.includes(id)) return { error: "changed" };
      return r.deleted && r.version === base ? bump(id, { deleted: false }) : out(r);
    },
    title: async (id, t, a) =>
      bump(id, {
        ...(t !== undefined ? { userTitle: t.trim() || null } : {}),
        ...(a !== undefined ? { userAuthor: a.trim() || null } : {}),
      }),
    position: async (id, chapter, block) => bump(id, { position: { chapter, block } }),
    shelf: async (id, shelfPlace) => (rows.has(id) ? bump(id, { shelfPlace }) : { error: "not-found" }),
    opened: async (id) => ({ id, at: 500 }),
    pull: async () => ({ books: [], cursor: 0 }),
    // Another device's write, which this browser learns of from a pull.
    elsewhere: (id, over) => bump(id, over),
  };
}

async function start({ store = memory(), api = server() } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  let t = 100;
  const clock = new SimulatedClock();
  const ask = (target) => Promise.resolve(target === "session" ? { userId: "u1" } : { error: "no-answerer" });
  const actor = createActor(machine, { input: { store, mint, now: () => ++t, ask, api, revoke: () => {} }, clock });
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
  actor.on("book.changed", ({ type, ...p }) => {
    assert.ok(changedSchema.validate(p).valid, JSON.stringify(p));
    changed.push(p);
  });
  actor.on("book.deleted", (e) => deleted.push(e.id));
  actor.start();
  await flush();
  const sync = async () => {
    clock.increment(SYNC_IDLE_MS);
    await flush();
  };
  await sync();
  return { actor, steps, settled, changed, deleted, store, api, sync };
}

const read = (actor, id) => new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: { id }, reply }));
const undo = (step) => ({ type: "step.undone", id: step.id, owner: "books", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "books", payload: step.redo });
const shown = async (actor, id) => (await read(actor, id)).book ?? null;
const order = async (actor) =>
  (await new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }))).books.map((b) => b.id);
// Three books never placed, newest first: A, B, C.
const three = () => [row(A, { addedAt: 30 }), row(B, { addedAt: 20 }), row(C, { addedAt: 10 })];

test("adding a book is one step: Undo deletes it, Redo brings it back without importing it again", async () => {
  const h = await start();
  h.actor.send({ type: "book.picked", id: A, name: "dune.epub", size: 9, url: "blob:x" });
  await flush();
  assert.equal(h.steps.length, 1);
  const [step] = h.steps;
  assert.equal(step.label, "add book Dune");
  assert.deepEqual(step.undo, { kind: "book", id: A, deleted: true });
  assert.deepEqual(step.redo, { kind: "book", id: A, deleted: false });
  assert.equal(step.notice, undefined, "only a delete asks for the notice");

  h.actor.send(undo(step));
  assert.deepEqual(h.settled.at(-1), { id: step.id, owner: "books", outcome: "applied" });
  assert.deepEqual(h.deleted, [A]);
  await h.sync();
  assert.equal(h.api.rows.get(A).deleted, true, "the delete reached the server");

  h.actor.send(redo(step));
  assert.equal(h.settled.at(-1).outcome, "applied");
  assert.equal((await shown(h.actor, A)).title, "Dune");
  await h.sync();
  // Version 2 is the new book's place on the shelf, 3 its delete.
  assert.deepEqual(h.api.restores, [[A, 3]], "a restore write naming the tombstone's version");
  assert.equal(h.api.rows.get(A).deleted, false);
  assert.equal(h.api.rows.get(A).contentVersion, 1, "nothing is imported again");
  assert.equal(h.store.outbox.size, 0);

  h.actor.send(undo(step));
  assert.equal(h.settled.at(-1).outcome, "applied", "the step can be undone again");
});

test("a rename is one step whose Undo and Redo give back the title and author exactly", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.renamed", id: A, title: "Arrakis", author: "Frank" });
  const [step] = h.steps;
  assert.equal(step.label, "rename book Dune");
  assert.deepEqual(step.undo, { kind: "name", id: A, title: "", author: "" });
  assert.deepEqual(step.redo, { kind: "name", id: A, title: "Arrakis", author: "Frank" });
  await h.sync();

  h.actor.send(undo(step));
  assert.equal(h.settled.at(-1).outcome, "applied", "the server's answer to the rename refuses nothing");
  const back = await shown(h.actor, A);
  assert.deepEqual([back.title, back.author], ["Dune", "Herbert"]);
  await h.sync();
  assert.deepEqual([h.api.rows.get(A).userTitle, h.api.rows.get(A).userAuthor], [null, null]);

  h.actor.send(redo(step));
  assert.equal(h.settled.at(-1).outcome, "applied");
  const again = await shown(h.actor, A);
  assert.deepEqual([again.title, again.author], ["Arrakis", "Frank"]);
});

test("several renames of one book undo one after another, and redo in order", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.renamed", id: A, title: "One", author: "Herbert" });
  h.actor.send({ type: "book.renamed", id: A, title: "Two", author: "Herbert" });
  h.actor.send({ type: "book.renamed", id: A, title: "Two", author: "Frank" });
  const [first, second, third] = h.steps;
  assert.equal(h.steps.length, 3);
  assert.equal(second.undo.prior, first.id);
  assert.equal(third.undo.prior, second.id);
  const title = async () => {
    const b = await shown(h.actor, A);
    return `${b.title} / ${b.author}`;
  };
  h.actor.send(undo(third));
  assert.equal(await title(), "Two / Herbert");
  h.actor.send(undo(second));
  assert.equal(await title(), "One / Herbert");
  h.actor.send(undo(first));
  assert.equal(await title(), "Dune / Herbert");
  h.actor.send(redo(first));
  h.actor.send(redo(second));
  h.actor.send(redo(third));
  assert.equal(await title(), "Two / Frank");
  assert.ok(h.settled.every((s) => s.outcome === "applied"), JSON.stringify(h.settled));
});

test("a delete happens at once as one step with the notice; Undo restores it, Redo deletes it again", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.discarded", id: A });
  const [step] = h.steps;
  assert.equal(step.label, "delete book Dune");
  assert.equal(step.notice, true);
  const { shelfPlace, ...undoing } = step.undo;
  assert.ok(shelfPlace, "the place it stood at");
  assert.deepEqual(undoing, { kind: "book", id: A, deleted: false });
  assert.deepEqual(step.redo, { kind: "book", id: A, deleted: true });
  assert.deepEqual(h.deleted, [A]);

  // Undone before the delete was sent: the delete is taken out of the outbox.
  h.actor.send(undo(step));
  assert.equal((await shown(h.actor, A)).title, "Dune");
  await h.sync();
  assert.equal(h.api.rows.get(A).deleted, false, "the server never deleted it");
  assert.equal(h.api.rows.get(A).version, 1);

  h.actor.send(redo(step));
  assert.equal(await shown(h.actor, A), null);
  await h.sync();
  assert.equal(h.api.rows.get(A).deleted, true);
  h.actor.send(undo(step));
  await h.sync();
  assert.equal(h.api.rows.get(A).deleted, false, "brought back with a restore write");
  // The first restore found the book live, since its delete was never sent, and changed nothing.
  assert.deepEqual(h.api.restores, [[A, 1], [A, 2]]);
  assert.ok(h.settled.every((s) => s.outcome === "applied"));
});

test("a deleted book's files go only when its delete step leaves the undo list; a restore after that leaves it deleted", async () => {
  const h = await start({ store: memory([row(A), row(B, { title: "Emma", fileTitle: "Emma" })]), api: server([row(A), row(B, { title: "Emma", fileTitle: "Emma" })]) });
  h.actor.send({ type: "book.discarded", id: A });
  await h.sync();
  const [step] = h.steps;
  const dropped = (s, payload = s.redo, owner = "books") => ({ type: "step.dropped", id: s.id, owner, payload });
  assert.deepEqual(h.api.purged, [], "nothing is erased while the step can be undone");
  h.actor.send(dropped(step, step.redo, "notes"));
  h.actor.send(dropped({ ...step, id: "01ARZ3NDEKTSV4RRFFQ69G9999" }));
  await flush();
  assert.deepEqual(h.api.purged, [], "another owner's step, or a step that did not write the book, erases nothing");
  h.actor.send(dropped(step));
  await flush();
  assert.deepEqual(h.api.purged, [A]);

  // A live book's step leaving the list erases nothing: its rename names no delete.
  h.actor.send({ type: "book.renamed", id: B, title: "Persuasion" });
  h.actor.send(dropped(h.steps.at(-1)));
  await flush();
  assert.deepEqual(h.api.purged, [A]);

  // A restore that reaches the server after the files went is refused, and the book stays deleted.
  h.actor.send(undo(step));
  assert.ok(await shown(h.actor, A), "Undo shows it at once (5)");
  await h.sync();
  assert.equal(await shown(h.actor, A), null);
  assert.equal(h.deleted.at(-1), A);
  assert.equal(h.api.rows.get(A).deleted, true);
});

test("book.restored brings a deleted book back as one step after the delete's; Undo deletes it again, Undo again brings it back, Redo deletes it", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.discarded", id: A });
  await h.sync();
  const [del] = h.steps;
  h.actor.send({ type: "book.restored", id: A });
  assert.equal(h.steps.length, 2);
  const res = h.steps[1];
  assert.equal(res.label, "restore book Dune");
  assert.equal(res.notice, undefined);
  assert.deepEqual(res.undo, { kind: "book", id: A, deleted: true, prior: del.id });
  assert.equal(res.redo.deleted, false);
  assert.equal(res.redo.prior, del.id);
  assert.equal(res.redo.shelfPlace, del.undo.shelfPlace, "named no neighbours: the book keeps its place");
  assert.equal((await shown(h.actor, A)).title, "Dune");
  await h.sync();
  assert.equal(h.api.rows.get(A).deleted, false, "brought back with a restore write");

  h.actor.send({ type: "book.restored", id: A });
  assert.equal(h.steps.length, 2, "a book on the shelf is not restored again");

  h.actor.send(undo(res));
  assert.equal(await shown(h.actor, A), null, "Undo deletes it again");
  h.actor.send(undo(del));
  assert.equal((await shown(h.actor, A)).title, "Dune", "the delete's Undo brings it back");
  h.actor.send(redo(del));
  h.actor.send(redo(res));
  assert.equal((await shown(h.actor, A)).title, "Dune", "Redo brings it back again");
  h.actor.send(undo(res));
  assert.equal(await shown(h.actor, A), null);
  await h.sync();
  assert.equal(h.api.rows.get(A).deleted, true);
  assert.ok(h.settled.every((s) => s.outcome === "applied"), JSON.stringify(h.settled));
});

test("book.restored leaves a book alone whose files went when its delete step left the undo list", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.discarded", id: A });
  await h.sync();
  const [del] = h.steps;
  h.actor.send({ type: "step.dropped", id: del.id, owner: "books", payload: del.redo });
  await flush();
  assert.deepEqual(h.api.purged, [A]);
  h.actor.send({ type: "book.restored", id: A });
  assert.equal(h.steps.length, 1, "no step");
  assert.equal(await shown(h.actor, A), null);
  h.actor.send({ type: "book.restored", id: B });
  assert.equal(h.steps.length, 1, "an unknown book records nothing");
});

test("Undo of a delete while it is on its way still brings the book back", async () => {
  let release;
  const api = server([row(A)]);
  const remove = api.remove;
  api.remove = (id) => new Promise((r) => (release = () => r(remove(id))));
  const h = await start({ store: memory([row(A)]), api });
  h.actor.send({ type: "book.discarded", id: A });
  await h.sync();
  h.actor.send(undo(h.steps[0]));
  release();
  await flush();
  assert.ok(await shown(h.actor, A), "the book stays");
  await h.sync();
  assert.equal(h.api.rows.get(A).deleted, false);
  assert.deepEqual(h.api.restores, [[A, 2]]);
});

test("adding, deleting and renaming several books are separate steps, each undone on its own", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.picked", id: B, name: "emma.epub", size: 9, url: "blob:y" });
  await flush();
  h.actor.send({ type: "book.renamed", id: A, title: "Arrakis", author: "Herbert" });
  h.actor.send({ type: "book.discarded", id: A });
  const [add, rename, del] = h.steps;
  h.actor.send(undo(del));
  h.actor.send(undo(rename));
  h.actor.send(undo(add));
  assert.ok(h.settled.every((s) => s.outcome === "applied"), JSON.stringify(h.settled));
  assert.equal((await shown(h.actor, A)).title, "Dune");
  assert.equal(await shown(h.actor, B), null);
});

test("a step is refused when the book was written since by anything else", async () => {
  const api = server([row(A), row(B)]);
  const h = await start({ store: memory([row(A), row(B)]), api });
  h.actor.send({ type: "book.renamed", id: A, title: "Arrakis", author: "Herbert" });
  h.actor.send({ type: "book.discarded", id: B });
  await h.sync();
  // Another device renames A and brings B back.
  api.elsewhere(A, { userTitle: "Elsewhere" });
  api.elsewhere(B, { deleted: false });
  api.pull = async () => ({ books: [...api.rows.values()].map((r) => ({ ...r, title: r.userTitle ?? r.fileTitle, author: r.fileAuthor })), cursor: 9 });
  h.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await shown(h.actor, B)).title, "Dune", "a restore made elsewhere comes back here too");
  h.actor.send(undo(h.steps[0]));
  assert.deepEqual(h.settled.at(-1), { id: h.steps[0].id, owner: "books", outcome: "refused", reason: "changed" });
  h.actor.send(undo(h.steps[1]));
  assert.equal(h.settled.at(-1).outcome, "refused");
  assert.equal((await shown(h.actor, A)).title, "Elsewhere", "nothing was changed");
});

test("turning a page is not a step and refuses nothing", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.renamed", id: A, title: "Arrakis", author: "Herbert" });
  h.actor.send({ type: "book.progressed", id: A, chapter: 1, block: 3 });
  await h.sync();
  assert.equal(h.steps.length, 1);
  h.actor.send(undo(h.steps[0]));
  assert.equal(h.settled.at(-1).outcome, "applied");
  assert.deepEqual((await shown(h.actor, A)).position, { chapter: 1, block: 3 });
});

test("the journal records nothing, and a step of another owner is not answered", async () => {
  const h = await start({ store: memory([row(A)]), api: server([row(A)]) });
  h.actor.send({ type: "book.renamed", id: JOURNAL, title: "Diary" });
  h.actor.send({ type: "book.discarded", id: JOURNAL });
  assert.equal(h.steps.length, 0);
  h.actor.send({ type: "step.undone", id: "01ARZ3NDEKTSV4RRFFQ69G9999", owner: "notes", payload: { kind: "book", id: A, deleted: true } });
  assert.equal(h.settled.length, 0);
  assert.ok(await shown(h.actor, A));
});

test("a deleted book comes back between its neighbours, and Undo and Redo walk the order there and back", async () => {
  const h = await start({ store: memory(three()), api: server(three()) });
  assert.deepEqual(await order(h.actor), [A, B, C], "never placed: newest first");
  h.actor.send({ type: "book.discarded", id: A });
  h.actor.send({ type: "book.restored", id: A, after: C, before: null });
  const [del, res] = h.steps;
  assert.deepEqual(await order(h.actor), [B, C, A], "at the end");
  assert.equal(h.changed.at(-1).shelfPlace, res.redo.shelfPlace, "the news carries the place");
  await h.sync();
  assert.equal(h.api.rows.get(A).shelfPlace, res.redo.shelfPlace, "the place reached the server");
  assert.equal(h.api.rows.get(A).deleted, false);

  h.actor.send({ type: "book.discarded", id: C });
  h.actor.send({ type: "book.restored", id: C, after: null, before: B });
  assert.deepEqual(await order(h.actor), [C, B, A], "at the start");
  const [, , delC, resC] = h.steps;

  h.actor.send(undo(resC));
  h.actor.send(undo(delC));
  assert.deepEqual(await order(h.actor), [B, C, A], "back where it stood");
  h.actor.send(undo(res));
  assert.deepEqual(await order(h.actor), [B, C]);
  h.actor.send(undo(del));
  assert.deepEqual(await order(h.actor), [A, B, C], "the delete's Undo puts it back where it stood");
  await h.sync();
  assert.deepEqual([...h.api.rows.values()].filter((r) => r.deleted), [], "nothing left deleted on the server");

  h.actor.send(redo(del));
  h.actor.send(redo(res));
  assert.deepEqual(await order(h.actor), [B, C, A], "Redo walks forward again");
  await h.sync();
});

test("a new book goes first, also ahead of a book moved to the top", async () => {
  const h = await start({ store: memory(three()), api: server(three()) });
  h.actor.send({ type: "book.discarded", id: C });
  h.actor.send({ type: "book.restored", id: C, after: null, before: A });
  assert.deepEqual(await order(h.actor), [C, A, B]);
  const NEW = "01ARZ3NDEKTSV4RRFFQ69G5FD0";
  h.actor.send({ type: "book.picked", id: NEW, name: "new.epub", size: 9, url: "blob:n" });
  await flush();
  assert.deepEqual(await order(h.actor), [NEW, C, A, B]);
  await h.sync();
  assert.deepEqual(await order(h.actor), [NEW, C, A, B], "the server's answer keeps it there");
  assert.ok(h.api.rows.get(NEW).shelfPlace);
});

test("a place set on another device arrives with a pull; one of this browser still on its way stands over it", async () => {
  const api = server(three());
  const h = await start({ store: memory(three()), api });
  const rows = () => ({ books: [...api.rows.values()].map((r) => ({ ...r, title: r.fileTitle, author: r.fileAuthor })), cursor: 9 });
  api.elsewhere(C, { shelfPlace: "1" });
  api.pull = async () => rows();
  h.actor.send({ type: "_sync", pull: true });
  await h.sync();
  assert.deepEqual(await order(h.actor), [C, A, B], "the other device's place");

  // An answer to a page turn brings the place too, and a later pull would skip that row.
  api.elsewhere(B, { shelfPlace: "0V" });
  h.actor.send({ type: "book.progressed", id: B, chapter: 1, block: 0 });
  await h.sync();
  assert.deepEqual(await order(h.actor), [B, C, A], "not kept stale by this browser's copy");

  // A place of this browser waits offline; the pull that follows does not move the book back.
  const sent = api.shelf;
  api.shelf = async () => {
    throw new Error("offline");
  };
  h.actor.send({ type: "book.discarded", id: A });
  h.actor.send({ type: "book.restored", id: A, after: null, before: B });
  await h.sync();
  assert.deepEqual(await order(h.actor), [A, B, C]);
  api.shelf = sent;
  await h.sync();
  h.actor.send({ type: "_sync", pull: true });
  await h.sync();
  assert.deepEqual(await order(h.actor), [A, B, C]);
});
