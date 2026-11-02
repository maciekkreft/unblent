import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// llm as an owner of steps (12, Undo): a change of a chat setting is one step whose undo
// and redo hold only the settings, never a key. The server is a small fake that keeps the
// settings and answers each write with the picture, as llm/server/router.py does.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const MODELS = { echo: ["echo"], anthropic: ["claude-opus-5", "claude-haiku-5"] };

function server() {
  const settings = { provider: "echo", model: "", effort: "default", ttl: "1h" };
  const keys = new Set();
  const picture = () => {
    const models = MODELS[settings.provider];
    return {
      provider: settings.provider,
      providers: [
        { id: "anthropic", label: "Anthropic", keySet: keys.has("anthropic"), needsKey: true },
        { id: "echo", label: "Echo", keySet: true, needsKey: false },
      ],
      model: models.includes(settings.model) ? settings.model : models[0],
      models: models.map((id) => ({ id, label: id })),
      effort: settings.effort,
      efforts: ["default", "low", "high"],
      ttl: settings.ttl,
    };
  };
  const writes = [];
  return {
    settings,
    writes,
    picture,
    save: async (patch) => {
      writes.push(patch);
      if (patch.provider) settings.provider = patch.provider;
      for (const k of ["model", "effort", "ttl"]) if (k in patch) settings[k] = patch[k];
      if (patch.key) keys.add(settings.provider);
      return picture();
    },
  };
}

function start(srv) {
  const input = {
    session: async () => ({ userId: "u1", registrationOpen: true }),
    read: async () => srv.picture(),
    save: srv.save,
    stream: () => () => {},
    guest: async () => ({ error: "not-a-try-page" }),
    decide: async () => ({ answers: [] }),
    generate: async () => ({ text: "" }),
    spending: async () => ({ error: "not-admin" }),
    edit: async () => ({ error: "not-admin" }),
  };
  const actor = createActor(machine, { input });
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

const edit = async (actor, patch) => {
  actor.send({ type: "llm.edited", ...patch });
  await flush();
};
const undo = async (actor, step) => {
  actor.send({ type: "step.undone", id: step.id, owner: "llm", payload: step.undo });
  await flush();
};
const redo = async (actor, step) => {
  actor.send({ type: "step.redone", id: step.id, owner: "llm", payload: step.redo });
  await flush();
};

test("a model change is one step, and Undo then Redo bring the settings back exactly", async () => {
  const srv = server();
  srv.settings.provider = "anthropic";
  const { actor, steps, settled } = start(srv);
  await flush();
  await edit(actor, { model: "claude-haiku-5" });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "choose the model claude-haiku-5");
  assert.deepEqual(steps[0].undo.fields, { model: "claude-opus-5" });
  await undo(actor, steps[0]);
  assert.equal(srv.picture().model, "claude-opus-5");
  await redo(actor, steps[0]);
  assert.equal(srv.picture().model, "claude-haiku-5");
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.equal(steps.length, 1, "an Undo or Redo records no step of its own");
});

test("a provider change brings its model back with it, and several steps undo in a row", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  await flush();
  await edit(actor, { provider: "anthropic" });
  await edit(actor, { effort: "high" });
  assert.deepEqual(steps[0].undo.fields, { provider: "echo", model: "echo" });
  await undo(actor, steps[1]);
  await undo(actor, steps[0]);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.equal(srv.picture().provider, "echo");
  assert.equal(srv.picture().effort, "default");
});

test("a key is never part of a step, and a key alone is no step", async () => {
  const srv = server();
  const { actor, steps } = start(srv);
  await flush();
  await edit(actor, { key: "sk-secret-value" });
  assert.equal(steps.length, 0);
  await edit(actor, { provider: "anthropic", key: "sk-other-secret" });
  assert.equal(steps.length, 1);
  assert.ok(!JSON.stringify(steps).includes("secret"));
  await undo(actor, steps[0]);
  assert.ok(srv.writes.at(-1).key === undefined && srv.writes.at(-1).jevKey === undefined, "an Undo sends no key");
});

test("a step is refused when the settings were changed since, on any device", async () => {
  const srv = server();
  srv.settings.provider = "anthropic";
  const { actor, steps, settled } = start(srv);
  await flush();
  await edit(actor, { model: "claude-haiku-5" });
  // Another device chose a model, and this one learnt of it.
  srv.settings.model = "claude-opus-5";
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  await undo(actor, steps[0]);
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "llm", outcome: "refused", reason: "changed" });
});
