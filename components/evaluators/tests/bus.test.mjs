import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): evaluators, evaluator-list, notice-stack and undo, all real, on the real
// bus with their real schemas.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount } = await import("bus");
const { setup } = await import("xstate");

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

// A cut row deleted when the keyboard leaves the list goes at once, and the corner
// notice's Undo, through `undo`, brings it back (12, Vim keys; 12, Undo).
test("a cut evaluator deleted on leaving the list comes back with the notice's Undo", async () => {
  const store = memory();
  store.rows.set(ID, { id: ID, book: BOOK, name: "Goals", on: true, questions: [], version: 1 });
  const lists = new Map();
  const undoStore = { read: async (account) => lists.get(account), write: async (account, l) => void lists.set(account, structuredClone(l)) };
  const { actors, unwire } = await wire(["evaluators", "evaluator-list", "notice-stack", "undo"], {
    evaluators: { store },
    "evaluator-list": { mint: () => "01ARZ3NDEKTSV4RRFFQ69G5DRF" },
    "notice-stack": { fadeMs: 60 },
    undo: { store: undoStore, tell: () => {} },
  });
  try {
    const rows = () => actors["evaluator-list"].getSnapshot().context.evaluators.map((e) => e.id);
    await until(() => rows().includes(ID));
    actors["evaluator-list"].send({ type: "_cut", id: ID });
    actors["evaluator-list"].send({ type: "_left" });
    await until(() => store.rows.get(ID).deleted === true && !rows().includes(ID));
    const notices = () => [...actors["notice-stack"].getSnapshot().context.notices.values()];
    await until(() => notices().some((n) => n.key === "step"));
    actors["notice-stack"].send({ type: "_act", key: "step", index: 0 });
    await until(() => rows().includes(ID));
    assert.equal(store.rows.get(ID).deleted, undefined, "brought back");
    assert.equal(store.rows.get(ID).name, "Goals");
  } finally {
    unwire();
  }
});

// The chat's tools (7.7) on the real bus, with llm real and its call to Jev faked, so no
// request leaves the test. A stand-in asks the way conversations' tool loop does. Two
// checks at once find llm busy with the other, and the second waits and asks again.
test("the chat lists the evaluators and checks texts with one through llm", async () => {
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
