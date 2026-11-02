import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// session as an owner of steps (12, Undo): Can sync and a guest's Delete in People. The
// registry lives on the server, so the server here is a small fake that keeps the
// accounts and answers each gesture with the new list, as session/server/router.py does.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const GUEST = "a".repeat(32);

function server() {
  const rows = [
    { userId: "u1", name: "Admin", guest: false, admin: true, sync: false },
    { userId: GUEST, name: "Guest 3", guest: true, admin: false, deleted: false, purged: false },
  ];
  const calls = [];
  const list = () => ({ people: rows.filter((r) => !r.deleted).map(({ deleted, purged, ...r }) => r) });
  const find = (user) => rows.find((r) => r.userId === user);
  return {
    rows,
    calls,
    api: {
      me: async () => ({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }),
      people: async () => list(),
      allowSync: async (user, allowed) => {
        calls.push(["allowSync", user, allowed]);
        find(user).sync = allowed;
        return list();
      },
      forget: async (user) => {
        calls.push(["forget", user]);
        const r = find(user);
        if (!r || r.deleted) return { error: "changed" };
        r.deleted = true;
        return list();
      },
      restore: async (user) => {
        calls.push(["restore", user]);
        const r = find(user);
        if (!r?.deleted || r.purged) return { error: "changed" };
        r.deleted = false;
        return list();
      },
      purge: async (user) => {
        calls.push(["purge", user]);
        find(user).purged = true;
        return list();
      },
    },
  };
}

let n = 0;
const mint = () => "01K7STEP" + String((n += 1)).padStart(18, "0");

function start(srv) {
  const actor = createActor(machine, {
    input: {
      stored: JSON.stringify({ userId: "u1", registrationOpen: false, admin: true, name: "Admin" }),
      save: () => {},
      api: srv.api,
      mint,
    },
  });
  const steps = [];
  const settled = [];
  actor.on("step.recorded", (e) => {
    const { type: _, ...payload } = e;
    assert.ok(recordedSchema.validate(payload).valid, JSON.stringify(e));
    steps.push(payload);
  });
  actor.on("step.settled", (e) => {
    const { type: _, ...payload } = e;
    assert.ok(settledSchema.validate(payload).valid, JSON.stringify(e));
    settled.push(payload);
  });
  actor.start();
  return { actor, steps, settled };
}

const undo = async (actor, step) => {
  actor.send({ type: "step.undone", id: step.id, owner: "session", payload: step.undo });
  await flush();
};
const redo = async (actor, step) => {
  actor.send({ type: "step.redone", id: step.id, owner: "session", payload: step.redo });
  await flush();
};
const read = (actor) =>
  new Promise((resolve) => actor.send({ type: "people?", cid: "c1", payload: {}, reply: resolve }));

test("Can sync is one step, and Undo then Redo bring the switch back exactly", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  await read(actor);
  actor.send({ type: "sync.allowed", user: "u1", allowed: true });
  await flush();
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "turn Can sync on for Admin");
  assert.equal(steps[0].notice, undefined);
  await undo(actor, steps[0]);
  assert.equal(srv.rows[0].sync, false);
  await redo(actor, steps[0]);
  assert.equal(srv.rows[0].sync, true);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.equal(steps.length, 1, "an Undo or Redo records no step of its own");
});

test("Can sync is refused when the switch was changed since, on any device", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  await read(actor);
  actor.send({ type: "sync.allowed", user: "u1", allowed: true });
  await flush();
  srv.rows[0].sync = false;
  await undo(actor, steps[0]);
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "session", outcome: "refused", reason: "changed" });
  assert.deepEqual(srv.calls.filter((c) => c[0] === "allowSync").length, 1, "nothing written");
});

test("a guest's Delete is one step with the short notice; Undo brings it back, and its files go only when the step is dropped", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  const changed = [];
  actor.on("people.changed", (e) => changed.push(e.people.map((p) => p.userId)));
  await read(actor);
  actor.send({ type: "removal.settled", kind: "guest", id: GUEST });
  await flush();
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "delete account Guest 3");
  assert.equal(steps[0].notice, true);
  assert.deepEqual(changed.at(-1), ["u1"]);
  assert.ok(!srv.calls.some((c) => c[0] === "purge"), "nothing is purged while the step can be undone");

  await undo(actor, steps[0]);
  assert.equal(srv.rows[1].deleted, false);
  assert.deepEqual(changed.at(-1), ["u1", GUEST]);
  await redo(actor, steps[0]);
  assert.equal(srv.rows[1].deleted, true);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);

  // Another fact's dropped step, or one that is not a delete, purges nothing.
  actor.send({ type: "step.dropped", id: steps[0].id, owner: "notes", payload: steps[0].redo });
  actor.send({ type: "step.dropped", id: steps[0].id, owner: "session", payload: steps[0].undo });
  await flush();
  assert.ok(!srv.calls.some((c) => c[0] === "purge"));
  actor.send({ type: "step.dropped", id: steps[0].id, owner: "session", payload: steps[0].redo });
  await flush();
  assert.deepEqual(srv.calls.at(-1), ["purge", GUEST]);
});

test("a guest's Undo is refused once its files are gone", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  actor.send({ type: "removal.settled", kind: "guest", id: GUEST });
  await flush();
  srv.rows[1].purged = true;
  await undo(actor, steps[0]);
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "session", outcome: "refused", reason: "changed" });
});
