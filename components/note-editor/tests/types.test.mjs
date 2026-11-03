import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, homeOf, noteTypeOf, strands, SLIPBOX } from "../machine.js";

// Note types (13), decided by the machine: the label and its menu, when Permanent may be
// chosen, which places keep a permanent note in the Slip-Box, and a new note's type.
const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = new Validator(JSON.parse(readFileSync(resolve(HERE, "..", "events", "note.saved.json"), "utf8")), "2020-12");

const ME = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const TOP = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const SUB = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const LOOSE = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const KID = "01ARZ3NDEKTSV4RRFFQ69G5FA6";
const NEW = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const THROTTLE_MS = 200;

const under = (id) => ({ kind: "note", id });

// TOP under the Slip-Box, SUB under TOP, LOOSE under no one; KID, permanent, under ME.
const LIST = [
  { id: TOP, title: "Top", subtitle: "", updatedAt: 5, about: [under(SLIPBOX)] },
  { id: SUB, title: "Sub", subtitle: "", updatedAt: 6, about: [under(TOP)] },
  { id: LOOSE, title: "Loose", subtitle: "", updatedAt: 7, about: [] },
  { id: KID, title: "Kid", subtitle: "", updatedAt: 8, about: [under(ME)], noteType: "permanent" },
];
const mine = (about, noteType) => ({ id: ME, title: "Me", body: "Me", version: 3, pending: false, updatedAt: 4, about, ...(noteType ? { noteType } : {}) });

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

function editor({ hidden = [], note = null, subject = null, subjecting = false } = {}) {
  const saved = [];
  const ask = (target, name) => {
    if (target === "flags") return Promise.resolve({ hidden });
    if (target === "subject") return Promise.resolve({ subject });
    if (target === "notes" && name === "list") return Promise.resolve({ notes: [...LIST, ...(note ? [{ ...note, subtitle: "" }] : [])] });
    if (target === "notes" && name === "read") return Promise.resolve(note ? { note } : { error: "not-found" });
    if (target === "notes" && name === "find") return Promise.resolve({ notes: [], total: 0, more: 0 });
    return Promise.resolve({});
  };
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    input: { ask, mint: () => NEW, focus: () => {}, subjecting, recallTitles: () => ({}), rememberTitles: () => {} },
    clock,
  });
  actor.on("note.saved", (e) => saved.push(e));
  actor.start();
  return { actor, saved, clock };
}

async function opened(note, options = {}) {
  const e = editor({ ...options, note });
  await settle();
  e.actor.send({ type: "load", id: note.id });
  await settle();
  return e;
}

const valid = (event) => {
  const { type, ...rest } = event;
  return SAVED.validate(rest).valid;
};

test("hidden Slip-Box: no type label and no type on a save, the type kept as it is", async () => {
  const { actor, saved, clock } = await opened(mine([under(TOP)], "literature"), { hidden: ["slip-box"] });
  assert.equal(homeOf(actor.getSnapshot()), null);
  actor.send({ type: "_retype", noteType: "fleeting" });
  actor.send({ type: "_typed", body: "Me\nmore" });
  clock.increment(THROTTLE_MS);
  assert.equal(saved.length, 1);
  assert.equal("noteType" in saved[0], false);
});

test("the label names the note's type, fleeting when it has none, and the menu lists the three with a line each", async () => {
  const { actor } = await opened(mine([]));
  const type = homeOf(actor.getSnapshot()).type;
  assert.equal(type.value, "fleeting");
  assert.deepEqual(type.options.map((t) => t.label), ["Fleeting", "Literature", "Permanent"]);
  assert.ok(type.options.every((t) => t.says.length > 0));
});

test("Permanent is greyed while the note is not in the Slip-Box, and offered once it is", async () => {
  const outside = await opened(mine([under(LOOSE)]));
  assert.deepEqual(noteTypeOf(outside.actor.getSnapshot().context).options.map((t) => t.enabled), [true, true, false]);
  outside.actor.send({ type: "_retype", noteType: "permanent" });
  assert.deepEqual(outside.saved, []);

  const inside = await opened(mine([under(SUB)]));
  assert.deepEqual(noteTypeOf(inside.actor.getSnapshot().context).options.map((t) => t.enabled), [true, true, true]);
});

test("a type picked is one save with the draft and the new type, shown at once; the same type saves nothing", async () => {
  const { actor, saved } = await opened(mine([under(TOP)]));
  actor.send({ type: "_retype", noteType: "fleeting" });
  assert.deepEqual(saved, []);
  actor.send({ type: "_retype", noteType: "permanent" });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].noteType, "permanent");
  assert.equal(saved[0].body, "Me");
  assert.equal(saved[0].baseVersion, 3);
  assert.equal("about" in saved[0], false, "the links stay as they are");
  assert.ok(valid(saved[0]));
  assert.equal(homeOf(actor.getSnapshot()).type.value, "permanent");
});

test("a permanent note's last place in the Slip-Box keeps it there; a second place may go", async () => {
  const one = await opened(mine([under(TOP)], "permanent"));
  assert.equal(homeOf(one.actor.getSnapshot()).places[0].stays, true);
  one.actor.send({ type: "_unplace", id: TOP });
  assert.deepEqual(one.saved, []);

  const two = await opened(mine([under(TOP), under(SLIPBOX), under(LOOSE)], "permanent"));
  const places = homeOf(two.actor.getSnapshot()).places;
  assert.deepEqual(places.map((p) => Boolean(p.stays)), [false, false, false]);
  two.actor.send({ type: "_unplace", id: TOP });
  assert.equal(two.saved.length, 1);
});

test("a note whose last place would take a permanent note under it out of the Slip-Box keeps that place", async () => {
  const { actor, saved } = await opened(mine([under(TOP)]));
  assert.equal(strands(actor.getSnapshot().context, TOP), true, "KID, permanent, is under ME");
  actor.send({ type: "_unplace", id: TOP });
  assert.deepEqual(saved, []);
});

async function typedNew(subject) {
  const e = editor({ subjecting: true, subject });
  await settle();
  e.actor.send({ type: "_typed", body: "fresh" });
  e.clock.increment(THROTTLE_MS);
  return e.saved;
}

test("a new note is permanent under a note in the Slip-Box, fleeting beside a book or under a note outside it", async () => {
  const inBox = await typedNew({ kind: "note", id: SUB, title: "Sub", view: "book-stage" });
  assert.equal(inBox[0].noteType, "permanent");
  assert.ok(valid(inBox[0]));
  assert.equal((await typedNew({ kind: "note", id: SLIPBOX, title: "Slip-Box", view: "book-stage" }))[0].noteType, "permanent");
  assert.equal((await typedNew({ kind: "book", id: BOOK, title: "A Book", view: "book-stage" }))[0].noteType, "fleeting");
  assert.equal((await typedNew({ kind: "note", id: LOOSE, title: "Loose", view: "book-stage" }))[0].noteType, "fleeting");
});
