import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, MAX_STEPS, WAIT_MS } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const SCHEMAS = Object.fromEntries(
  ["step.undone", "step.redone", "step.settled", "step.dropped", "undo.changed"].map((n) => [n, json("events", `${n}.json`)]),
);
const READ = json("queries", "read.json").reply;
const RECORDED = json("..", "values", "events", "step.recorded.json");

const ADMIN = "3d9556d17fa655edc8d64ec9ced88c98";
const GUEST = "b5d9cf7c30b0616b851e4facf5b0597a";
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// ULIDs that sort by n.
const idOf = (n) => `01ARZ3NDEKTSV4RRFFQ69G${String(n).padStart(4, "0")}`;
const step = (n, extra = {}) => ({
  type: "step.recorded",
  id: idOf(n),
  owner: "values",
  label: `step ${n}`,
  undo: { n, side: "before" },
  redo: { n, side: "after" },
  ...extra,
});

const check = (schema, value) => {
  const result = new Validator(schema, "2020-12").validate(value);
  assert.ok(result.valid, JSON.stringify(result.errors));
};

// A memory store shared like the browser's IndexedDB, so two actors stand for two tabs.
const memory = (initial = {}) => {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    read: async (account) => rows.get(account),
    write: async (account, lists) => void rows.set(account, structuredClone(lists)),
  };
};

function start({ store = memory(), userId = ADMIN, clock = new SimulatedClock() } = {}) {
  const told = [];
  const ask = () => Promise.resolve(userId === null ? { error: "no-answerer" } : { userId });
  const actor = createActor(machine, { input: { store, ask, tell: (a) => told.push(a) }, clock });
  const heard = [];
  for (const name of Object.keys(SCHEMAS))
    actor.on(name, (e) => {
      const { type, ...payload } = e;
      check(SCHEMAS[name], payload);
      heard.push(e);
    });
  actor.start();
  return { actor, heard, told, store, clock };
}

const read = (actor) =>
  new Promise((done) =>
    actor.send({
      type: "read?",
      payload: {},
      cid: 1,
      reply: (v) => {
        check(READ, v);
        done(v);
      },
    }),
  );
const of = (heard, type) => heard.filter((e) => e.type === type);
const settle = (actor, id, outcome, reason) =>
  actor.send({ type: "step.settled", id, owner: "values", outcome, ...(reason ? { reason } : {}) });

test("a recorded step is what Undo names, kept for the account, and other tabs are told", async () => {
  const { actor, heard, told, store } = await start();
  await flush();
  check(RECORDED, (({ type, ...p }) => p)(step(1)));
  actor.send(step(1));
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(1), label: "step 1" }, redo: null });
  assert.equal(store.rows.get(ADMIN).undo.length, 1);
  assert.deepEqual(told, [ADMIN]);
  assert.deepEqual(of(heard, "undo.changed").at(-1), { type: "undo.changed", undo: { id: idOf(1), label: "step 1" }, redo: null });
});

test("undo names the top step to its owner, applied moves it to redo, and redo brings it back", async () => {
  const { actor, heard } = await start();
  await flush();
  actor.send(step(1));
  actor.send(step(2));
  actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  assert.deepEqual(of(heard, "step.undone"), [{ type: "step.undone", id: idOf(2), owner: "values", payload: { n: 2, side: "before" } }]);
  settle(actor, idOf(2), "applied");
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(1), label: "step 1" }, redo: { id: idOf(2), label: "step 2" } });

  actor.send({ type: "step.requested", direction: "redo" });
  await flush();
  assert.deepEqual(of(heard, "step.redone"), [{ type: "step.redone", id: idOf(2), owner: "values", payload: { n: 2, side: "after" } }]);
  settle(actor, idOf(2), "applied");
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(2), label: "step 2" }, redo: null });
});

test("a refused step is dropped and the next Undo goes on to the one before", async () => {
  const { actor, heard } = await start();
  await flush();
  actor.send(step(1));
  actor.send(step(2));
  actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  settle(actor, idOf(2), "refused", "changed");
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(1), label: "step 1" }, redo: null });
  actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  assert.equal(of(heard, "step.undone").at(-1).id, idOf(1));
});

test("an owner that does not answer within 2 seconds is unreachable, and the step stays", async () => {
  const { actor, heard, clock } = await start();
  await flush();
  actor.send(step(1));
  actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  // A second press while the first waits would wait on the same step again: it is dropped.
  actor.send({ type: "step.requested", direction: "undo" });
  clock.increment(WAIT_MS - 1);
  assert.equal(of(heard, "step.settled").length, 0);
  clock.increment(1);
  await flush();
  assert.deepEqual(of(heard, "step.settled"), [{ type: "step.settled", id: idOf(1), owner: "values", outcome: "unreachable" }]);
  assert.equal(of(heard, "step.undone").length, 1);
  assert.deepEqual(await read(actor), { undo: { id: idOf(1), label: "step 1" }, redo: null });
  // A late answer changes nothing.
  settle(actor, idOf(1), "applied");
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(1), label: "step 1" }, redo: null });
});

