import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// llm as an owner of steps (12, Undo): a change of a chat setting is one step whose undo
// and redo hold only the settings, and a change of a key is one step that holds no key. The
// server is a small fake that keeps the settings and answers each write with the picture,
// as llm/server/router.py does, and keeps the keys a step changed as keysteps.py does.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const MODELS = { echo: ["echo"], anthropic: ["claude-opus-5", "claude-haiku-5"] };

// The keys as keysteps.py keeps them: each saved key is a new object, as each save is a
// new ciphertext, and a step keeps the objects from before and after it, compared by
// identity as the server compares ciphertexts.
function keyStore() {
  const keys = new Map();
  const kept = new Map();
  const put = (provider, value, step) => {
    const before = keys.get(provider) ?? null;
    if (value === "") keys.delete(provider);
    else keys.set(provider, { value });
    const after = keys.get(provider) ?? null;
    if (step && before !== after) kept.set(step, [...(kept.get(step) ?? []), { provider, before, after }]);
  };
  const move = ({ step, restore, expect }) => {
    const rows = kept.get(step);
    if (!rows || rows.some((r) => (keys.get(r.provider) ?? null) !== r[expect])) return false;
    for (const r of rows) r[restore] ? keys.set(r.provider, r[restore]) : keys.delete(r.provider);
    return true;
  };
  return { keys, kept, put, move, value: (provider) => keys.get(provider)?.value ?? null };
}

function server() {
  const settings = { provider: "echo", model: "", effort: "default", ttl: "1h" };
  const store = keyStore();
  const keys = store.keys;
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
      jev: { keySet: keys.has("jev") },
    };
  };
  const writes = [];
  const forgot = [];
  return {
    settings,
    store,
    writes,
    forgot,
    picture,
    save: async (patch) => {
      writes.push(patch);
      if (patch.provider) settings.provider = patch.provider;
      for (const k of ["model", "effort", "ttl"]) if (k in patch) settings[k] = patch[k];
      if ("key" in patch) store.put(settings.provider, patch.key, patch.step);
      if ("jevKey" in patch) store.put("jev", patch.jevKey, patch.step);
      return picture();
    },
    moveKey: async (body) => {
      writes.push(body);
      return store.move(body) ? picture() : { error: "changed" };
    },
    forgetKey: async (step) => {
      forgot.push(step);
      store.kept.delete(step);
      return { ok: true };
    },
  };
}

