import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, startText, inputState, pendingTurn, canContinue, retryText } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(resolve(HERE, "..", p), "utf8"));
const loadFixture = (name) => JSON.parse(readFileSync(resolve(HERE, "fixtures", `${name}.json`), "utf8"));
const other = (component, name) =>
  JSON.parse(readFileSync(resolve(HERE, "..", "..", component, "queries", `${name}.json`), "utf8"));

const SUBMITTED = load("events/turn.submitted.json");
const STEERED = load("events/turn.steered.json");
const OPEN = other("conversations", "open");
const READ = other("conversations", "read");
const SUBJECT = other("subject", "read");
const LLM = other("llm", "read");

const CHAT = "01HQ8ZK7M4N5P6Q7R8S9T0V1W4";
const ANSWER = "01HQ8ZK7M4N5P6Q7R8S9T0V1W2";
const USER = "01HQ8ZK7M4N5P6Q7R8S9T0V1W3";

const ECHO = {
  signedIn: true,
  provider: "echo",
  providers: [{ id: "echo", label: "Echo", keySet: true, needsKey: false }],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: [],
  ttl: "1h",
};
const SIGNED_OUT = { signedIn: false, provider: "", providers: [], model: "", models: [], effort: "default", efforts: [], ttl: "1h" };
const NEEDS_KEY = { ...ECHO, provider: "anthropic", providers: [{ id: "anthropic", label: "Anthropic", keySet: false, needsKey: true }] };

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(pred, label = "condition") {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await flush();
  }
  throw new Error(`${label} never met`);
}

const recorded = [];
const see = (value, schema) => recorded.push({ value, schema });

// Valid ULIDs from a counter (Crockford base32, the ULID alphabet), so a minted id
// matches ^[0-9A-HJKMNP-TV-Z]{26}$.
const mkMint = () => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = 0;
  return () => {
    const s = A[(n >> 5) & 31] + A[n & 31];
    n++;
    return "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
  };
};

function start(options = {}) {
  const { openId = null, subject = null, llm = ECHO, conversation = null } = options;
  const input = {
    mint: mkMint(),
    ask: (target, name, payload) => {
      const key = `${target}: ${name}`;
      if (key === "conversations: open") return see(payload, OPEN.payload), Promise.resolve({ id: openId });
      if (key === "conversations: read") return see(payload, READ.payload), Promise.resolve(conversation ? { conversation } : { error: "not-found" });
      if (key === "subject: read") return see(payload, SUBJECT.payload), Promise.resolve({ subject });
      if (key === "llm: read") return see(payload, LLM.payload), Promise.resolve(llm);
      throw new Error(`unexpected ask ${key}`);
    },
  };
  const actor = createActor(machine, { input });
  const emitted = [];
  actor.on("turn.submitted", (e) => (emitted.push(e), see(e, SUBMITTED)));
  actor.on("turn.steered", (e) => (emitted.push(e), see(e, STEERED)));
  actor.start();
  return { actor, emitted };
}

const ready = (h) => until(() => h.actor.getSnapshot().matches("ready"), "ready");
const emittedOf = (h, type) => h.emitted.filter((e) => e.type === type);

