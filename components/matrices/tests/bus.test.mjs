import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): matrices, real, on the real bus with its real schemas. Stand-ins mounted
// with the partners' own schemas play matrix-sheet (saving and listing the way that view
// does), evaluators (listing the built-in Eisenhower evaluator) and llm (answering decide),
// so every message crosses the bus and is validated there.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const T1 = "01ARZ3NDEKTSV4RRFFQ69G5TA1";
const EISENHOWER = "0000000000000000000000EMTX";
const URGENT = "0000000000000000000000RGNT";
const IMPORTANT = "0000000000000000000000MPRT";
const JOURNAL = "00000000000000000000000JRN";

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

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const savedSchema = json("../../matrix-sheet/events/matrix.saved.json");

const question = (id, text) => ({ id, kind: "yesno", text, yes: "", no: "", options: [] });
const EVALUATOR = {
  id: EISENHOWER,
  book: JOURNAL,
  name: "Eisenhower",
  on: true,
  questions: [question(URGENT, "Is this task urgent?"), question(IMPORTANT, "Is this task important?")],
  version: 1,
  pending: false,
  removing: false,
};

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-sheet",
    meta: { kind: "view", emits: ["matrix.saved"], asks: ["matrices: list"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "matrix.changed": { actions: ({ event }) => heard.push(event) },
      "matrix.deleted": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, { events: { "matrix.saved": savedSchema } });
  return { actor, list: (payload) => ask(machine, "matrices", "list", payload) };
}

function fact(id, emits, on, queries, events = {}) {
  const machine = setup({}).createMachine({ id, meta: { kind: "fact", shape: "remote-only", owns: id, emits }, on });
  return mount(machine, { events, queries });
}

test("the view's saves reach matrices, its list answers them, and a suggestion asked of llm arrives as a change", async () => {
  const decided = [];
  const evaluators = fact(
    "evaluators",
    ["evaluator.changed", "evaluator.deleted"],
    { "list?": { actions: ({ event }) => event.reply({ evaluators: [EVALUATOR] }) } },
    { list: json("../../evaluators/queries/list.json") },
    { "evaluator.changed": json("../../evaluators/events/evaluator.changed.json"), "evaluator.deleted": json("../../evaluators/events/evaluator.deleted.json") },
  );
  const llm = fact(
    "llm",
    [],
    {
      "decide?": {
        actions: ({ event }) => {
          decided.push(event.payload);
          event.reply({ answers: [{ id: URGENT, p: 0.95 }, { id: IMPORTANT, p: 0.9 }], inputTokens: 12, ms: 3 });
        },
      },
    },
    { decide: json("../../llm/queries/decide.json") },
  );
  const store = memory();
  const { actors, unwire } = await wire(["matrices"], { matrices: { store } });
  const heard = [];
  const sheet = standIn(heard);
  try {
    await until(() => actors.matrices.getSnapshot().matches("ready"));
    const body = { type: "matrix.saved", id: ID, day: DAY, tasks: [{ id: T1, text: "Call the bank", place: null, done: false }], finished: true };
    sheet.actor.send({ type: "go", body });
    await until(() => heard.some((e) => e.matrix?.tasks[0].suggested));
    assert.equal(decided.length, 1);
    assert.deepEqual(decided[0].state, { task: "Call the bank" });
    const reply = await sheet.list({ day: DAY });
    assert.deepEqual(reply.matrices[0].tasks[0].suggested, { place: "do", sure: true });
    assert.equal((await sheet.list({})).total, 1);

    sheet.actor.send({ type: "go", body: { ...body, tasks: [], deleted: true } });
    await until(() => heard.at(-1).type === "matrix.deleted");
    assert.equal(store.rows.get(ID).deleted, true);
  } finally {
    unmount(sheet.actor);
    unmount(evaluators);
    unmount(llm);
    unwire();
  }
});
