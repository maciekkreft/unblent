import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): chat-thread with `conversations` and conversation-list, real machines on
// the real bus. The server is faked. Picking a row in the list is a gesture the list turns
// into conversation.selected; `conversations` opens that chat and the thread shows it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const chat = (k, text) => ({
  id: U("C" + k),
  title: text,
  about: [],
  start: "",
  turns: [
    { id: U("Q" + k), role: "user", text },
    { id: U("A" + k), role: "assistant", text, status: "done" },
  ],
  pending: false,
  updatedAt: Number(k),
});

test("picking an older chat in the list switches the thread to it", async () => {
  const server = new Map([chat("1", "first message"), chat("2", "second message")].map((c) => [c.id, c]));
  let open = U("C2");
  const { actors, unwire } = await wire(["conversations", "conversation-list", "chat-thread"], {
    conversations: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: false }),
      subject: () => Promise.resolve({ subject: null }),
      settings: () => Promise.resolve({}),
      complete: (request) => Promise.resolve({ id: request.id }),
      contracts: () => Promise.resolve({ queries: [] }),
      askTool: () => Promise.resolve({}),
      list: () =>
        Promise.resolve({
          conversations: [...server.values()].map(({ id, title, about, updatedAt, turns }) => ({ id, title, about, updatedAt, pending: false, answer: turns.at(-1).text })),
          tools: { tools: {}, approval: "auto" },
        }),
      read: (id) => (server.has(id) ? Promise.resolve(structuredClone(server.get(id))) : Promise.reject(new Error("404"))),
      saveChat: () => Promise.resolve({ updatedAt: 900 }),
      deleteChat: () => Promise.resolve(),
      saveTools: () => Promise.resolve(),
      store: { read: () => open, write: (id) => (open = id) },
      ulid: () => U("ZZ"),
      now: () => 1000,
    },
    "conversation-list": { mint: () => U("D0"), undoMs: 20, following: false },
  });
  const shown = () => actors["chat-thread"].getSnapshot().context.conversation?.id;
  try {
    await until(() => shown() === U("C2"));
    await until(() => actors["conversation-list"].getSnapshot().context.chats.length === 2);
    actors["conversation-list"].send({ type: "_pick", id: U("C1") });
    await until(() => shown() === U("C1"));
    assert.equal(actors["chat-thread"].getSnapshot().context.conversation.turns.at(-1).text, "first message");
    assert.equal(open, U("C1"), "the open chat is remembered for the next load");
  } finally {
    unwire();
  }
});

// A link followed in the open chat's lookup keeps that chat when the subject changes to
// what it opened (12); a follow to what is already in front leaves nothing behind, so a
// later change follows the stage again.
test("following a lookup's link keeps the chat, and only for the change to what it opened", async () => {
  const BOOK = (k) => U("B" + k);
  const about = (k) => [{ kind: "book", id: BOOK(k) }];
  const server = new Map(
    [
      { ...chat("1", "about book one"), about: about("1") },
      { ...chat("2", "about book two"), about: about("2") },
      { ...chat("3", "about book three"), about: about("3") },
    ].map((c) => [c.id, c]),
  );
  let open = U("C1");
  const { actors, unwire } = await wire(["conversations", "chat-thread"], {
    conversations: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: false }),
      subject: () => Promise.resolve({ subject: { kind: "book", id: BOOK("1"), title: "One" } }),
      settings: () => Promise.resolve({ keepOpen: false }),
      complete: (request) => Promise.resolve({ id: request.id }),
      contracts: () => Promise.resolve({ queries: [] }),
      askTool: () => Promise.resolve({}),
      list: () =>
        Promise.resolve({
          conversations: [...server.values()].map(({ id, title, about, updatedAt, turns }) => ({ id, title, about, updatedAt, pending: false, answer: turns.at(-1).text })),
          tools: { tools: {}, approval: "auto" },
        }),
      read: (id) => (server.has(id) ? Promise.resolve(structuredClone(server.get(id))) : Promise.reject(new Error("404"))),
      saveChat: () => Promise.resolve({ updatedAt: 900 }),
      deleteChat: () => Promise.resolve(),
      saveTools: () => Promise.resolve(),
      store: { read: () => open, write: (id) => (open = id) },
      ulid: () => U("ZZ"),
      now: () => 1000,
    },
  });
  const subject = (k) => actors.conversations.send({ type: "subject.changed", subject: { kind: "book", id: BOOK(k), title: k } });
  const shown = () => actors["chat-thread"].getSnapshot().context.conversation?.id;
  try {
    await until(() => shown() === U("C1"));
    actors["chat-thread"].send({ type: "_open", opens: "chapter", id: BOOK("2"), chapter: 1 });
    subject("2");
    assert.equal(open, U("C1"), "the chat the link was in stays open");
    // A follow to the book already in front: no subject change follows it.
    actors["chat-thread"].send({ type: "_open", opens: "chapter", id: BOOK("2"), chapter: 0 });
    subject("3");
    await until(() => open === U("C3"));
    // Without a follow the open chat follows the stage, as before.
    subject("2");
    await until(() => open === U("C2"));
    // Where you are in it opens the book as the shelf does, and the chat stays for it too.
    actors["chat-thread"].send({ type: "_open", opens: "book", id: BOOK("1") });
    subject("1");
    assert.equal(open, U("C2"), "the chat stays for the book the link opened");
  } finally {
    unwire();
  }
});