test("a new chat's first message carries the subject link and the start text", async () => {
  const h = start({ subject: { kind: "book", id: "b1", title: "A Book", view: "book-reader" } });
  await ready(h);
  h.actor.send({ type: "_send", text: "  what is this about?  " });
  await flush();
  const e = emittedOf(h, "turn.submitted").at(-1);
  assert.equal(e.turn.text, "what is this about?", "the text is trimmed");
  assert.deepEqual(e.about, [{ kind: "book", id: "b1" }]);
  assert.ok(e.start.startsWith("You are a thoughtful reading companion"));
  assert.ok(e.start.includes('The reader currently has open: book "A Book".'));
  assert.match(e.conversationId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("a new chat with no subject links to nothing", async () => {
  const h = start({ subject: null });
  await ready(h);
  h.actor.send({ type: "_send", text: "hello" });
  await flush();
  const e = emittedOf(h, "turn.submitted").at(-1);
  assert.deepEqual(e.about, []);
  assert.equal(e.start, startText(null));
});

test("a message to an existing chat carries no about or start", async () => {
  const conversation = { id: CHAT, title: "t", about: [], start: "s", turns: [{ id: USER, role: "user", text: "earlier" }], pending: false, updatedAt: 1 };
  const h = start({ openId: CHAT, conversation });
  await ready(h);
  h.actor.send({ type: "_send", text: "again" });
  await flush();
  const e = emittedOf(h, "turn.submitted").at(-1);
  assert.equal(e.conversationId, CHAT);
  assert.equal(e.about, undefined);
  assert.equal(e.start, undefined);
});

test("an empty draft sends nothing", async () => {
  const h = start();
  await ready(h);
  h.actor.send({ type: "_send", text: "   " });
  await flush();
  assert.equal(emittedOf(h, "turn.submitted").length, 0);
});

test("inputState disables with a line when signed out or the provider has no key", () => {
  assert.deepEqual(inputState(SIGNED_OUT), { disabled: true, notice: "Sign in to chat." });
  assert.deepEqual(inputState(NEEDS_KEY), { disabled: true, notice: "Add your API key in Settings." });
  assert.deepEqual(inputState(ECHO), { disabled: false, notice: null });
  assert.deepEqual(inputState(null), { disabled: true, notice: null }, "while loading, disabled with no line");
});

test("pendingTurn, canContinue and retryText read the seam fixtures (from session 5)", () => {
  const done = loadFixture("changed-done").at(-1);
  assert.equal(pendingTurn(done), null);
  assert.equal(canContinue(done), false);
  assert.equal(retryText(done), null, "a done answer is not something to try again");

  const failed = loadFixture("changed-failed").at(-1);
  assert.equal(retryText(failed), "hello", "a failed answer offers to resend the question before it");

  const stopped = loadFixture("changed-stopped").at(-1);
  assert.equal(retryText(stopped), null, "a stopped answer with text kept is not a Try again");

  const arriving = loadFixture("changed-done")[0]; // the pending event
  assert.ok(pendingTurn(arriving), "while the answer streams there is a pending turn");
});

test("Stop steers the pending answer", async () => {
  const conversation = { id: CHAT, title: "t", about: [], start: "s", pending: false, updatedAt: 1, turns: [
    { id: USER, role: "user", text: "hi" },
    { id: ANSWER, role: "assistant", text: "part", status: "pending" },
  ] };
  const h = start({ openId: CHAT, conversation });
  await ready(h);
  h.actor.send({ type: "_stop" });
  await flush();
  const e = emittedOf(h, "turn.steered").at(-1);
  assert.deepEqual(e, { type: "turn.steered", conversationId: CHAT, turnId: ANSWER, action: "stop" });
});

test("Continue steers a chat left at the reader's question", async () => {
  const conversation = { id: CHAT, title: "t", about: [], start: "s", pending: false, updatedAt: 1, turns: [{ id: USER, role: "user", text: "go on" }] };
  const h = start({ openId: CHAT, conversation });
  await ready(h);
  assert.equal(canContinue(conversation), true);
  h.actor.send({ type: "_continue" });
  await flush();
  const e = emittedOf(h, "turn.steered").at(-1);
  assert.deepEqual(e, { type: "turn.steered", conversationId: CHAT, turnId: USER, action: "continue" });
});

test("Try again resends the question, with no about or start", async () => {
  const conversation = { id: CHAT, title: "t", about: [], start: "s", pending: false, updatedAt: 1, turns: [
    { id: USER, role: "user", text: "the question" },
    { id: ANSWER, role: "assistant", text: "", status: "failed", error: "echo-failure" },
  ] };
  const h = start({ openId: CHAT, conversation });
  await ready(h);
  h.actor.send({ type: "_retry" });
  await flush();
  const e = emittedOf(h, "turn.submitted").at(-1);
  assert.equal(e.conversationId, CHAT);
  assert.equal(e.turn.text, "the question");
  assert.equal(e.about, undefined);
  assert.equal(e.start, undefined);
});

test("subject.changed changes what a new chat links to", async () => {
  const h = start({ subject: null });
  await ready(h);
  h.actor.send({ type: "subject.changed", subject: { kind: "book", id: "b2", title: "Next", view: "book-reader" } });
  await flush();
  h.actor.send({ type: "_send", text: "hi" });
  await flush();
  assert.deepEqual(emittedOf(h, "turn.submitted").at(-1).about, [{ kind: "book", id: "b2" }]);
});

test("llm.changed enables or disables the box", async () => {
  const h = start({ llm: SIGNED_OUT });
  await ready(h);
  assert.equal(inputState(h.actor.getSnapshot().context.llm).disabled, true);
  h.actor.send({ type: "llm.changed", ...ECHO });
  await flush();
  assert.equal(inputState(h.actor.getSnapshot().context.llm).disabled, false);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
