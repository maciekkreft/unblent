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

function start(srv, extra = {}) {
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
    ...extra,
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

// --- The admin's gestures about guests (12): limits, Block and Reset use ---

function ledger() {
  const state = { guest: 1, allGuests: 10, providers: { jev: null, anthropic: null }, spent: { g1: 0.25 }, blocked: new Set(), stash: {} };
  const summary = () => ({
    allGuests: { spent: Object.values(state.spent).reduce((a, b) => a + b, 0), limit: state.allGuests },
    guest: state.guest,
    providers: [
      { id: "jev", label: "Jev by typesafe.ai", spent: 0, limit: state.providers.jev, guestKeySet: true, price: "" },
      { id: "anthropic", label: "Anthropic", spent: 0, limit: state.providers.anthropic, guestKeySet: false, price: "" },
    ],
    guests: Object.entries(state.spent).map(([userId, spent]) => ({ userId, spent, blocked: state.blocked.has(userId) })),
  });
  const writes = [];
  const edit = async (what, fields) => {
    writes.push([what, fields]);
    if (what === "limits") {
      for (const k of ["guest", "allGuests"]) if (k in fields) state[k] = fields[k];
      Object.assign(state.providers, fields.providers ?? {});
    }
    if (what === "blocked") fields.blocked ? state.blocked.add(fields.user) : state.blocked.delete(fields.user);
    if (what === "reset" && fields.undone) {
      state.spent[fields.user] = (state.spent[fields.user] ?? 0) + (state.stash[fields.user] ?? 0);
      delete state.stash[fields.user];
    } else if (what === "reset") {
      state.stash[fields.user] = state.spent[fields.user];
      state.spent[fields.user] = 0;
    }
    return summary();
  };
  return { state, writes, spending: async () => summary(), edit };
}

function startAdmin(book) {
  const srv = server();
  const { actor, steps, settled } = start(srv, { spending: book.spending, edit: book.edit });
  return { actor, steps, settled };
}

const spendingRead = (actor) =>
  new Promise((resolve) => actor.send({ type: "spending?", cid: "s1", payload: {}, reply: resolve }));

test("a limit, a Block and a Reset use are one step each, and Undo then Redo bring them back exactly", async () => {
  const book = ledger();
  const { actor, steps, settled } = startAdmin(book);
  await flush();
  await spendingRead(actor);
  await edit(actor, { type: "limits.edited", guest: 2 });
  await edit(actor, { type: "limits.edited", providers: { jev: 0.5 } });
  await edit(actor, { type: "guest.blocked", user: "g1", blocked: true });
  await edit(actor, { type: "use.reset", user: "g1" });
  assert.deepEqual(
    steps.map((s) => [s.label, s.notice ?? false]),
    [
      ["change the limit for each guest", false],
      ["change the limit of Jev by typesafe.ai", false],
      ["block a guest", true],
      ["reset the use of a guest", true],
    ],
  );
  for (const step of [...steps].reverse()) await undo(actor, step);
  assert.deepEqual([book.state.guest, book.state.providers.jev, book.state.blocked.has("g1"), book.state.spent.g1], [1, null, false, 0.25]);
  for (const step of steps) await redo(actor, step);
  assert.deepEqual([book.state.guest, book.state.providers.jev, book.state.blocked.has("g1"), book.state.spent.g1], [2, 0.5, true, 0]);
  assert.equal(settled.length, 8);
  assert.ok(settled.every((s) => s.outcome === "applied"), JSON.stringify(settled));
  assert.equal(steps.length, 4, "an Undo or Redo records no step of its own");
  assert.ok(!book.writes.some(([what]) => what === "guestkeys"), "a guest key is never part of a step");
});

test("a guest key is no step, and neither is a Reset use on a guest who spent nothing", async () => {
  const book = ledger();
  book.state.spent.g2 = 0;
  const { actor, steps } = startAdmin(book);
  await flush();
  await spendingRead(actor);
  await edit(actor, { type: "guestkeys.edited", jev: "secret-guest-key" });
  await edit(actor, { type: "use.reset", user: "g2" });
  assert.equal(steps.length, 0);
});

test("a step of the admin's is refused when what guests spent changed since, and writes nothing", async () => {
  const book = ledger();
  const { actor, steps, settled } = startAdmin(book);
  await flush();
  await spendingRead(actor);
  await edit(actor, { type: "limits.edited", allGuests: 20 });
  await edit(actor, { type: "use.reset", user: "g1" });
  // The guest spent again, and another device changed the limit.
  book.state.spent.g1 = 0.01;
  book.state.allGuests = 30;
  const written = book.writes.length;
  await undo(actor, steps[1]);
  assert.deepEqual(settled.at(-1), { id: steps[1].id, owner: "llm", outcome: "refused", reason: "changed" });
  await undo(actor, steps[0]);
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "llm", outcome: "refused", reason: "changed" });
  assert.equal(book.writes.length, written);
});
