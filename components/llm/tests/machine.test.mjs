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
  "spending.changed": load("events/spending.changed.json"),
};
const SPENDING = load("queries/spending.json");
const READ = load("queries/read.json");
const COMPLETE = load("queries/complete.json");
const DECIDE = load("queries/decide.json");
const GENERATE = load("queries/generate.json");
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

function start({ userId = "u1", picture = PICTURE, save, decide, generate, guest, spending, edit } = {}) {
  const calls = { read: 0, save: [], decide: [], generate: [], guest: 0, edit: [] };
  const streamer = {};
  const input = {
    session: () => {
      see({}, SESSION_READ.payload);
      return Promise.resolve({ userId, registrationOpen: true });
    },
    read: () => {
      calls.read += 1;
      return Promise.resolve(typeof picture === "function" ? picture(calls.read) : picture);
    },
    spending: () => Promise.resolve(spending ? spending() : { error: "not-admin" }),
    edit: (what, fields) => {
      calls.edit.push([what, fields]);
      return Promise.resolve(edit ? edit(what, fields) : { error: "not-admin" });
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
  // Outside a try page session refuses to make a guest (session: guest).
  input.guest = () => {
    calls.guest += 1;
    return Promise.resolve(guest ? guest() : { error: "not-a-try-page" });
  };
  input.decide = (payload) => {
    calls.decide.push(payload);
    return decide ? decide(payload) : Promise.resolve({ answers: [], inputTokens: 0, ms: 0 });
  };
  input.generate = (payload) => {
    calls.generate.push(payload);
    return generate ? generate(payload) : Promise.resolve({ text: "Echo: hello" });
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

test("a fast steady stream keeps flushing, each event holding the whole text so far", async () => {
  const h = start();
  await ready(h.actor);
  const reply = await query(h.actor, "complete?", completePayload(), COMPLETE.reply);
  assert.deepEqual(reply, { id: TURN });
  // 30 pieces 12 ms apart, faster than the 50 ms window: a throttle that re-arms only
  // through an `after` on the state would emit once and then stall until the end. The
  // self-re-raised _flush timer keeps firing, so several events land while the answer
  // is still arriving.
  let expected = "";
  for (let i = 0; i < 30; i++) {
    const ch = String.fromCharCode(97 + (i % 26));
    expected += ch;
    h.streamer.onPiece({ type: "text", text: ch });
    await flush();
    h.clock.increment(12);
    await flush();
  }
  const p = progressed(h.emitted);
  assert.ok(p.length >= 6, `a fast stream flushes repeatedly; got ${p.length} progressed events`);
  for (const e of p) assert.ok(expected.startsWith(e.text), `each event holds the whole text so far, not "${e.text}"`);
  assert.ok(p.length >= 2 && p.at(-1).text.length > p[0].text.length, "later events carry more text than the first");
});

// The seam fixtures `conversations` replays (Testing): the exact
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

test("the recorded progressed fixtures are what the machine emits (seam for conversations)", async () => {
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

const DECISION = { state: { post: "hello" }, questions: [{ id: "a/b", instructions: "Is it a greeting?", yes: "it greets", no: "it does not" }] };
const withJev = { ...PICTURE, jev: { keySet: true } };

test("decide? passes the payload to the server and replies its answers", async () => {
  const answer = { answers: [{ id: "a/b", p: 0.9 }], inputTokens: 120, ms: 310 };
  const h = start({ picture: withJev, decide: () => Promise.resolve(answer) });
  await ready(h.actor);
  assert.deepEqual(await query(h.actor, "decide?", DECISION, DECIDE.reply), answer);
  assert.deepEqual(h.calls.decide, [DECISION]);
});

test("decide? refuses honestly: signed-out, no-key and busy; a failure is unavailable", async () => {
  const out = start({ userId: null });
  await ready(out.actor);
  assert.deepEqual(await query(out.actor, "decide?", DECISION, DECIDE.reply), { error: "signed-out" });

  const noKey = start();
  await ready(noKey.actor);
  assert.deepEqual(await query(noKey.actor, "decide?", DECISION, DECIDE.reply), { error: "no-key" });
  assert.equal(noKey.calls.decide.length, 0, "nothing is sent without a key");

  let finish;
  const busy = start({ picture: withJev, decide: () => new Promise((r) => (finish = r)) });
  await ready(busy.actor);
  const first = query(busy.actor, "decide?", DECISION, DECIDE.reply);
  assert.deepEqual(await query(busy.actor, "decide?", DECISION, DECIDE.reply), { error: "busy" });
  finish({ error: "rate-limited" });
  assert.deepEqual(await first, { error: "rate-limited" }, "the server's error rides the reply");

  const broken = start({ picture: withJev, decide: () => Promise.reject(new Error("offline")) });
  await ready(broken.actor);
  assert.deepEqual(await query(broken.actor, "decide?", DECISION, DECIDE.reply), { error: "unavailable" });
});

test("decide? signed out on a try page makes the guest, then asks the server as that guest", async () => {
  const h = start({
    userId: null,
    guest: () => ({ userId: "g1", registrationOpen: true, guest: true, name: "Guest 1" }),
    decide: () => Promise.resolve({ error: "no-key" }),
  });
  await ready(h.actor);
  assert.deepEqual(await query(h.actor, "decide?", DECISION, DECIDE.reply), { error: "no-key" });
  assert.equal(h.calls.guest, 1, "the first Run makes the guest");
  assert.deepEqual(h.calls.decide, [DECISION], "the request goes on to the server as the guest");

  const away = start({ userId: null, guest: () => ({ error: "unavailable" }) });
  await ready(away.actor);
  assert.deepEqual(await query(away.actor, "decide?", DECISION, DECIDE.reply), { error: "unavailable" });
  assert.equal(away.calls.decide.length, 0, "no guest, nothing sent");
});

test("llm.edited carries the Jev key through to the server and never into context", async () => {
  const h = start({ save: () => withJev });
  await ready(h.actor);
  h.actor.send({ type: "llm.edited", jevKey: "jev-secret-value" });
  await until(() => h.emitted.some((e) => e.type === "llm.changed"));
  assert.deepEqual(h.calls.save[0], { jevKey: "jev-secret-value" });
  assert.deepEqual(h.emitted.filter((e) => e.type === "llm.changed").at(-1).jev, { keySet: true });
  assert.ok(!JSON.stringify(h.actor.getSnapshot().context).includes("jev-secret-value"));
});

const WANTED = { model: "echo", prompt: "Name this chat.", text: "First message:\nhello" };

test("generate? passes the payload to the server and replies its text", async () => {
  const h = start({ generate: () => Promise.resolve({ text: "A greeting" }) });
  await ready(h.actor);
  see(WANTED, GENERATE.payload);
  assert.deepEqual(await query(h.actor, "generate?", WANTED, GENERATE.reply), { text: "A greeting" });
  assert.deepEqual(h.calls.generate, [WANTED]);
});

test("generate? asked before the picture is read still reaches the server, which decides", async () => {
  const h = start({ userId: null, generate: () => Promise.resolve({ error: "signed-out" }) });
  assert.deepEqual(await query(h.actor, "generate?", WANTED, GENERATE.reply), { error: "signed-out" });
  assert.equal(h.calls.generate.length, 1);
  assert.equal(h.calls.guest, 0, "a generator never makes a guest");
});

test("generate? is busy while one runs, and a failure is unavailable", async () => {
  let finish;
  const h = start({ generate: () => (finish ? Promise.resolve({ text: "Again" }) : new Promise((r) => (finish = r))) });
  await ready(h.actor);
  const first = query(h.actor, "generate?", WANTED, GENERATE.reply);
  assert.deepEqual(await query(h.actor, "generate?", WANTED, GENERATE.reply), { error: "busy" });
  assert.equal(h.calls.generate.length, 1, "the second is not sent");
  finish({ error: "no-key" });
  assert.deepEqual(await first, { error: "no-key" }, "the server's error rides the reply");
  assert.deepEqual(await query(h.actor, "generate?", WANTED, GENERATE.reply), { text: "Again" }, "free again");

  const broken = start({ generate: () => Promise.reject(new Error("offline")) });
  await ready(broken.actor);
  assert.deepEqual(await query(broken.actor, "generate?", WANTED, GENERATE.reply), { error: "unavailable" });
});

test("a generation runs beside a chat answer, and a chat answer beside a generation", async () => {
  let finish;
  const h = start({ generate: () => new Promise((r) => (finish = r)) });
  await ready(h.actor);
  const generating = query(h.actor, "generate?", WANTED, GENERATE.reply);
  assert.deepEqual(await query(h.actor, "complete?", completePayload(), COMPLETE.reply), { id: TURN });
  h.streamer.onPiece({ type: "text", text: "Hi" });
  h.streamer.onPiece({ type: "end", status: "done", raw: [{ type: "text", text: "Hi" }], provider: "echo", model: "echo", usage: {} });
  await flush();
  assert.ok(h.actor.getSnapshot().matches({ completion: "idle", generation: "running" }));
  finish({ text: "Hello" });
  assert.deepEqual(await generating, { text: "Hello" });
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

// A guest's picture as the server returns it (7.7): only providers with a guest key,
// the guest Jev key, and freeUse.
const guestPicture = (freeUse, jev = true) => ({
  ...PICTURE,
  providers: [{ id: "echo", label: "Echo", keySet: true, needsKey: false }],
  jev: { keySet: jev },
  freeUse,
});
const SPENT = {
  allGuests: { spent: 0.5, limit: 10 },
  guest: 1,
  providers: [
    { id: "jev", label: "Jev by typesafe.ai", spent: 0.5, limit: null, guestKeySet: true, price: "$42 per billion tokens read" },
    { id: "anthropic", label: "Anthropic", spent: 0, limit: null, guestKeySet: false, price: "Each model's published price per million tokens" },
  ],
  guests: [{ userId: "g1", spent: 0.5, blocked: false }],
};

test("a guest's decide? is refused from the picture: blocked, used-up, paused, or no guest Jev key", async () => {
  const cases = [
    [{ left: 0.5, blocked: true, paused: [] }, true, "blocked"],
    [{ left: 0, blocked: false, paused: [] }, true, "used-up"],
    [{ left: 0.5, blocked: false, paused: ["jev"] }, true, "paused"],
    [{ left: 0.5, blocked: false, paused: [] }, false, "paused"],
  ];
  for (const [freeUse, jev, error] of cases) {
    const h = start({ userId: "g1", picture: guestPicture(freeUse, jev) });
    await ready(h.actor);
    assert.deepEqual(await query(h.actor, "decide?", DECISION, DECIDE.reply), { error });
    assert.equal(h.calls.decide.length, 0, `${error}: nothing is sent`);
  }
});

test("after a guest's decide the picture is read again and announced, so the bar goes down", async () => {
  const h = start({
    userId: "g1",
    picture: (n) => guestPicture({ left: n === 1 ? 1 : 0.9, blocked: false, paused: [] }),
    decide: () => Promise.resolve({ answers: [{ id: "q", p: 0.5 }], inputTokens: 100, ms: 3 }),
  });
  await ready(h.actor);
  await query(h.actor, "decide?", DECISION, DECIDE.reply);
  await until(() => h.emitted.some((e) => e.type === "llm.changed" && e.freeUse?.left === 0.9));
  assert.equal(h.calls.read, 2);

  // An account's own decide changes nothing it reads.
  const own = start({ picture: { ...PICTURE, jev: { keySet: true } } });
  await ready(own.actor);
  await query(own.actor, "decide?", DECISION, DECIDE.reply);
  await flush();
  assert.equal(own.calls.read, 1);
});

test("a guest's complete? is refused from the picture, except on Echo", async () => {
  const h = start({ userId: "g1", picture: { ...guestPicture({ left: 0, blocked: false, paused: [] }), provider: "anthropic" } });
  await ready(h.actor);
  assert.deepEqual(await query(h.actor, "complete?", completePayload(), COMPLETE.reply), { error: "used-up" });
  const echo = start({ userId: "g2", picture: guestPicture({ left: 0, blocked: false, paused: [] }) });
  await ready(echo.actor);
  assert.deepEqual(await query(echo.actor, "complete?", completePayload(), COMPLETE.reply), { id: TURN });
});

test("spending? answers what the server says; an admin's edit replies and announces spending.changed", async () => {
  const h = start({ spending: () => SPENT, edit: (what, fields) => ({ ...SPENT, guest: fields.guest ?? 1 }) });
  await ready(h.actor);
  assert.deepEqual(await query(h.actor, "spending?", {}, SPENDING.reply), SPENT);
  h.actor.send({ type: "limits.edited", guest: 2 });
  h.actor.send({ type: "guestkeys.edited", jev: "secret" });
  await until(() => h.emitted.some((e) => e.type === "spending.changed"));
  assert.deepEqual(h.calls.edit, [["limits", { guest: 2 }], ["guestkeys", { jev: "secret" }]]);
  assert.deepEqual(h.emitted.filter((e) => e.type === "spending.changed").at(-1), { type: "spending.changed", ...SPENT }, "the answer to the last gesture is announced");
  assert.ok(!JSON.stringify(h.actor.getSnapshot().context).includes("secret"), "a guest key never enters context");

  const someone = start();
  await ready(someone.actor);
  assert.deepEqual(await query(someone.actor, "spending?", {}, SPENDING.reply), { error: "not-admin" });
});

test("Block, Unblock, Reset use and its Undo reach the server and announce what guests spent (12)", async () => {
  const h = start({ spending: () => SPENT, edit: () => SPENT });
  await ready(h.actor);
  h.actor.send({ type: "guest.blocked", user: "g1", blocked: true });
  await until(() => h.calls.edit.length === 1);
  h.actor.send({ type: "use.reset", user: "g1" });
  await until(() => h.calls.edit.length === 2);
  h.actor.send({ type: "use.reset", user: "g1", undone: true });
  await until(() => h.calls.edit.length === 3);
  h.actor.send({ type: "guest.blocked", user: "g1", blocked: false });
  await until(() => h.calls.edit.length === 4);
  assert.deepEqual(h.calls.edit, [
    ["blocked", { user: "g1", blocked: true }],
    ["reset", { user: "g1" }],
    ["reset", { user: "g1", undone: true }],
    ["blocked", { user: "g1", blocked: false }],
  ]);
  await until(() => h.emitted.filter((e) => e.type === "spending.changed").length >= 1);

  // A guest's Delete, once settled, forgets what it spent; any other removal passes by.
  h.actor.send({ type: "removal.settled", kind: "evaluator", id: "01K7TEST00000000000000EV00" });
  h.actor.send({ type: "removal.settled", kind: "guest", id: "g1" });
  await until(() => h.calls.edit.length === 5);
  assert.deepEqual(h.calls.edit.at(-1), ["forget", { user: "g1" }]);
});

// S8: a guest key saved while Administration was reading what guests spent was lost.
test("an admin's edit made while what guests spent is being read still reaches the server", async () => {
  let answer;
  const h = start({ spending: () => new Promise((r) => (answer = r)), edit: () => SPENT });
  await ready(h.actor);
  const held = query(h.actor, "spending?", {}, SPENDING.reply);
  assert.equal(h.actor.getSnapshot().value.spending, "reading");
  h.actor.send({ type: "guestkeys.edited", jev: "secret" });
  await until(() => h.calls.edit.length === 1);
  assert.deepEqual(h.calls.edit, [["guestkeys", { jev: "secret" }]]);
  assert.deepEqual(await held, SPENT, "the held asker gets the picture after the edit");
  answer?.({ error: "unavailable" });
});
