import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "pins.changed.json");
const READ = json("queries", "read.json").reply;
const recorded = [];

const NOTE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const ADMIN = "3d9556d17fa655edc8d64ec9ced88c98";
const GUEST = "b5d9cf7c30b0616b851e4facf5b0597a";

const flush = () => new Promise((r) => setTimeout(r, 0));

// session: read answered as the given account; NO_SESSION is a page without session.
const NO_SESSION = Symbol("no session");
const start = async (stored = null, userId = ADMIN) => {
  const saved = [];
  const ask = () => (userId === NO_SESSION ? Promise.resolve({ error: "no-answerer" }) : Promise.resolve({ userId, registrationOpen: false }));
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(JSON.parse(v)), ask } });
  const emitted = [];
  actor.on("pins.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.start();
  await flush();
  return { actor, saved, emitted };
};

const read = (actor) =>
  new Promise((resolve) =>
    actor.send({
      type: "read?",
      cid: 1,
      reply: (v) => {
        recorded.push({ value: v, schema: READ });
        resolve(v);
      },
    }),
  );

test("nothing stored, or something unreadable, is nothing pinned", async () => {
  for (const stored of [null, "not json", "[1]", JSON.stringify({ note: "nope", chat: 3 })]) {
    assert.deepEqual(await read((await start(stored)).actor), { note: null, chat: null, evaluators: null });
  }
});

test("a pin is kept, saved and announced, and each of the three is its own", async () => {
  const { actor, saved, emitted } = await start();
  actor.send({ type: "pin.toggled", what: "note", id: NOTE });
  actor.send({ type: "pin.toggled", what: "chat", id: CHAT });
  actor.send({ type: "pin.toggled", what: "evaluators", id: BOOK });
  const all = { note: NOTE, chat: CHAT, evaluators: BOOK };
  assert.deepEqual(await read(actor), all);
  assert.deepEqual(saved.at(-1), { [ADMIN]: all });
  assert.equal(emitted.length, 3);
  assert.deepEqual({ ...emitted.at(-1), type: undefined }, { ...all, type: undefined });

  actor.send({ type: "pin.toggled", what: "chat", id: null });
  assert.deepEqual(await read(actor), { ...all, chat: null }, "unpinning one leaves the others");
});

test("a repeat changes nothing and announces nothing", async () => {
  const { actor, saved, emitted } = await start(JSON.stringify({ [ADMIN]: { note: NOTE, chat: null, evaluators: null } }));
  actor.send({ type: "pin.toggled", what: "note", id: NOTE });
  actor.send({ type: "pin.toggled", what: "chat", id: null });
  assert.equal(saved.length, 0);
  assert.equal(emitted.length, 0);
});

test("a stored pin survives a reload", async () => {
  const first = await start();
  first.actor.send({ type: "pin.toggled", what: "evaluators", id: BOOK });
  const again = await start(JSON.stringify(first.saved.at(-1)));
  assert.deepEqual(await read(again.actor), { note: null, chat: null, evaluators: BOOK });
});

test("each account has its own pins: another account in the browser sees none of the admin's", async () => {
  const stored = JSON.stringify({ [ADMIN]: { note: NOTE, chat: CHAT, evaluators: BOOK } });
  assert.deepEqual(await read((await start(stored, GUEST)).actor), { note: null, chat: null, evaluators: null });
  assert.deepEqual(await read((await start(stored, null)).actor), { note: null, chat: null, evaluators: null }, "nor does no one");
});

test("View as and Back to you swap the pins; the news that the browser is leaving changes nothing", async () => {
  const { actor, emitted } = await start(JSON.stringify({ [ADMIN]: { note: null, chat: null, evaluators: BOOK } }));
  actor.send({ type: "session.changed", userId: ADMIN, registrationOpen: false, leaving: true });
  assert.equal(emitted.length, 0);
  actor.send({ type: "session.changed", userId: GUEST, registrationOpen: false });
  assert.deepEqual({ ...emitted.at(-1), type: undefined }, { note: null, chat: null, evaluators: null, type: undefined });
  actor.send({ type: "pin.toggled", what: "note", id: NOTE });
  actor.send({ type: "session.changed", userId: ADMIN, registrationOpen: false });
  assert.deepEqual(await read(actor), { note: null, chat: null, evaluators: BOOK });
  actor.send({ type: "session.changed", userId: GUEST, registrationOpen: false });
  assert.deepEqual(await read(actor), { note: NOTE, chat: null, evaluators: null }, "the guest's own pin is kept for it");
});

test("pins stored before they were kept per account go to the first account seen", async () => {
  const { actor, saved } = await start(JSON.stringify({ note: null, chat: null, evaluators: BOOK }));
  assert.deepEqual(await read(actor), { note: null, chat: null, evaluators: BOOK });
  assert.deepEqual(saved.at(-1), { [ADMIN]: { note: null, chat: null, evaluators: BOOK } });
});

test("pins from before are the owner's: an account the admin only views as never takes them", async () => {
  const stored = JSON.stringify({ note: null, chat: null, evaluators: BOOK });
  const saved = [];
  const ask = () => Promise.resolve({ userId: GUEST, registrationOpen: false, guest: true, viewingAs: "Guest 11" });
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(JSON.parse(v)), ask } }).start();
  assert.deepEqual(await read(actor), { note: null, chat: null, evaluators: null });
  assert.deepEqual(saved, [], "nothing is handed over while viewing as");
  actor.send({ type: "session.changed", userId: ADMIN, registrationOpen: false, admin: true });
  assert.deepEqual(await read(actor), { note: null, chat: null, evaluators: BOOK }, "Back to you finds the admin's pin");
  assert.deepEqual(saved.at(-1), { [ADMIN]: { note: null, chat: null, evaluators: BOOK } });
});

test("a read before session answers waits for it, and a page without session has the signed-out pins", async () => {
  const stored = JSON.stringify({ "": { note: NOTE, chat: null, evaluators: null }, [ADMIN]: { note: null, chat: null, evaluators: BOOK } });
  const actor = createActor(machine, {
    input: { stored, save: () => {}, ask: () => Promise.resolve({ userId: ADMIN, registrationOpen: false }) },
  }).start();
  assert.deepEqual(await read(actor), { note: null, chat: null, evaluators: BOOK });
  assert.deepEqual(await read((await start(stored, NO_SESSION)).actor), { note: NOTE, chat: null, evaluators: null });
});

test("every emit and reply matches its schema", () => {
  for (const { value, schema } of recorded) {
    const { type, ...payload } = value;
    const result = new Validator(schema, "2020-12").validate(payload);
    assert.ok(result.valid, JSON.stringify(result.errors));
  }
});
