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
      pins: () => Promise.resolve({ note: null, chat: null, evaluators: null }),
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