test("requests made while a step is out are applied in order once it settles", async () => {
  const { actor, heard } = await start();
  await flush();
  actor.send(step(1));
  actor.send(step(2));
  actor.send({ type: "step.requested", direction: "undo" });
  actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  settle(actor, idOf(2), "applied");
  await flush();
  assert.deepEqual(of(heard, "step.undone").map((e) => e.id), [idOf(2), idOf(1)]);
});

test("nothing to undo or redo asks no one", async () => {
  const { actor, heard } = await start();
  await flush();
  actor.send({ type: "step.requested", direction: "undo" });
  actor.send({ type: "step.requested", direction: "redo" });
  await flush();
  assert.equal(of(heard, "step.undone").length + of(heard, "step.redone").length, 0);
});

test("a new step empties the redo list; replacing a step's redo does not", async () => {
  const { actor } = await start();
  await flush();
  actor.send(step(1));
  actor.send(step(2));
  actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  settle(actor, idOf(2), "applied");
  await flush();
  actor.send(step(1, { label: "step 1 typed on", redo: { n: 1, side: "later" } }));
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(1), label: "step 1 typed on" }, redo: { id: idOf(2), label: "step 2" } });
  actor.send(step(3));
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(3), label: "step 3" }, redo: null });
});

test("the same id coalesces: the first undo is kept, the last redo and label taken", async () => {
  const { actor, heard } = await start();
  await flush();
  actor.send(step(1, { undo: { text: "" }, redo: { text: "C" } }));
  actor.send(step(1, { undo: { text: "C" }, redo: { text: "Co" }, label: "edit Co" }));
  actor.send(step(1, { undo: { text: "Co" }, redo: { text: "Courage" }, label: "edit Courage" }));
  actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  assert.deepEqual(of(heard, "step.undone").at(-1).payload, { text: "" });
  settle(actor, idOf(1), "applied");
  actor.send({ type: "step.requested", direction: "redo" });
  await flush();
  assert.deepEqual(of(heard, "step.redone").at(-1).payload, { text: "Courage" });
  assert.equal((await read(actor)).redo.label, "edit Courage");
});

test("past 100 steps the oldest is dropped and its owner told with its redo", async () => {
  const { actor, heard, store } = await start();
  await flush();
  for (let n = 1; n <= MAX_STEPS + 2; n++) actor.send(step(n));
  await flush();
  assert.deepEqual(of(heard, "step.dropped"), [
    { type: "step.dropped", id: idOf(1), owner: "values", payload: { n: 1, side: "after" } },
    { type: "step.dropped", id: idOf(2), owner: "values", payload: { n: 2, side: "after" } },
  ]);
  assert.equal(store.rows.get(ADMIN).undo.length, MAX_STEPS);
  assert.equal(store.rows.get(ADMIN).undo[0].id, idOf(3));
});

test("each account has its own list, and signed out has one too", async () => {
  const store = memory({ [GUEST]: { undo: [{ ...step(7), type: undefined }], redo: [] } });
  const { actor, heard } = await start({ store, userId: null });
  await flush();
  actor.send(step(1));
  await flush();
  assert.equal((await read(actor)).undo.id, idOf(1));
  assert.ok(store.rows.has(""), "the signed-out steps are kept under their own key");

  // Leaving is only the news that the account is about to change.
  actor.send({ type: "session.changed", userId: GUEST, leaving: true });
  await flush();
  assert.equal((await read(actor)).undo.id, idOf(1));

  actor.send({ type: "session.changed", userId: GUEST });
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(7), label: "step 7" }, redo: null });
  assert.deepEqual(of(heard, "undo.changed").at(-1), { type: "undo.changed", undo: { id: idOf(7), label: "step 7" }, redo: null });

  actor.send({ type: "session.changed", userId: null });
  await flush();
  assert.equal((await read(actor)).undo.id, idOf(1));
});

test("Undo reads the list again first, so a step another tab undid is not undone twice", async () => {
  const store = memory();
  const clock = new SimulatedClock();
  const a = await start({ store, clock });
  const b = await start({ store, clock });
  await flush();
  a.actor.send(step(1));
  a.actor.send(step(2));
  await flush();
  b.actor.send({ type: "_reread" });
  await flush();
  assert.equal((await read(b.actor)).undo.id, idOf(2), "the other tab reads the step when told");

  b.actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  settle(b.actor, idOf(2), "applied");
  await flush();
  a.actor.send({ type: "step.requested", direction: "undo" });
  await flush();
  assert.deepEqual(of(a.heard, "step.undone").map((e) => e.id), [idOf(1)]);
});

test("steps recorded before the list is read are kept, and a damaged list reads as none", async () => {
  const store = memory({ [ADMIN]: { undo: [{ id: "nope" }, "x"], redo: 3 } });
  const { actor } = start({ store });
  actor.send(step(1));
  await flush();
  assert.deepEqual(await read(actor), { undo: { id: idOf(1), label: "step 1" }, redo: null });
});
