import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): generators, real, on the real bus with its real schemas. A stand-in
// mounted with generator-settings' own event schema edits and asks the way that view
// will, so each step is sent by hand.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const memory = () => {
  const rows = new Map();
  return {
    rows,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const settingsSchema = (name) => JSON.parse(readFileSync(new URL(`../../generator-settings/events/${name}.json`, import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-generator-settings",
    meta: { kind: "view", emits: ["generator.edited"], asks: ["generators: list", "generators: results", "conversations: read"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "generator.changed": { actions: ({ event }) => heard.push(event) },
      "generation.changed": { actions: () => {} },
    },
  });
  const actor = mount(machine, { events: { "generator.edited": settingsSchema("generator.edited") } });
  return {
    actor,
    list: () => ask(machine, "generators", "list", {}),
    results: (generator) => ask(machine, "generators", "results", { generator }),
    // What chat-thread asks when it shows a chat, which loads it and announces it.
    read: (id) => ask(machine, "conversations", "read", { id }),
  };
}

test("an edit in the tab reaches generators, and list answers what was kept", async () => {
  const store = memory();
  const { actors, unwire } = await wire(["generators"], { generators: { store } });
  const heard = [];
  const view = standIn(heard);
  try {
    await until(() => actors.generators.getSnapshot().matches("ready"));
    assert.equal((await view.list()).generators.length, 2);
    view.actor.send({ type: "go", body: { type: "generator.edited", id: "journal-summary", on: false } });
    await until(() => heard.length === 1);
    assert.deepEqual([heard[0].generator.id, heard[0].generator.on], ["journal-summary", false]);
    assert.equal((await view.list()).generators[1].on, false);
    assert.equal(store.rows.get("journal-summary").on, false);
    assert.deepEqual(await view.results("chat-title"), { results: [] });
  } finally {
    unmount(view.actor);
    unwire();
  }
});

// The engine with its one-hop partners, all real machines on the real bus: journal and
// choice-points answer the starting picture from their faked stores, conversations
// loads a chat from its faked server when it is read (as chat-thread reads the open
// one) and announces it, and llm answers generate from its faked
// server module. Session is not mounted, so the partners are signed out and work locally;
// generators alone is told it is signed in.
const journalStore = (days) => {
  const tables = { days: new Map(days.map((d) => [d.id, d])) };
  return {
    all: (t) => Promise.resolve([...(tables[t]?.values() ?? [])]),
    put: (t, r) => (tables[t]?.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: () => Promise.resolve(undefined),
    metaPut: () => Promise.resolve(),
  };
};

test("a closed day and a chat whose first answer finished are written through llm and announced", async () => {
  const CHAT = "01HQ8ZK7M4N5P6Q7R8S9T0V1W4";
  const DAY = "2026-10-12";
  const turns = [
    { id: "01HQ8ZK7M4N5P6Q7R8S9T0V1A1", role: "user", text: "Where do herons nest?", at: 1 },
    { id: "01HQ8ZK7M4N5P6Q7R8S9T0V1A2", role: "assistant", text: "In colonies.", status: "done", at: 2 },
  ];
  const chat = { id: CHAT, title: "Where do herons nest?", about: [], start: "", turns, updatedAt: Date.now() };
  const asked = [];
  let open = CHAT;
  const { machine } = await import("../machine.js");
  const { unwire } = await wire(["journal", "choice-points", "conversations", "llm", "generators"], {
    journal: { store: journalStore([{ id: "01K7TEST00000000000000DA12", day: DAY, text: "Herons at dawn", editedAt: Date.parse("2026-10-12T08:00:00"), version: 1 }]), now: () => Date.parse("2026-10-14T10:00:00") },
    "choice-points": { store: memory() },
    conversations: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: false }),
      subject: () => Promise.resolve({ subject: null }),
      pins: () => Promise.resolve({}),
      list: () => Promise.resolve({ conversations: [chat], tools: { tools: {}, approval: "auto" } }),
      read: () => Promise.resolve(chat),
      store: { read: () => open, write: (id) => (open = id) },
      ulid: () => "01HQ8ZK7M4N5P6Q7R8S9T0V1X9",
      now: () => 1000,
    },
    llm: {
      session: () => Promise.resolve({ userId: null, registrationOpen: false }),
      generate: (payload) => (asked.push(payload), Promise.resolve({ text: `Echo: ${payload.text.split("\n")[0]}` })),
    },
    generators: {
      store: memory(),
      ask: (target, name, payload) => (target === "session" ? Promise.resolve({ userId: "u1", registrationOpen: false }) : ask(machine, target, name, payload)),
    },
  });
  const heard = [];
  const view = standIn(heard);
  try {
    await until(async () => !(await view.read(CHAT)).error);
    await until(async () => (await view.results("journal-summary")).results.length === 1 && (await view.results("chat-title")).results.length === 1);
    const [summary] = (await view.results("journal-summary")).results;
    assert.deepEqual([summary.item, summary.text], [DAY, `Echo: Journal entry for ${DAY}:`]);
    const [title] = (await view.results("chat-title")).results;
    assert.deepEqual([title.item, title.text], [CHAT, "Echo: First message:"]);
    assert.equal(asked.length, 2, "one text each");
  } finally {
    unmount(view.actor);
    unwire();
  }
});
