import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): conversation-list with `conversations`, real machines on the real bus.
// The server is faked. A first visit starts signed out (this browser holds no session
// yet) and learns who it is a moment later, from session.changed, delivered to both as
// the bus delivers it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const heading = (k) => ({ id: U("C" + k), title: "chat " + k, about: [], updatedAt: Number(k), pending: false, answer: "answer " + k });

test("a first visit lists the account's chats once the session is known", async () => {
  let userId = null;
  const { actors, unwire } = await wire(["conversations", "conversation-list"], {
    conversations: {
      session: () => Promise.resolve({ userId, registrationOpen: false }),
      subject: () => Promise.resolve({ subject: null }),
      pins: () => Promise.resolve({ note: null, chat: null, evaluators: null }),
      complete: (request) => Promise.resolve({ id: request.id }),
      contracts: () => Promise.resolve({ queries: [] }),
      askTool: () => Promise.resolve({}),
      list: () => Promise.resolve({ conversations: [heading("2"), heading("1")], tools: { tools: {}, approval: "auto" } }),
      read: () => Promise.reject(new Error("404")),
      saveChat: () => Promise.resolve({ updatedAt: 900 }),
      deleteChat: () => Promise.resolve(),
      saveTools: () => Promise.resolve(),
      store: { read: () => null, write: () => {} },
      ulid: () => U("ZZ"),
      now: () => 1000,
    },
    "conversation-list": { mint: () => U("D0"), undoMs: 20, following: false },
  });
  const rows = () => actors["conversation-list"].getSnapshot().context.chats;
  try {
    await until(() => actors.conversations.getSnapshot().matches("ready"));
    assert.deepEqual(rows(), [], "signed out, nothing is listed");
    userId = "u1";
    const changed = { type: "session.changed", userId, registrationOpen: false };
    actors.conversations.send(changed);
    actors["conversation-list"].send(changed);
    await until(() => rows().length === 2);
    assert.deepEqual(rows().map((r) => r.title), ["chat 2", "chat 1"]);
    assert.deepEqual(rows().map((r) => r.subtitle), ["answer 2", "answer 1"], "each with its answer's first line");
  } finally {
    unwire();
  }
});
