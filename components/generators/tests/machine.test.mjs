import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with a fake store, session ask and
// sync api, the shapes fact.js builds for real, and a simulated clock for the idle
// window the network waits for (generators/machine.js). Every announcement and reply is
// checked against its schema.
const SYNC_IDLE_MS = 2000;

const SOURCE = "a".repeat(64);
const SOURCE2 = "b".repeat(64);
const CHAT = "01ARZ3NDEKTSV4RRFFQ69G5CP1";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const generatorSchema = new Validator(schema("../events/generator.changed.json"), "2020-12");
const generationSchema = new Validator(schema("../events/generation.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");
const resultsReply = new Validator(schema("../queries/results.json").reply, "2020-12");
const editedSchema = new Validator(schema("../../generator-settings/events/generator.edited.json"), "2020-12");

const edited = (over = {}) => {
  const event = { id: "chat-title", ...over };
  assert.ok(editedSchema.validate(event).valid, JSON.stringify(event));
  return { type: "generator.edited", ...event };
};
const result = (over = {}) => ({ type: "_result", generator: "chat-title", item: CHAT, text: "Breakfast ideas", source: SOURCE, ...over });

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore(initial = [], outboxRows = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const outbox = new Map(outboxRows.map((r) => [r.id, r]));
  const meta = new Map();
  return {
    rows,
    outbox,
    meta,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

const askUser = (userId) => () => Promise.resolve({ userId, registrationOpen: false });

// The server as a fake: last write wins, versions assigned here.
function fakeApi({ pull } = {}) {
  const server = new Map();
  const puts = [];
  const pulls = [];
  return {
    server,
    puts,
    pulls,
    put: async (row) => {
      puts.push(row);
      const held = server.get(row.id);
      const { baseVersion, ...rest } = row;
      const r = { ...rest, version: held ? held.version + 1 : (baseVersion || 0) + 1 };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => {
      pulls.push(since);
      return pull ? pull(since) : { generators: [], results: [], cursor: since };
    },
  };
}

function start(store, { api, ask } = {}) {
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input: { store, api, ask }, clock });
  const generators = [];
  const results = [];
  actor.on("generator.changed", (e) => {
    assert.ok(generatorSchema.validate({ generator: e.generator }).valid, JSON.stringify(e));
    generators.push(e.generator);
  });
  actor.on("generation.changed", (e) => {
    assert.ok(generationSchema.validate({ result: e.result }).valid, JSON.stringify(e));
    results.push(e.result);
  });
  actor.start();
  return { actor, generators, results, clock };
}

async function ready(actor) {
  await new Promise((resolve) => {
    if (actor.getSnapshot().matches("ready")) return resolve();
    const sub = actor.subscribe((snap) => {
      if (snap.matches("ready")) {
        sub.unsubscribe();
        resolve();
      }
    });
  });
  await flush();
}

const list = (actor) =>
  new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply })).then((r) => {
    assert.ok(listReply.validate(r).valid, JSON.stringify(r));
    return r.generators;
  });
const resultsOf = (actor, generator) =>
  new Promise((reply) => actor.send({ type: "results?", cid: "c", payload: { generator }, reply })).then((r) => {
    assert.ok(resultsReply.validate(r).valid, JSON.stringify(r));
    return r.results;
  });

async function drain(clock) {
  clock.increment(SYNC_IDLE_MS);
  await flush();
}

// --- Signed out ------------------------------------------------------------------------

test("with nothing stored, list answers both generators at their approved defaults", async () => {
  const { actor } = start(fakeStore());
  await ready(actor);
  const generators = await list(actor);
  assert.deepEqual(generators.map((g) => [g.id, g.name, g.on, g.model, g.version]), [
    ["chat-title", "Chat title", true, "claude-haiku-5-5", 1],
    ["journal-summary", "Journal summary", true, "claude-haiku-5-5", 1],
  ]);
  assert.ok(generators[0].prompt.startsWith("Name this chat in 3 to 6 words"));
  assert.ok(generators[1].prompt.endsWith("No advice and no judgement."));
});

test("an edit carries only the fields changed, is kept and announced, and the same fields are no change", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, generators } = start(store, { api });
  await ready(actor);
  actor.send(edited({ prompt: "Three words." }));
  actor.send(edited({ on: false }));
  assert.deepEqual(generators.map((g) => [g.prompt, g.on, g.name, g.version]), [
    ["Three words.", true, "Chat title", 1],
    ["Three words.", false, "Chat title", 2],
  ]);
  actor.send(edited({ on: false }));
  actor.send(edited({ id: "journal-summary", name: "Journal summary" }));
  assert.equal(generators.length, 2, "nothing changed");
  assert.equal(store.rows.get("chat-title").on, false, "cached");
  assert.equal((await list(actor))[0].prompt, "Three words.");
  assert.equal(api.puts.length, 0, "signed out never calls the api");
});

