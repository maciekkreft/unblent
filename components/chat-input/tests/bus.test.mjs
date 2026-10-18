import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): chat-input with its partners, real machines on the real bus — `subject`
// (what a new chat is about) and `conversations` (which keeps the chat and its links).
// The server and what `subject` reads of `books` and `dock` are faked; the book open on
// the account is the one `books: open` names at start, as on the product after a load.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

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
