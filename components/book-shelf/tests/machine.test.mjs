import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The shelf's actor is where the rename decision lives (D11): the view turns Enter or
// blur into a _rename gesture carrying the field's text, and the machine announces it
// as book.renamed only when it is a real change. Enter/blur/Escape themselves are the
// view's DOM concern, driven in the browser test; here we drive the actor directly
// with a fake ask, the shape fact.js builds for real.
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const flush = () => new Promise((r) => setTimeout(r, 0));

const ask = (target, name) =>
  name === "list"
    ? Promise.resolve({ books: [] })
    : name === "read"
      ? Promise.resolve({ userId: "u1", registrationOpen: false })
      : Promise.resolve({ id: null });

function start() {
  const actor = createActor(machine, { input: { ask, undoMs: 3000 } });
  const renamed = [];
  actor.on("book.renamed", (e) => renamed.push(e));
  actor.start();
  return { actor, renamed };
}

// A book.changed, as books emits it, carrying the whole book (4.3, third rule).
const changed = (id, title) => ({
  type: "book.changed",
  id,
  title,
  author: "A",
  cover: null,
  position: { chapter: 0, block: 0 },
  chapters: [{ title: "x" }],
  toc: [],
  version: 1,
  contentVersion: 1,
  pending: false,
  addedAt: 1,
  updatedAt: 1,
});

test("_rename announces book.renamed with the trimmed text when the title changed", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "Old"));
  actor.send({ type: "_rename", id: ID, title: "  New  " });
  assert.deepEqual(renamed, [{ type: "book.renamed", id: ID, title: "New" }]);
});

test("_rename ignores unchanged text and an unknown book (no announcement)", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "Old"));
  actor.send({ type: "_rename", id: ID, title: "Old" }); // unchanged
  actor.send({ type: "_rename", id: ID, title: "  Old  " }); // unchanged after trim
  actor.send({ type: "_rename", id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", title: "X" }); // unknown
  assert.deepEqual(renamed, []);
});

test("_rename to an empty string is a real change: it restores the file's title", async () => {
  const { actor, renamed } = start();
  await flush();
  actor.send(changed(ID, "User Title"));
  actor.send({ type: "_rename", id: ID, title: "   " });
  assert.deepEqual(renamed, [{ type: "book.renamed", id: ID, title: "" }]);
});