function start(srv, extra = {}) {
  const input = {
    session: async () => ({ userId: "u1", registrationOpen: true }),
    read: async () => srv.picture(),
    save: srv.save,
    moveKey: srv.moveKey,
    forgetKey: srv.forgetKey,
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

test("adding, replacing and removing a key are one step each with the notice, and Undo then Redo bring the key back exactly", async () => {
  const srv = server();
  srv.settings.provider = "anthropic";
  const { actor, steps, settled } = start(srv);
  await flush();
  await edit(actor, { key: "sk-first-secret" });
  await edit(actor, { key: "sk-second-secret" });
  await edit(actor, { jevKey: "jev-third-secret" });
  await edit(actor, { key: "" });
  assert.deepEqual(
    steps.map((s) => [s.label, s.notice]),
    [
      ["add the API key", true],
      ["replace the API key", true],
      ["add the Jev key", true],
      ["remove the API key", true],
    ],
  );
  assert.deepEqual(steps[3].undo, { kind: "key", restore: "before", expect: "after" });
  assert.deepEqual(steps[3].redo, { kind: "key", restore: "after", expect: "before" });
  assert.equal(srv.store.value("anthropic"), null);
  await undo(actor, steps[3]);
  assert.equal(srv.store.value("anthropic"), "sk-second-secret", "Undo brings the removed key back");
  await undo(actor, steps[2]);
  assert.equal(srv.store.value("jev"), null, "Undo of an added key removes it");
  await undo(actor, steps[1]);
  assert.equal(srv.store.value("anthropic"), "sk-first-secret", "Undo of a replace brings the key before back");
  await redo(actor, steps[1]);
  await redo(actor, steps[2]);
  await redo(actor, steps[3]);
  assert.deepEqual([srv.store.value("anthropic"), srv.store.value("jev")], [null, "jev-third-secret"]);
  assert.equal(settled.length, 6);
  assert.ok(settled.every((s) => s.outcome === "applied"), JSON.stringify(settled));
  assert.equal(steps.length, 4, "an Undo or Redo records no step of its own");
  assert.ok(srv.writes.slice(4).every((w) => !("key" in w) && !("jevKey" in w)), "an Undo or Redo sends no key");
});

test("no key ever appears in a recorded step, a settled step or an announced picture", async () => {
  const srv = server();
  const { actor, steps, settled } = start(srv);
  const announced = [];
  actor.on("llm.changed", (e) => announced.push(e));
  await flush();
  await edit(actor, { key: "sk-never-in-a-step-1" });
  await edit(actor, { provider: "anthropic", key: "sk-never-in-a-step-2" });
  await edit(actor, { jevKey: "jev-never-in-a-step-3" });
  await edit(actor, { jevKey: "" });
  for (const step of [...steps].reverse()) await undo(actor, step);
  for (const step of steps) await redo(actor, step);
  assert.ok(steps.length >= 4);
  const seen = JSON.stringify([steps, settled, announced, actor.getSnapshot().context]);
  for (const key of ["sk-never-in-a-step-1", "sk-never-in-a-step-2", "jev-never-in-a-step-3", "never-in-a-step"])
    assert.ok(!seen.includes(key), `${key} stays out of every step`);
});

test("removing a key that is not there is no step", async () => {
  const srv = server();
  srv.settings.provider = "anthropic";
  const { actor, steps } = start(srv);
  await flush();
  await edit(actor, { key: "" });
  await edit(actor, { jevKey: "" });
  assert.equal(steps.length, 0);
});

test("a key step is refused when the key changed since, and its kept keys are erased once it leaves the undo list", async () => {
  const srv = server();
  srv.settings.provider = "anthropic";
  srv.store.put("anthropic", "sk-before-secret");
  const { actor, steps, settled } = start(srv);
  await flush();
  await edit(actor, { key: "" });
  // Another device saved a new key.
  srv.store.put("anthropic", "sk-other-device");
  await undo(actor, steps[0]);
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "llm", outcome: "refused", reason: "changed" });
  assert.equal(srv.store.value("anthropic"), "sk-other-device", "a refused step writes nothing");

  await edit(actor, { key: "sk-later-secret" });
  actor.send({ type: "step.dropped", id: steps[1].id, owner: "llm", payload: steps[1].redo });
  actor.send({ type: "step.dropped", id: steps[0].id, owner: "notes", payload: { kind: "key" } });
  await flush();
  assert.deepEqual(srv.forgot, [steps[1].id], "only llm's own key step is erased");
  assert.ok(!srv.store.kept.has(steps[1].id));
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
  const state = { guest: 1, allGuests: 10, providers: { jev: null, anthropic: null }, spent: { g1: 0.25 }, blocked: new Set(), stash: {}, keys: keyStore() };
  state.keys.put("jev", "guest-jev-secret");
  const summary = () => ({
    allGuests: { spent: Object.values(state.spent).reduce((a, b) => a + b, 0), limit: state.allGuests },
    guest: state.guest,
    providers: [
      { id: "jev", label: "Jev by typesafe.ai", spent: 0, limit: state.providers.jev, guestKeySet: state.keys.keys.has("jev"), price: "" },
      { id: "anthropic", label: "Anthropic", spent: 0, limit: state.providers.anthropic, guestKeySet: state.keys.keys.has("anthropic"), price: "" },
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
    if (what === "guestkeys") for (const id of ["jev", "anthropic"]) if (id in fields) state.keys.put(id, fields[id], fields.step);
    if (what === "guestkeys/step") return state.keys.move(fields) ? summary() : { error: "changed" };
    if (what === "guestkeys/forget") state.keys.kept.delete(fields.step);
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
  await edit(actor, { type: "guest.blocked", user: "g1", blocked: true, name: "Guest 12" });
  await edit(actor, { type: "use.reset", user: "g1", name: "Guest 12" });
  assert.deepEqual(
    steps.map((s) => [s.label, s.notice ?? false]),
    [
      ["change the limit for each guest", false],
      ["change the limit of Jev by typesafe.ai", false],
      ["block Guest 12", true],
      ["reset the use of Guest 12", true],
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

test("a Block or Reset use without the guest's name says a guest", async () => {
  const book = ledger();
  const { actor, steps } = startAdmin(book);
  await flush();
  await spendingRead(actor);
  await edit(actor, { type: "guest.blocked", user: "g1", blocked: true });
  await edit(actor, { type: "guest.blocked", user: "g1", blocked: false, name: "Guest 12" });
  await edit(actor, { type: "use.reset", user: "g1" });
  assert.deepEqual(steps.map((s) => s.label), ["block a guest", "unblock Guest 12", "reset the use of a guest"]);
});

test("a Reset use on a guest who spent nothing is no step", async () => {
  const book = ledger();
  book.state.spent.g2 = 0;
  const { actor, steps } = startAdmin(book);
  await flush();
  await spendingRead(actor);
  await edit(actor, { type: "use.reset", user: "g2" });
  assert.equal(steps.length, 0);
});

test("a guest key change is one step with the notice; Undo and Redo bring the key back, a change since refuses it, and leaving the list erases it", async () => {
  const book = ledger();
  const { actor, steps, settled } = startAdmin(book);
  await flush();
  await spendingRead(actor);
  await edit(actor, { type: "guestkeys.edited", jev: "" });
  await edit(actor, { type: "guestkeys.edited", anthropic: "guest-anthropic-secret" });
  assert.deepEqual(steps.map((s) => [s.label, s.notice]), [["remove the guest Jev key", true], ["add the guest Anthropic key", true]]);
  assert.ok(!JSON.stringify(steps).includes("secret"), "no guest key is part of a step");
  await undo(actor, steps[1]);
  await undo(actor, steps[0]);
  assert.deepEqual([book.state.keys.value("jev"), book.state.keys.value("anthropic")], ["guest-jev-secret", null]);
  await redo(actor, steps[0]);
  assert.equal(book.state.keys.value("jev"), null);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied", "applied"]);
  assert.ok(book.writes.filter(([what]) => what === "guestkeys/step").every(([, f]) => Object.keys(f).sort().join() === "expect,restore,step"));

  // Another device saved a Jev key: Undo of the removal is refused and writes nothing.
  book.state.keys.put("jev", "guest-other-device");
  await undo(actor, steps[0]);
  assert.deepEqual(settled.at(-1), { id: steps[0].id, owner: "llm", outcome: "refused", reason: "changed" });
  assert.equal(book.state.keys.value("jev"), "guest-other-device");

  actor.send({ type: "step.dropped", id: steps[1].id, owner: "llm", payload: steps[1].redo });
  await flush();
  assert.deepEqual(book.writes.at(-1), ["guestkeys/forget", { step: steps[1].id }]);
  assert.ok(!book.state.keys.kept.has(steps[1].id));
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
