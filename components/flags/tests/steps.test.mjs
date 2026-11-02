import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// flags as an owner of steps (12, Undo): each Release or Show switch pressed is one step.
// Both live on the server, so the server is a small fake that keeps them and answers
// each switch with the picture, as flags/server/router.py does.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function server() {
  const state = { released: ["choice-points"], shown: ["choice-points", "undo"] };
  const picture = () => ({ off: [], hidden: [], released: [...state.released], shown: [...state.shown] });
  const saves = [];
  return {
    state,
    saves,
    load: async () => picture(),
    save: async (feature, on, column) => {
      saves.push([feature, on, column]);
      const key = column === "show" ? "shown" : "released";
      state[key] = on ? [...new Set([...state[key], feature])] : state[key].filter((f) => f !== feature);
      return picture();
    },
  };
}

let n = 0;
const mint = () => "01K7FEAG" + String((n += 1)).padStart(18, "0");

function start(srv) {
  const actor = createActor(machine, { input: { cached: null, load: srv.load, save: srv.save, mint } });
  const steps = [];
  const settled = [];
  actor.on("step.recorded", ({ type: _, ...payload }) => {
    assert.ok(recordedSchema.validate(payload).valid, JSON.stringify(payload));
    steps.push(payload);
  });
  actor.on("step.settled", ({ type: _, ...payload }) => {
    assert.ok(settledSchema.validate(payload).valid, JSON.stringify(payload));
    settled.push(payload);
  });
  actor.start();
  return { actor, steps, settled };
}

const undo = async (actor, step) => {
  actor.send({ type: "step.undone", id: step.id, owner: "flags", payload: step.undo });
  await flush();
};
const redo = async (actor, step) => {
  actor.send({ type: "step.redone", id: step.id, owner: "flags", payload: step.redo });
  await flush();
};

test("a Release and a Show switch are one step each, and Undo then Redo bring them back exactly", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  await flush();
  actor.send({ type: "flag.switched", feature: "undo", on: true, column: "release" });
  await flush();
  actor.send({ type: "flag.switched", feature: "choice-points", on: false, column: "show" });
  await flush();
  assert.deepEqual(steps.map((s) => s.label), ["release Undo", "hide Values and Choice Points"]);
  await undo(actor, steps[1]);
  await undo(actor, steps[0]);
  assert.deepEqual(srv.state, { released: ["choice-points"], shown: ["undo", "choice-points"] });
  await redo(actor, steps[0]);
  await redo(actor, steps[1]);
  assert.deepEqual(srv.state, { released: ["choice-points", "undo"], shown: ["undo"] });
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied", "applied", "applied"]);
  assert.equal(steps.length, 2, "an Undo or Redo records no step of its own");
});

test("a switch that is already where it is pressed to, or one that could not be saved, is no step", async () => {
  const srv = server();
  const { actor, steps } = start(srv);
  await flush();
  actor.send({ type: "flag.switched", feature: "choice-points", on: true });
  await flush();
  srv.save = async () => Promise.reject(new Error("offline"));
  const down = start(srv);
  await flush();
  down.actor.send({ type: "flag.switched", feature: "undo", on: true });
  await flush();
  assert.equal(steps.length + down.steps.length, 0);
});

test("a step is refused when the switch was changed since, on any device", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  await flush();
  actor.send({ type: "flag.switched", feature: "undo", on: true });
  await flush();
  // Another device held Undo back again, and this one read it.
  srv.state.released = ["choice-points"];
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  const saved = srv.saves.length;
  await undo(actor, steps[0]);
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "flags", outcome: "refused", reason: "changed" });
  assert.equal(srv.saves.length, saved, "nothing written");
});