test("a result is kept per generator and item, announced, and answered by results", async () => {
  const store = fakeStore();
  const { actor, results } = start(store);
  await ready(actor);
  actor.send(result());
  actor.send(result({ generator: "journal-summary", item: "2026-10-14", text: "A quiet day." }));
  actor.send(result({ text: "Breakfast ideas", source: SOURCE }));
  assert.equal(results.length, 2, "the same result again is no change");
  actor.send(result({ text: "Breakfast plans", source: SOURCE2 }));
  assert.deepEqual(results.at(-1), { id: `chat-title:${CHAT}`, generator: "chat-title", item: CHAT, text: "Breakfast plans", source: SOURCE2, version: 2 });
  assert.deepEqual((await resultsOf(actor, "chat-title")).map((r) => r.text), ["Breakfast plans"]);
  assert.deepEqual((await resultsOf(actor, "journal-summary")).map((r) => r.item), ["2026-10-14"]);
  actor.send(result({ source: "not hex" }));
  actor.send(result({ item: "" }));
  assert.equal(results.length, 3, "a malformed result is not kept");
});

test("an edit, a result or a query that lands while the store loads waits for it", async () => {
  let release;
  const stored = { id: "journal-summary:2026-10-13", generator: "journal-summary", item: "2026-10-13", text: "Kept", source: SOURCE, version: 1 };
  const store = fakeStore([{ id: "chat-title", name: "Titles", on: true, model: "claude-haiku-5-5", prompt: "P", version: 3 }, stored]);
  const all = store.all;
  const gate = new Promise((r) => (release = r));
  store.all = () => gate.then(() => all());
  const { actor, generators } = start(store);
  actor.send(edited({ model: "claude-sonnet-5" }));
  const answer = list(actor);
  const kept = resultsOf(actor, "journal-summary");
  release();
  await ready(actor);
  assert.deepEqual(generators.map((g) => [g.name, g.model, g.version]), [["Titles", "claude-sonnet-5", 4]]);
  assert.equal((await answer)[0].model, "claude-sonnet-5");
  assert.deepEqual((await kept).map((r) => r.text), ["Kept"]);
});

test("a store that rejects fails the fact: list answers the defaults and results nothing", async () => {
  const store = fakeStore();
  store.all = () => Promise.reject(new Error("no idb"));
  const { actor } = start(store);
  const answer = list(actor);
  await flush();
  assert.equal((await answer).length, 2);
  assert.deepEqual(await resultsOf(actor, "chat-title"), []);
});

// --- Signed in -------------------------------------------------------------------------

test("signed in: an edit waits out the idle window, then is acknowledged with the server's version", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, generators, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ prompt: "One" }));
  clock.increment(SYNC_IDLE_MS / 2);
  actor.send(edited({ prompt: "Two" }));
  assert.equal(store.outbox.get("chat-title").baseVersion, null, "a default has no base");
  clock.increment(SYNC_IDLE_MS / 2);
  await flush();
  assert.equal(api.puts.length, 0, "the window restarted");
  await drain(clock);
  assert.equal(api.puts.length, 1);
  assert.deepEqual(Object.keys(api.puts[0]).sort(), ["baseVersion", "id", "model", "name", "on", "prompt"]);
  assert.equal(api.puts[0].prompt, "Two");
  assert.deepEqual([generators.at(-1).prompt, generators.at(-1).version], ["Two", 1]);
  assert.equal(store.outbox.size, 0);
});

test("signed in: a result drains with its own fields", async () => {
  const api = fakeApi();
  const { actor, clock, results } = start(fakeStore(), { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(result());
  await drain(clock);
  assert.deepEqual(Object.keys(api.puts[0]).sort(), ["baseVersion", "generator", "id", "item", "source", "text"]);
  assert.equal(results.at(-1).version, 1);
});

test("signed in but offline: the row stays and is sent at the next focus", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const put = api.put;
  let offline = true;
  api.put = (row) => (offline ? Promise.reject(new Error("offline")) : put(row));
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ on: false }));
  await drain(clock);
  assert.equal(store.outbox.size, 1);
  offline = false;
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(store.outbox.size, 0);
});

test("signed in: a 401 drops the session and keeps the change", async () => {
  const store = fakeStore();
  const api = { put: async () => ({ error: "unauthorized" }), pull: async (since) => ({ generators: [], results: [], cursor: since }) };
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ on: false }));
  await drain(clock);
  assert.equal(store.meta.get("userId"), null);
  assert.equal(store.outbox.size, 1);
});

