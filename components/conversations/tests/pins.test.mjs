import { test } from "node:test";
import assert from "node:assert/strict";
import { ask } from "bus";
import { machine } from "../machine.js";

// The kit (10): conversations with its two partners in a pin, chat-thread (whose pin
// button emits pin.toggled) and pins, all real machines on the real bus. The server and
// the subject are faked through conversations' input; subject.changed, a subject fact's
// news, is sent straight to conversations as the bus would deliver it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const CHAT = "01HQ8ZK7M4N5P6Q7R8S9T0V1W4";
const CHAT2 = "01HQ8ZK7M4N5P6Q7R8S9T0V1W5";
const B1 = { kind: "book", id: "01HQ8ZK7M4N5P6Q7R8S9T0V1B1", title: "One", view: "book-reader" };
const B2 = { kind: "book", id: "01HQ8ZK7M4N5P6Q7R8S9T0V1B2", title: "Two", view: "book-reader" };
const chat = (id, b) => ({ id, title: id, about: [{ kind: "book", id: b.id }], start: "", turns: [{ id: `${id.slice(0, 25)}T`, role: "user", text: "hi", at: 1 }], updatedAt: 5 });

test("a chat opened is pinned without a press and stays while the stage moves, the pin moves with a pick, and turned off the chat follows again and the pin stays off", async () => {
  let open = null;
  const chats = { [CHAT]: chat(CHAT, B1), [CHAT2]: chat(CHAT2, B2) };
  const { actors, unwire } = await wire(["pins", "conversations", "chat-thread"], {
    pins: { stored: null, save: () => {} },
    conversations: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: false }),
      subject: () => Promise.resolve({ subject: B1 }),
      pins: () => ask(machine, "pins", "read", {}),
      list: () => Promise.resolve({ conversations: Object.values(chats), tools: { tools: {}, approval: "auto" } }),
      read: (id) => Promise.resolve(chats[id]),
      store: { read: () => open, write: (id) => (open = id) },
      ulid: () => "01HQ8ZK7M4N5P6Q7R8S9T0V1X9",
      now: () => 1000,
    },
  });
  const thread = () => actors["chat-thread"].getSnapshot().context;
  const pins = () => actors.pins.getSnapshot().context.pins;
  try {
    await until(() => thread().conversation?.id === CHAT);
    actors.conversations.send({ type: "conversation.selected", id: CHAT });
    await until(() => pins().chat === CHAT && thread().pin === CHAT);

    actors.conversations.send({ type: "subject.changed", subject: B2 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(thread().openId, CHAT, "the pinned chat stayed open");

    actors.conversations.send({ type: "conversation.selected", id: CHAT2 });
    await until(() => pins().chat === CHAT2);
    assert.equal(thread().openId, CHAT2, "the pick opened, and the pin moved to it");

    actors["chat-thread"].send({ type: "_togglePin" });
    await until(() => pins().chat === null);
    actors.conversations.send({ type: "subject.changed", subject: B1 });
    await until(() => thread().openId === CHAT);
    actors.conversations.send({ type: "conversation.selected", id: CHAT2 });
    await until(() => thread().openId === CHAT2);
    assert.equal(pins().chat, null, "turned off, the pin stays off");
  } finally {
    unwire();
  }
});
