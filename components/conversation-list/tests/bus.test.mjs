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
      settings: () => Promise.resolve({}),
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
    "conversation-list": { mint: () => U("D0"), following: false },
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

// A cut row placed with p reaches `conversations` as conversation.moved, which saves the
// place alone; a cut deleted when the keyboard leaves the list goes at once, and the corner
// notice's Undo, through `undo`, brings it back with a restore write (12, Vim keys; 12, Undo).
test("a move goes through conversations, and a cut deleted on leaving comes back with the notice's Undo", async () => {
  const saved = [];
  const deleted = [];
  const restored = [];
  const rows = new Map();
  const undoStore = { read: async (account) => rows.get(account), write: async (account, lists) => void rows.set(account, structuredClone(lists)) };
  const { actors, records, unwire } = await wire(["conversations", "conversation-list", "notice-stack", "undo"], {
    conversations: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: false }),
      subject: () => Promise.resolve({ subject: null }),
      settings: () => Promise.resolve({}),
      complete: (request) => Promise.resolve({ id: request.id }),
      contracts: () => Promise.resolve({ queries: [] }),
      askTool: () => Promise.resolve({}),
      list: () => Promise.resolve({ conversations: [heading("3"), heading("2"), heading("1")], tools: { tools: {}, approval: "auto" } }),
      read: (id) => Promise.resolve({ ...heading(id.slice(-1)), id, start: "", turns: [] }),
      saveChat: (id, body) => {
        saved.push({ id, body });
        return Promise.resolve({ updatedAt: 900 });
      },
      deleteChat: (id) => {
        deleted.push(id);
        return Promise.resolve();
      },
      restoreChat: (id) => {
        restored.push(id);
        return Promise.resolve({ updatedAt: 1 });
      },
      saveTools: () => Promise.resolve(),
      store: { read: () => null, write: () => {} },
      ulid: () => U("ZZ"),
      now: () => 1000,
    },
    "conversation-list": { mint: () => U("D0"), following: false },
    "notice-stack": { fadeMs: 2000 },
    undo: { store: undoStore, tell: () => {} },
  });
  const list = actors["conversation-list"];
  const order = () => list.getSnapshot().context.chats.map((r) => r.title).join();
  try {
    await until(() => order() === "chat 3,chat 2,chat 1");
    list.send({ type: "_cut", id: U("C3") });
    list.send({ type: "_paste", after: U("C2"), before: U("C1") });
    await until(() => order() === "chat 2,chat 3,chat 1");
    await until(() => saved.length === 1);
    assert.deepEqual(saved[0], { id: U("C3"), body: { position: saved[0].body.position } });
    list.send({ type: "_cut", id: U("C1") });
    list.send({ type: "_left" });
    await until(() => deleted.length === 1);
    assert.deepEqual(deleted, [U("C1")]);
    await until(() => order() === "chat 2,chat 3");
    const notices = () => [...actors["notice-stack"].getSnapshot().context.notices.values()];
    await until(() => notices().some((n) => n.key === "step"));
    actors["notice-stack"].send({ type: "_act", key: "step", index: 0 });
    await until(() => order() === "chat 2,chat 3,chat 1");
    assert.deepEqual(restored, [U("C1")]);
  } finally {
    unwire();
  }
});
