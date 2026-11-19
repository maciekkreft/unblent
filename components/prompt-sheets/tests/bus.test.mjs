import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): prompt-sheets, real, on the real bus with its real schemas. Stand-ins
// mounted with the partners' own schemas play prompt-sheet (saving and asking the way that
// view will), journal (saying which day is today), evaluators (listing the built-in Answers
// the prompt evaluator) and llm (answering decide), so every message crosses the bus and
// is validated there.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5PS1";
const SET = "01ARZ3NDEKTSV4RRFFQ69G5ST1";
const PROMPT = "0000000000000000000000PRMT";
const ANSWERS = "0000000000000000000000NSWR";
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

const EVALUATOR = {
  id: PROMPT,
  book: JOURNAL,
  name: "Answers the prompt",
  on: true,
  questions: [{ id: ANSWERS, kind: "yesno", text: "Does the answer respond to what the prompt asks?", yes: "", no: "", options: [] }],
  version: 1,
  pending: false,
  removing: false,
};

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-sheet",
    meta: { kind: "view", emits: ["prompt-sheet.saved"], asks: ["prompt-sheets: list", "prompt-sheets: read"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "prompt-sheet.changed": { actions: ({ event }) => heard.push(event) },
      "prompt-sheet.deleted": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, { events: { "prompt-sheet.saved": json("../../prompt-sheet/events/prompt-sheet.saved.json") } });
  return {
    actor,
    list: (payload) => ask(machine, "prompt-sheets", "list", payload),
    read: (payload) => ask(machine, "prompt-sheets", "read", payload),
  };
}

function fact(id, emits, on, queries, events = {}) {
  const machine = setup({}).createMachine({ id, meta: { kind: "fact", shape: "remote-only", owns: id, emits }, on });
  return mount(machine, { events, queries });
}

test("the view's saves reach prompt-sheets, its queries answer them, and a check asked of llm arrives as a change", async () => {
  const decided = [];
  const journal = fact(
    "journal",
    ["journal.changed"],
    { "read?": { actions: ({ event }) => event.reply({ days: [], projects: [], detectors: [], answers: [], open: null, today: DAY, reason: null }) } },
    { read: json("../../journal/queries/read.json") },
    { "journal.changed": json("../../journal/events/journal.changed.json") },
  );
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
          event.reply({ answers: [{ id: ANSWERS, p: 0.1 }], inputTokens: 12, ms: 3 });
        },
      },
    },
    { decide: json("../../llm/queries/decide.json") },
  );
  const store = memory();
  const { actors, unwire } = await wire(["prompt-sheets"], { "prompt-sheets": { store } });
  const heard = [];
  const sheet = standIn(heard);
  try {
    await until(() => actors["prompt-sheets"].getSnapshot().matches("ready"));
    const body = {
      type: "prompt-sheet.saved",
      id: ID,
      day: DAY,
      setId: SET,
      setName: "Evening review",
      basedOn: "Seneca, On Anger",
      answers: [{ prompt: "What did I do well today?", answer: "Pizza is round" }],
      finished: true,
    };
    sheet.actor.send({ type: "go", body });
    await until(() => heard.some((e) => e.sheet?.answers[0].fits === false));
    assert.deepEqual(decided.map((p) => p.state), [{ prompt: "What did I do well today?", answer: "Pizza is round" }]);
    const reply = await sheet.list({ day: DAY });
    assert.deepEqual([reply.total, reply.sheets[0].answers[0].fits], [1, false]);
    assert.equal((await sheet.read({ id: ID })).sheet.setName, "Evening review");

    sheet.actor.send({ type: "go", body: { ...body, deleted: true } });
    await until(() => heard.at(-1).type === "prompt-sheet.deleted");
    assert.equal(store.rows.get(ID).deleted, true);
    assert.equal((await sheet.read({ id: ID })).sheet, null);
  } finally {
    unmount(sheet.actor);
    unmount(journal);
    unmount(evaluators);
    unmount(llm);
    unwire();
  }
});
