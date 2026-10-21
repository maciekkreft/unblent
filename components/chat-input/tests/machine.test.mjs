import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, draftKey, startText, inputState, pendingTurn, canContinue, retryText, sendable, canSend, sendLabel } from "../machine.js";

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
const SETTINGS = other("settings", "read");

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
  const { openId = null, subject = null, llm = ECHO, conversation = null, vimKeys = false } = options;
  const input = {
    mint: mkMint(),
    ask: (target, name, payload) => {
      const key = `${target}: ${name}`;
      if (key === "conversations: open") return see(payload, OPEN.payload), Promise.resolve({ id: openId });
      if (key === "conversations: read") return see(payload, READ.payload), Promise.resolve(conversation ? { conversation } : { error: "not-found" });
      if (key === "subject: read") return see(payload, SUBJECT.payload), Promise.resolve({ subject });
      if (key === "llm: read") return see(payload, LLM.payload), Promise.resolve(llm);
      if (key === "settings: read") return see(payload, SETTINGS.payload), Promise.resolve({ vimKeys });
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

test("the draft key names a chat with messages, else the subject a new chat is about, else none", () => {
  const book = { kind: "book", id: "B1", title: "Walden" };
  const started = { turns: [{ id: USER, role: "user", text: "hi" }] };
  assert.equal(draftKey({ openId: CHAT, conversation: started, subject: book }), "chat:" + CHAT);
  assert.equal(draftKey({ openId: CHAT, conversation: null, subject: book }), "new:book:B1", "a chat with no messages is new");
  assert.equal(draftKey({ openId: CHAT, reading: CHAT, conversation: null, subject: book }), null, "unknown while its read is in flight");
  assert.equal(draftKey({ openId: null, subject: book }), "new:book:B1");
  assert.equal(draftKey({ openId: null, subject: null }), "new:");
});

test("every deleted chat is listed for the view, and the open one closes", async () => {
  const h = start({ openId: CHAT });
  await ready(h);
  h.actor.send({ type: "conversation.deleted", id: ANSWER });
  assert.equal(h.actor.getSnapshot().context.openId, CHAT, "another chat's deletion leaves the open one");
  h.actor.send({ type: "conversation.deleted", id: CHAT });
  const { openId, deleted } = h.actor.getSnapshot().context;
  assert.equal(openId, null);
  assert.deepEqual(deleted, [ANSWER, CHAT]);
  h.actor.stop();
});

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

test("picking a chat with no messages asks the view to focus the box", async () => {
  const h = start();
  await ready(h);
  const before = h.actor.getSnapshot().context.focusRequest;
  h.actor.send({ type: "conversation.selected", id: CHAT });
  h.actor.send({ type: "conversation.opened", id: CHAT });
  await until(() => h.actor.getSnapshot().context.focusRequest === before + 1, "focus requested");
});

test("picking a chat with messages, or a subject change, leaves focus alone", async () => {
  const conversation = { id: CHAT, title: "t", about: [], start: "s", turns: [{ id: USER, role: "user", text: "earlier" }], pending: false, updatedAt: 1 };
  const h = start({ conversation });
  await ready(h);
  h.actor.send({ type: "conversation.opened", id: CHAT });
  await until(() => h.actor.getSnapshot().context.conversation != null, "read landed");
  h.actor.send({ type: "conversation.selected", id: CHAT });
  await flush();
  assert.equal(h.actor.getSnapshot().context.focusRequest, 0, "a chat with messages keeps focus where it is");

  const empty = start();
  await ready(empty);
  empty.actor.send({ type: "conversation.opened", id: CHAT });
  await flush();
  await flush();
  assert.equal(empty.actor.getSnapshot().context.focusRequest, 0, "an opened chat nobody picked moves nothing");
});

test("an empty draft sends nothing", async () => {
  const h = start();
  await ready(h);
  h.actor.send({ type: "_send", text: "   " });
  await flush();
  assert.equal(emittedOf(h, "turn.submitted").length, 0);
});

test("comments on the last answer can be sent with an empty box, and Send counts them", async () => {
  const MARK = "01HQ8ZK7M4N5P6Q7R8S9T0V1Y1";
  const mark = { id: MARK, start: 0, end: 2, quote: "An", comment: "Why?" };
  const turns = [{ id: USER, role: "user", text: "q" }, { id: ANSWER, role: "assistant", text: "An answer.", status: "done" }];
  const conversation = { id: CHAT, title: "t", about: [], start: "s", turns, pending: false, updatedAt: 1, marks: { answerId: ANSWER, marks: [mark] } };
  assert.equal(sendLabel(conversation), "Send 1 comment");
  assert.equal(sendLabel({ ...conversation, marks: { answerId: ANSWER, marks: [mark, { ...mark, id: "01HQ8ZK7M4N5P6Q7R8S9T0V1Y2" }] } }), "Send 2 comments");
  assert.equal(sendLabel({ ...conversation, marks: undefined }), "Send");
  assert.equal(canSend({ ...conversation, marks: { answerId: USER, marks: [mark] } }, ""), false, "comments on another turn do not count");

  const h = start({ openId: CHAT, conversation });
  await ready(h);
  h.actor.send({ type: "_send", text: "  " });
  await flush();
  const e = emittedOf(h, "turn.submitted").at(-1);
  assert.equal(e.conversationId, CHAT);
  assert.equal(e.turn.text, "", "the comments go alone");
});

test("an empty list item left at the end is not sent", async () => {
  assert.equal(sendable("- milk\n- eggs\n- "), "- milk\n- eggs");
  assert.equal(sendable("Buy:\n- milk\n  - "), "Buy:\n- milk");
  assert.equal(sendable("- "), "");
  assert.equal(sendable("a - b"), "a - b");
  const h = start();
  await ready(h);
  h.actor.send({ type: "_send", text: "- " });
  await flush();
  assert.equal(emittedOf(h, "turn.submitted").length, 0);
});

test("inputState disables with a line when signed out or the provider has no key", () => {
  assert.deepEqual(inputState(SIGNED_OUT), { disabled: true, notice: "Sign in to chat." });
  assert.deepEqual(inputState(NEEDS_KEY), { disabled: true, notice: "Add your API key in Settings." });
  assert.deepEqual(inputState(ECHO), { disabled: false, notice: null });
  assert.deepEqual(inputState(null), { disabled: true, notice: null }, "while loading, disabled with no line");
});

test("pendingTurn, canContinue and retryText read the seam fixtures", () => {
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

test("Continue is offered when a done answer left lookups unrun (case b, 7.7)", () => {
  // A reload or a Stop during a round leaves the chat at a done answer carrying calls but
  // no results: Continue runs that round (the lookups only read, so it is harmless).
  const withUnrunCalls = {
    id: CHAT, title: "t", about: [], start: "s", pending: false, updatedAt: 1,
    turns: [
      { id: USER, role: "user", text: "hi" },
      { id: ANSWER, role: "assistant", text: "", status: "done", calls: [{ id: "c1", target: "books", name: "chapter", payload: {}, label: "Reading a chapter" }] },
    ],
  };
  assert.equal(canContinue(withUnrunCalls), true);
});

test("the tool exchange seam ends without a Continue (a plain final answer)", () => {
  const events = loadFixture("changed-tools");
  assert.ok(pendingTurn(events[0]), "a pending answer while the round runs keeps Send as Stop");
  const last = events.at(-1);
  assert.equal(pendingTurn(last), null);
  assert.equal(canContinue(last), false, "a finished answer with no unrun calls is not a Continue");
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

test("events that arrive while starting are not lost: a new chat links to the book", async () => {
  // The review's experiment: subject:read answers null and llm:read stays open, so the
  // machine sits in `starting`. The book (subject.changed) and the open chat
  // (conversation.opened) arrive as events during that wait. They must not be dropped,
  // and the start actor's late reply must not overwrite them.
  const CHAT2 = "01HQ8ZK7M4N5P6Q7R8S9T0V1WZ";
  let releaseLlm;
  const llmReady = new Promise((r) => (releaseLlm = r));
  const input = {
    mint: mkMint(),
    ask: (target, name, payload) => {
      const key = `${target}: ${name}`;
      if (key === "conversations: open") return see(payload, OPEN.payload), Promise.resolve({ id: null });
      if (key === "conversations: read") return see(payload, READ.payload), Promise.resolve({ error: "not-found" });
      if (key === "subject: read") return see(payload, SUBJECT.payload), Promise.resolve({ subject: null });
      if (key === "llm: read") return see(payload, LLM.payload), llmReady.then(() => ECHO);
      if (key === "settings: read") return see(payload, SETTINGS.payload), Promise.resolve({ vimKeys: false });
      throw new Error(`unexpected ask ${key}`);
    },
  };
  const actor = createActor(machine, { input });
  const emitted = [];
  actor.on("turn.submitted", (e) => (emitted.push(e), see(e, SUBMITTED)));
  actor.start();
  await flush(); // open and subject have replied; llm is still open, so it is `starting`
  assert.ok(!actor.getSnapshot().matches("ready"), "still starting while llm: read waits");
  actor.send({ type: "subject.changed", subject: { kind: "book", id: "b9", title: "Deep Book", view: "book-reader" } });
  actor.send({ type: "conversation.opened", id: CHAT2 });
  await flush();
  releaseLlm();
  await until(() => actor.getSnapshot().matches("ready"), "ready");
  await flush(); // let the opened read settle
  actor.send({ type: "_send", text: "hi" });
  await flush();
  const e = emitted.at(-1);
  assert.equal(e.conversationId, CHAT2, "the message goes to the chat opened while starting");
  assert.deepEqual(e.about, [{ kind: "book", id: "b9" }], "the new chat links to the book the event carried");
  assert.ok(e.start.includes('The reader currently has open: book "Deep Book".'), "the start text names the book");
});

test("llm.changed enables or disables the box", async () => {
  const h = start({ llm: SIGNED_OUT });
  await ready(h);
  assert.equal(inputState(h.actor.getSnapshot().context.llm).disabled, true);
  h.actor.send({ type: "llm.changed", ...ECHO });
  await flush();
  assert.equal(inputState(h.actor.getSnapshot().context.llm).disabled, false);
});

test("the settings read sets vimKeys, and settings.changed follows", async () => {
  const h = start({ vimKeys: true });
  await ready(h);
  assert.equal(h.actor.getSnapshot().context.vimKeys, true, "the read turns it on");
  h.actor.send({ type: "settings.changed", vimKeys: false });
  await flush();
  assert.equal(h.actor.getSnapshot().context.vimKeys, false, "a change turns it off");
  h.actor.send({ type: "settings.changed", vimKeys: true });
  await flush();
  assert.equal(h.actor.getSnapshot().context.vimKeys, true, "and back on");
});

test("vimKeys is off when settings answers nothing or omits it", async () => {
  const h = start(); // vimKeys defaults to false in the read reply
  await ready(h);
  assert.equal(h.actor.getSnapshot().context.vimKeys, false, "missing means off (a page without a value)");
  h.actor.send({ type: "settings.changed" }); // no vimKeys field
  await flush();
  assert.equal(h.actor.getSnapshot().context.vimKeys, false, "a change without the field is off");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`);
  }
});

// Text or a link copied in the reader goes into Vim's register (one per page), so p
// pastes it here, in any state.
test("a copied text or link goes into Vim's register", () => {
  const pushed = [];
  const actor = createActor(machine, {
    input: { ask: () => Promise.resolve({ error: "no-answerer" }), mint: () => "01K7TEST0000000000000T0001", pushRegister: (text) => pushed.push(text) },
  }).start();
  actor.send({ type: "text.copied", text: "One.\n\nTwo." });
  actor.send({ type: "link.copied", id: "01K7TEST0000000000000H0001", text: "[q](note:01K7TEST0000000000000H0001)" });
  assert.deepEqual(pushed, ["One.\n\nTwo.", "[q](note:01K7TEST0000000000000H0001)"]);
  actor.stop();
});