test("signed in: a pull adopts newer generators and results, announces them and advances the cursor", async () => {
  const store = fakeStore();
  const remote = { id: "journal-summary", name: "Days", on: false, model: "claude-haiku-5-5", prompt: "Short.", version: 2 };
  const written = { id: `chat-title:${CHAT}`, generator: "chat-title", item: CHAT, text: "From the phone", source: SOURCE, version: 1 };
  const api = fakeApi({ pull: () => ({ generators: [remote], results: [written], cursor: 7 }) });
  const { actor, generators, results } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.deepEqual(api.pulls, [0]);
  assert.deepEqual(generators, [remote]);
  assert.deepEqual(results, [written]);
  assert.equal((await list(actor))[1].name, "Days");
  assert.equal(store.meta.get("cursor"), 7);
});

test("a local change not yet sent wins over a pulled one", async () => {
  const store = fakeStore();
  const remote = { id: "chat-title", name: "Remote", on: true, model: "claude-haiku-5-5", prompt: "R", version: 5 };
  let first = true;
  const api = fakeApi({ pull: (since) => (first ? ((first = false), { generators: [], results: [], cursor: since }) : { generators: [remote], results: [], cursor: 2 }) });
  api.put = () => Promise.reject(new Error("offline"));
  const { actor, clock } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  actor.send(edited({ name: "Local" }));
  await drain(clock);
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await list(actor))[0].name, "Local");
});

test("a title the user types is kept as the chat's result with the source it had; an empty one is kept empty", async () => {
  const renamedSchema = new Validator(schema("../../conversation-list/events/conversation.renamed.json"), "2020-12");
  const renamed = (title, id = CHAT) => {
    assert.ok(renamedSchema.validate({ id, title }).valid);
    return { type: "conversation.renamed", id, title };
  };
  const { actor, results } = start(fakeStore());
  await ready(actor);
  actor.send(result());
  actor.send(renamed("  Herons  "));
  assert.deepEqual(results.at(-1), { id: "chat-title:" + CHAT, generator: "chat-title", item: CHAT, text: "Herons", source: SOURCE, version: 2 });
  actor.send(renamed(""));
  assert.deepEqual([results.at(-1).text, results.at(-1).source, results.at(-1).version], ["", SOURCE, 3]);
  const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
  actor.send(renamed("Before any title", OTHER));
  assert.equal(results.at(-1).text, "Before any title");
  assert.match(results.at(-1).source, /^[0-9a-f]{64}$/, "a chat not named yet still counts as named");
});

test("signed in: a typed title is uploaded, and an older generated title pulled later does not replace it", async () => {
  const store = fakeStore();
  const generated = { id: "chat-title:" + CHAT, generator: "chat-title", item: CHAT, text: "Generated", source: SOURCE, version: 1 };
  let pulled = [generated];
  const api = fakeApi({ pull: (since) => ({ generators: [], results: pulled, cursor: since + 1 }) });
  const { actor, clock, results } = start(store, { api, ask: askUser("u1") });
  await ready(actor);
  assert.equal(results.at(-1).text, "Generated");
  api.server.set(generated.id, generated);
  actor.send({ type: "conversation.renamed", id: CHAT, title: "Typed" });
  await drain(clock);
  assert.deepEqual([api.puts.at(-1).text, api.puts.at(-1).baseVersion, api.server.get(generated.id).version], ["Typed", 1, 2]);
  const announced = results.length;
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal(results.length, announced, "the older version is not adopted");
  assert.equal((await resultsOf(actor, "chat-title"))[0].text, "Typed");
  pulled = [api.server.get(generated.id)];
  actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await resultsOf(actor, "chat-title"))[0].text, "Typed");
});

test("sign-in uploads what was made signed out, with its history", async () => {
  const store = fakeStore();
  const api = fakeApi();
  const { actor, generators } = start(store, { api });
  await ready(actor);
  actor.send(edited({ prompt: "One" }));
  actor.send(edited({ prompt: "Two" }));
  actor.send(result());
  actor.send({ type: "session.changed", userId: "u1" });
  await flush();
  assert.deepEqual(api.puts.map((p) => [p.id, p.baseVersion]), [
    ["chat-title", 2],
    [`chat-title:${CHAT}`, 1],
  ]);
  assert.equal(api.server.get("chat-title").version, 3, "the server continues from the version minted signed out");
  assert.equal(generators.at(-1).version, 3);
  assert.equal(store.outbox.size, 0);
  assert.equal(store.meta.get("userId"), "u1");
});
