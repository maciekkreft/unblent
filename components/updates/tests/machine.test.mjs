import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The switch lives on the Mac's server, so the server is a small fake that keeps it and
// answers each read and write, as updates/server/router.py does.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const SCHEMAS = {
  "updates.changed": schema("../events/updates.changed.json"),
  "step.recorded": schema("../events/step.recorded.json"),
  "step.settled": schema("../events/step.settled.json"),
};
const replySchema = new Validator(JSON.parse(readFileSync(new URL("../queries/read.json", import.meta.url))).reply, "2020-12");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let n = 0;
const mint = () => "01K7APDT" + String((n += 1)).padStart(18, "0");

function server({ web = false } = {}) {
  const state = { test: false, down: false };
  const answer = () => (web || state.down ? Promise.reject(new Error("404")) : Promise.resolve({ test: state.test }));
  return {
    state,
    load: answer,
    save: async (test) => {
      if (web || state.down) throw new Error("404");
      state.test = test;
      return { test };
    },
  };
}

function start(srv) {
  const actor = createActor(machine, { input: { load: srv.load, save: srv.save, mint } });
  const seen = { "updates.changed": [], "step.recorded": [], "step.settled": [] };
  for (const name of Object.keys(seen))
    actor.on(name, ({ type: _, ...payload }) => {
      assert.ok(SCHEMAS[name].validate(payload).valid, `${name} ${JSON.stringify(payload)}`);
      seen[name].push(payload);
    });
  actor.start();
  const read = async () => {
    let value;
    actor.send({ type: "read?", cid: "c", payload: {}, reply: (v) => (value = v) });
    await flush();
    assert.ok(replySchema.validate(value).valid, JSON.stringify(value));
    return value;
  };
  return { actor, seen, read };
}

test("the website answers read with an error, so no switch is shown", async () => {
  const { read, seen } = start(server({ web: true }));
  assert.deepEqual(await read(), { error: "unavailable" });
  assert.deepEqual(seen["updates.changed"], []);
});

test("a read is the starting picture and announces nothing", async () => {
  const { read, seen } = start(server());
  assert.deepEqual(await read(), { test: false });
  assert.deepEqual(seen["updates.changed"], []);
});

test("the switch is one step, and Undo then Redo bring it back exactly", async () => {
  const srv = server();
  const { actor, read, seen } = start(srv);
  await read();
  actor.send({ type: "updates.edited", test: true });
  await flush();
  assert.equal(srv.state.test, true);
  assert.deepEqual(seen["updates.changed"], [{ test: true }]);
  const [step] = seen["step.recorded"];
  assert.equal(step.label, "turn on Beta releases");
  actor.send({ type: "step.undone", id: step.id, owner: "updates", payload: step.undo });
  await flush();
  assert.equal(srv.state.test, false);
  actor.send({ type: "step.redone", id: step.id, owner: "updates", payload: step.redo });
  await flush();
  assert.equal(srv.state.test, true);
  assert.deepEqual(seen["step.settled"].map((s) => s.outcome), ["applied", "applied"]);
  assert.equal(seen["step.recorded"].length, 1, "Undo and Redo record no new step");
});

test("an Undo is refused when the switch was changed since", async () => {
  const srv = server();
  const { actor, read, seen } = start(srv);
  await read();
  actor.send({ type: "updates.edited", test: true });
  await flush();
  const [step] = seen["step.recorded"];
  // Another tab turned it off again; this tab's read learns it.
  srv.state.test = false;
  await read();
  assert.deepEqual(seen["updates.changed"].at(-1), { test: false }, "a read that finds a change says so");
  actor.send({ type: "step.undone", id: step.id, owner: "updates", payload: step.undo });
  await flush();
  assert.deepEqual(seen["step.settled"].at(-1), { id: step.id, owner: "updates", outcome: "refused", reason: "changed" });
});

test("a switch that cannot be saved changes nothing and announces the saved state again", async () => {
  const srv = server();
  const { actor, read, seen } = start(srv);
  await read();
  srv.state.down = true;
  actor.send({ type: "updates.edited", test: true });
  await flush();
  assert.deepEqual(seen["updates.changed"], [{ test: false }]);
  assert.deepEqual(seen["step.recorded"], []);
});

test("steps of another owner are left alone", async () => {
  const { actor, read, seen } = start(server());
  await read();
  actor.send({ type: "step.undone", id: mint(), owner: "flags", payload: {} });
  await flush();
  assert.deepEqual(seen["step.settled"], []);
});
