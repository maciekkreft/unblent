import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): evaluators and notice-stack, both real, on the real bus with their real
// schemas. No component emits removal.started yet (the evaluator editor will), so a
// stand-in that declares it, with the shape removal.undone has plus the thing's name,
// starts the removal the way the editor will.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";

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

function standIn() {
  const undone = JSON.parse(readFileSync(new URL("../../notice-stack/events/removal.undone.json", import.meta.url)));
  const started = { ...undone, properties: { ...undone.properties, name: { type: "string" } }, required: [...undone.required, "name"] };
  const machine = setup({}).createMachine({
    id: "test-remover",
    meta: { kind: "view", emits: ["removal.started"], attributes: [] },
    on: { go: { actions: emit(({ event }) => ({ type: "removal.started", ...event.body })) } },
  });
  return mount(machine, { events: { "removal.started": started } });
}

test("an evaluator's removal waits in notice-stack: Undo brings it back, the window running out deletes it", async () => {
  const store = memory();
  store.rows.set(ID, { id: ID, book: BOOK, name: "Goals", on: true, questions: [], version: 1 });
  const { actors, unwire } = await wire(["evaluators", "notice-stack"], {
    evaluators: { store },
    "notice-stack": { fadeMs: 60 },
  });
  const remover = standIn();
  const removing = () => store.rows.get(ID).removing;
  try {
    const stack = actors["notice-stack"];
    await until(() => actors.evaluators.getSnapshot().matches("ready"));
    remover.send({ type: "go", body: { kind: "evaluator", id: ID, name: "Goals" } });
    await until(() => removing() === true);
    stack.send({ type: "_act", key: `removal:evaluator:${ID}`, index: 0 });
    await until(() => removing() === false);
    assert.ok(!store.rows.get(ID).deleted);

    remover.send({ type: "go", body: { kind: "evaluator", id: ID, name: "Goals" } });
    await until(() => store.rows.get(ID).deleted === true);
    assert.equal(store.rows.get(ID).version, 2);
  } finally {
    unmount(remover);
    unwire();
  }
});

// The chat's tools (7.7) on the real bus, with llm real and its call to Jev faked, so no
// request leaves the test. A stand-in asks the way conversations' tool loop does. Two
// checks at once find llm busy with the other, and the second waits and asks again.
test("the chat lists the switched-on evaluators and checks texts with one through llm", async () => {
  const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5QQ1";
  const store = memory();
  store.rows.set(ID, {
    id: ID,
    book: BOOK,
    name: "Short",
    description: "Checks a name is short",
    on: true,
    version: 1,
    questions: [{ id: Q1, kind: "yesno", text: "Is it under three words?", yes: "", no: "", options: [], expect: "yes" }],
  });
  const asked = [];
  const waits = [];
  const decide = async (payload) => {
    asked.push(payload.state.text);
    await new Promise((r) => setTimeout(r, 30));
    return { answers: [{ id: Q1, p: payload.state.text.split(" ").length < 3 ? 0.9 : 0.1 }], inputTokens: 1, ms: 1 };
  };
  const picture = { signedIn: true, provider: "echo", providers: [], model: "", models: [], effort: "default", efforts: [], ttl: "1h", jev: { keySet: true } };
  const { actors, unwire } = await wire(["llm", "evaluators"], {
    llm: { session: async () => ({ userId: "u1" }), read: async () => picture, decide },
    evaluators: { store, wait: (ms) => (waits.push(ms), new Promise((r) => setTimeout(r, ms / 50))) },
  });
  const { ask } = await import("bus");
  const chat = setup({}).createMachine({
    id: "test-chat",
    meta: { kind: "view", emits: [], asks: ["*: tool"], attributes: [] },
  });
  const actor = mount(chat, {});
  try {
    await until(() => actors.evaluators.getSnapshot().matches("ready") && actors.llm.getSnapshot().context.picture?.signedIn === true);
    const listed = await ask(chat, "evaluators", "active", {});
    assert.deepEqual(listed.evaluators.map((e) => [e.id, e.description]), [[ID, "Checks a name is short"]]);
    const [one, two] = await Promise.all([
      ask(chat, "evaluators", "evaluate", { evaluator: ID, texts: ["Calm"] }),
      ask(chat, "evaluators", "evaluate", { evaluator: ID, texts: ["A very long name indeed"] }),
    ]);
    assert.deepEqual(one.results.map((r) => [r.text, r.passed]), [["Calm", true]]);
    assert.deepEqual(two.results.map((r) => [r.text, r.passed]), [["A very long name indeed", false]]);
    assert.deepEqual(waits, [1500], "the second found llm busy and waited");
    assert.deepEqual(asked.sort(), ["A very long name indeed", "Calm"], "and was asked again once llm was free");
  } finally {
    unmount(actor);
    unwire();
  }
});
