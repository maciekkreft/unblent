import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): chat-input with its partners, real machines on the real bus — `subject`
// (what a new chat is about) and `conversations` (which keeps the chat and its links).
// The server and what `subject` reads of `books` and `dock` are faked; the book open on
// the account is the one `books: open` names at start, as on the product after a load.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { pendingTurn, canContinue } = await import("../machine.js");

const BOOK = "01HQ8ZK7M4N5P6Q7R8S9T0V1W6";

const stage = (target, name, payload) => {
  if (target === "dock") return Promise.resolve({ stage: null, docks: {} });
  if (target === "books" && name === "open") return Promise.resolve({ id: BOOK });
  if (target === "books" && name === "read") return Promise.resolve({ book: { id: payload.id, title: "Sample Book" } });
  return Promise.resolve({});
};

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const minter = (prefix) => {
  let n = 0;
  return () => prefix + B32[(n >> 5) & 31] + B32[n++ & 31];
};

test("a new chat is linked to the open book", async () => {
  const saved = [];
  const { actors, unwire } = await wire(["subject", "chat-input", "conversations"], {
    subject: { ask: stage },
    "chat-input": { mint: minter("01HQ8ZK7M4N5P6Q7R8S9T0V1") },
    conversations: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: false }),
      subject: () => Promise.resolve({ subject: null }),
      pins: () => Promise.resolve({ note: null, chat: null, evaluators: null }),
      complete: (request) => Promise.resolve({ id: request.id }),
      contracts: () => Promise.resolve({ queries: [] }),
      askTool: () => Promise.resolve({}),
      list: () => Promise.resolve({ conversations: [], tools: { tools: {}, approval: "auto" } }),
      read: () => Promise.reject(new Error("404")),
      saveChat: (id, body) => (saved.push({ id, body }), Promise.resolve({ updatedAt: 900 })),
      deleteChat: () => Promise.resolve(),
      saveTools: () => Promise.resolve(),
      store: { read: () => null, write: () => {} },
      ulid: minter("01HQ8ZK7M4N5P6Q7R8S9T0V2"),
      now: () => 1000,
    },
  });
  try {
    // The subject has settled on the open book, and chat-input has learned it.
    await until(() => actors["chat-input"].getSnapshot().context.subject?.id === BOOK);
    actors["chat-input"].send({ type: "_send", text: "about this book" });
    await until(() => saved.length > 0);
    const chat = saved.at(-1).body;
    assert.deepEqual(chat.about, [{ kind: "book", id: BOOK }], "the new chat is linked to the open book");
    assert.ok(chat.start.includes('"Sample Book"'), "its start names the book");
  } finally {
    unwire();
  }
});

// A page reloaded while an answer is arriving: only finished turns go to the server (5),
// so the chat the reload reads ends at the question, and chat-input then offers Continue,
// which asks the model again. The server is a fake that keeps what is saved, turn by id.
test("a reload mid-answer ends at the question with Continue", async () => {
  const server = new Map();
  const saveChat = (id, body) => {
    const chat = server.get(id) ?? { id, title: body.title, about: body.about, start: body.start, turns: [], updatedAt: 900 };
    for (const turn of body.turns) if (!chat.turns.some((t) => t.id === turn.id)) chat.turns.push(turn);
    server.set(id, chat);
    return Promise.resolve({ updatedAt: 900 });
  };
  let open = null;
  const completes = [];
  const conversations = (ulid) => ({
    session: () => Promise.resolve({ userId: "u1", registrationOpen: false }),
    subject: () => Promise.resolve({ subject: null }),
    pins: () => Promise.resolve({ note: null, chat: null, evaluators: null }),
    complete: (request) => (completes.push(request), Promise.resolve({ id: request.id })),
    contracts: () => Promise.resolve({ queries: [] }),
    askTool: () => Promise.resolve({}),
    list: () => Promise.resolve({ conversations: [...server.values()].map(({ id, title, about, updatedAt }) => ({ id, title, about, updatedAt })), tools: { tools: {}, approval: "auto" } }),
    read: (id) => (server.has(id) ? Promise.resolve(structuredClone(server.get(id))) : Promise.reject(new Error("404"))),
    saveChat,
    deleteChat: () => Promise.resolve(),
    saveTools: () => Promise.resolve(),
    store: { read: () => open, write: (id) => (open = id) },
    ulid,
    now: () => 1000,
  });
  const inputs = (ulid) => ({
    subject: { ask: stage },
    "chat-input": { mint: minter("01HQ8ZK7M4N5P6Q7R8S9T0V1") },
    conversations: conversations(ulid),
  });

  const before = await wire(["subject", "chat-input", "conversations"], inputs(minter("01HQ8ZK7M4N5P6Q7R8S9T0V2")));
  try {
    await until(() => before.actors["chat-input"].getSnapshot().context.subject?.id === BOOK);
    before.actors["chat-input"].send({ type: "_send", text: "a long question" });
    await until(() => completes.length === 1 && server.size === 1);
    const answer = completes[0].id;
    // Part of the answer has arrived, then the page goes away.
    before.actors.conversations.send({ type: "completion.progressed", id: answer, text: "a long answer that is", calls: [], done: false });
    await until(() => before.actors["chat-input"].getSnapshot().context.conversation?.turns.at(-1)?.text === "a long answer that is");
  } finally {
    before.unwire();
  }
  const [saved] = server.values();
  assert.deepEqual(saved.turns.map((t) => t.role), ["user"], "only the question is on the server");

  // Facts before views, in the order a page loads them, so chat-input's first ask finds conversations.
  const after = await wire(["subject", "conversations", "chat-input"], inputs(minter("01HQ8ZK7M4N5P6Q7R8S9T0V4")));
  try {
    const input = after.actors["chat-input"];
    await until(() => input.getSnapshot().context.conversation?.id === saved.id);
    const conversation = input.getSnapshot().context.conversation;
    assert.equal(conversation.turns.at(-1).role, "user", "the reloaded chat ends at the question");
    assert.equal(pendingTurn(conversation), null, "the in-progress answer was not kept");
    assert.equal(canContinue(conversation), true, "Continue is offered");
    input.send({ type: "_continue" });
    await until(() => completes.length === 2);
    assert.deepEqual(completes[1].turns.map((t) => t.text), ["a long question"], "Continue asks the model again from the question");
  } finally {
    after.unwire();
  }
});
