import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, SIGNED_OUT } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(resolve(HERE, "..", p), "utf8"));
const loadNdjson = (name) =>
  readFileSync(resolve(HERE, "fixtures", `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

// The schemas the machine's traffic must match (shape test, Testing). The session
// read schema is read from that component's directory, not imported, because a
// component may not import another's files.
const EVENTS = {
  "llm.changed": load("events/llm.changed.json"),
  "completion.progressed": load("events/completion.progressed.json"),
};
const READ = load("queries/read.json");
const COMPLETE = load("queries/complete.json");
const SESSION_READ = JSON.parse(readFileSync(resolve(HERE, "..", "..", "session", "queries", "read.json"), "utf8"));

// A valid ULID for the pending assistant turn (the complete id, and so the run id).
const TURN = "01HQ8ZK7M4N5P6Q7R8S9T0V1W2";
const USER_TURN = "01HQ8ZK7M4N5P6Q7R8S9T0V1W3";

const flush = () => new Promise((r) => setTimeout(r, 0));

// A signed-in picture as the server module returns it (without signedIn, which the
// machine adds): the account is on Echo, which needs no key.
const PICTURE = {
  provider: "echo",
  providers: [
    { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
    { id: "echo", label: "Echo", keySet: true, needsKey: false },
  ],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: ["default", "low", "medium", "high", "xhigh", "max"],
  ttl: "1h",
};
const completePayload = (over = {}) => ({
  id: TURN,
  start: "You help with books.",
  turns: [{ id: USER_TURN, role: "user", text: "hello" }],
  tools: [],
  ...over,
});

// Every message the machine emits or replies during the run, with the schema it
// must satisfy; the final test validates them all (Testing, shape test).
const recorded = [];
const see = (value, schema) => recorded.push({ value, schema });

function start({ userId = "u1", picture = PICTURE, save } = {}) {
  const calls = { read: 0, save: [] };
  const streamer = {};
  const input = {
    session: () => {
      see({}, SESSION_READ.payload);
      return Promise.resolve({ userId, registrationOpen: true });
    },
    read: () => {
      calls.read += 1;
      return Promise.resolve(picture);
    },
    save: (patch) => {
      calls.save.push(patch);
      return Promise.resolve(save ? save(patch) : picture);
    },
    stream: (request, onPiece) => {
      streamer.request = request;
      streamer.onPiece = onPiece;
      streamer.cancelled = false;
      return () => {
        streamer.cancelled = true;
      };
    },
  };
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input, clock });
  const emitted = [];
  for (const name of Object.keys(EVENTS))
    actor.on(name, (e) => {
      emitted.push(e);
      see(e, EVENTS[name]);
    });
  actor.start();
  return { actor, input, calls, streamer, clock, emitted };
}

const isReady = (actor) => actor.getSnapshot().matches({ account: "ready" });
async function ready(actor) {
  for (let i = 0; i < 50; i++) {
    if (isReady(actor)) return;
    await flush();
  }
  throw new Error("account never became ready");
}
async function until(pred) {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await flush();
  }
  throw new Error("condition never met");
}

// A query as the bus delivers it (4.2): the answerer calls reply once. read? is
// answered synchronously, complete? too, so the promise settles at once.
const query = (actor, name, payload, schema) =>
  new Promise((resolve) =>
    actor.send({
      type: name,
      cid: "cid",
      payload,
      reply: (value) => {
        see(value, schema);
        resolve(value);
      },
    }),
  );

// Drive a completion: reply with the id, then feed the fixture pieces with a gap
// wide enough that each emits its own progressed (the throttle window is 50 ms).
const progressed = (emitted) => emitted.filter((e) => e.type === "completion.progressed");
async function drive(h, pieces) {
  const reply = await query(h.actor, "complete?", completePayload(), COMPLETE.reply);
  assert.deepEqual(reply, { id: TURN });
  for (const piece of pieces) {
    h.streamer.onPiece(piece);
    await flush();
    h.clock.increment(60);
    await flush();
  }
}

test("read? answers the signed-in picture, adding signedIn", async () => {
  const h = start();
  await ready(h.actor);
  const reply = await query(h.actor, "read?", {}, READ.reply);
  assert.equal(reply.signedIn, true);
  assert.equal(reply.provider, "echo");
  assert.equal(reply.model, "echo");
});

test("read? sent while loading is held and answered once ready (4.2)", async () => {
  const h = start();
  const pending = query(h.actor, "read?", {}, READ.reply);
  await ready(h.actor);
  const reply = await pending;
  assert.equal(reply.signedIn, true);
});

test("signed out shows the signed-out picture without calling the server", async () => {
  const h = start({ userId: null });
  await ready(h.actor);
  const reply = await query(h.actor, "read?", {}, READ.reply);
  assert.deepEqual(reply, SIGNED_OUT);
  assert.equal(h.calls.read, 0, "no server read while signed out");
});

test("llm.edited saves the patch, adopts the fresh picture and announces; the key never enters context", async () => {
  const anthropic = {
    ...PICTURE,
    provider: "anthropic",
    providers: [
      { id: "anthropic", label: "Anthropic", keySet: true, needsKey: true },
      { id: "echo", label: "Echo", keySet: true, needsKey: false },
    ],
    model: "claude-opus-5",
    models: [{ id: "claude-opus-5", label: "Claude Opus 5" }],
  };
  const h = start({ save: () => anthropic });
  await ready(h.actor);
  h.actor.send({ type: "llm.edited", provider: "anthropic", key: "sk-secret-value" });
  await until(() => h.emitted.some((e) => e.type === "llm.changed"));
  assert.deepEqual(h.calls.save[0], { provider: "anthropic", key: "sk-secret-value" });
  const changed = h.emitted.filter((e) => e.type === "llm.changed").at(-1);
  assert.equal(changed.provider, "anthropic");
  assert.equal(changed.model, "claude-opus-5");
  assert.equal(changed.signedIn, true);
  assert.ok(
    !JSON.stringify(h.actor.getSnapshot().context).includes("sk-secret-value"),
    "the key is passed to the server and never kept in context",
  );
});

test("a plain answer streams the text and ends done with the usage", async () => {
  const h = start();
  await ready(h.actor);
  await drive(h, loadNdjson("plain"));
  const p = progressed(h.emitted);
  assert.equal(p[0].text, "A plain answ");
  const last = p.at(-1);
  assert.equal(last.done, true);
  assert.equal(last.status, "done");
  assert.equal(last.text, "A plain answer.");
  assert.equal(last.provider, "echo");
  assert.ok(last.usage.cache_read_input_tokens >= 0, "the end carries usage");
});

test("thinking accumulates alongside the text", async () => {
  const h = start();
  await ready(h.actor);
  await drive(h, loadNdjson("think"));
  const last = progressed(h.emitted).at(-1);
  assert.equal(last.thinking, "Considering the question and how to answer it…");
  assert.equal(last.status, "done");
});

test("a provider failure ends failed with the error", async () => {
  const h = start();
  await ready(h.actor);
  await drive(h, loadNdjson("fail"));
  const last = progressed(h.emitted).at(-1);
  assert.equal(last.done, true);
  assert.equal(last.status, "failed");
  assert.equal(last.error, "echo-failure");
});

test("stop announces a stopped end and cancels the stream", async () => {
  const h = start();
  await ready(h.actor);
  await drive(h, loadNdjson("slow-stopped"));
  h.actor.send({ type: "turn.steered", conversationId: "c", turnId: TURN, action: "stop" });
  await flush();
  const last = progressed(h.emitted).at(-1);
  assert.equal(last.done, true);
  assert.equal(last.status, "stopped");
  assert.equal(last.text, "/slow this answer arrives slowly so ");
  assert.ok(h.streamer.cancelled, "leaving running cancels the provider call");
});

test("a network failure ends failed unavailable, with no provider", async () => {
  const h = start();
  await ready(h.actor);
  const reply = await query(h.actor, "complete?", completePayload(), COMPLETE.reply);
  assert.deepEqual(reply, { id: TURN });
  h.streamer.onPiece({ type: "end", status: "failed", error: "unavailable" });
  await flush();
  const last = progressed(h.emitted).at(-1);
  assert.equal(last.status, "failed");
  assert.equal(last.error, "unavailable");
  assert.ok(!("provider" in last), "a network failure carries no provider");
});

test("complete? refuses honestly: signed-out, no-key and busy", async () => {
  const out = start({ userId: null });
  await ready(out.actor);
  assert.deepEqual(await query(out.actor, "complete?", completePayload(), COMPLETE.reply), { error: "signed-out" });

  const noKey = start({
    picture: {
      ...PICTURE,
      provider: "anthropic",
      providers: [
        { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
        { id: "echo", label: "Echo", keySet: true, needsKey: false },
      ],
      model: "",
      models: [],
    },
  });
  await ready(noKey.actor);
  assert.deepEqual(await query(noKey.actor, "complete?", completePayload(), COMPLETE.reply), { error: "no-key" });

  const busy = start();
  await ready(busy.actor);
  assert.deepEqual(await query(busy.actor, "complete?", completePayload(), COMPLETE.reply), { id: TURN });
  assert.deepEqual(await query(busy.actor, "complete?", completePayload(), COMPLETE.reply), { error: "busy" });
});

test("pieces within one 50 ms window coalesce into a single progressed", async () => {
  const h = start();
  await ready(h.actor);
  const reply = await query(h.actor, "complete?", completePayload(), COMPLETE.reply);
  assert.deepEqual(reply, { id: TURN });
  h.streamer.onPiece({ type: "text", text: "a" }); // settled → emits at once
  await flush();
  h.streamer.onPiece({ type: "text", text: "b" }); // coalescing → held
  h.streamer.onPiece({ type: "text", text: "c" }); // coalescing → held
  await flush();
  assert.equal(progressed(h.emitted).length, 1, "the first piece emits, the next two are held");
  assert.equal(progressed(h.emitted)[0].text, "a");
  h.clock.increment(50);
  await flush();
  const p = progressed(h.emitted);
  assert.equal(p.length, 2, "the window flushes what accumulated as one event");
  assert.equal(p[1].text, "abc");
});

// The seam fixtures session 5 replays into `conversations` (Testing): the exact
// completion.progressed events this machine emits for each recorded run. RECORD=1
// rewrites them from the machine; otherwise the committed files are checked to
// still be what it emits, so the two sides never drift.
async function progressedForRun(name, { stop = false } = {}) {
  const h = start();
  await ready(h.actor);
  await drive(h, loadNdjson(name));
  if (stop) {
    h.actor.send({ type: "turn.steered", conversationId: "c", turnId: TURN, action: "stop" });
    await flush();
  }
  return progressed(h.emitted);
}

test("the recorded progressed fixtures are what the machine emits (seam for session 5)", async () => {
  const runs = [
    ["plain", {}],
    ["think", {}],
    ["fail", {}],
    ["slow-stopped", { stop: true }],
  ];
  for (const [name, opts] of runs) {
    const events = await progressedForRun(name, opts);
    const file = resolve(HERE, "fixtures", `progressed-${name}.json`);
    if (process.env.RECORD === "1") {
      writeFileSync(file, JSON.stringify(events, null, 2) + "\n");
      continue;
    }
    assert.deepEqual(events, JSON.parse(readFileSync(file, "utf8")), `progressed-${name}.json is stale; re-run with RECORD=1`);
  }
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    // The bus validates an event without its `type` (schemas close the object and
    // never list `type`); replies and payloads carry none. Strip it either way.
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(
      result.valid,
      `${JSON.stringify(value).slice(0, 120)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`,
    );
  }
});
