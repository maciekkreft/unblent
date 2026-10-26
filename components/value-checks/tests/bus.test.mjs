import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): value-checks with its partners llm, evaluators and values, all real, on
// the real bus with their real schemas; llm's own call to Jev is faked, so no request
// leaves the test. A stand-in mounted with the emitters' own schemas sends the gestures
// settings-sheet, journal-entry and values-sheet send, and asks the way the sheet will.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const NOW = new Date(2026, 9, 26, 9, 30).getTime();
const DAY = "2026-10-26";
const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G5PT2";
const V1 = "01ARZ3NDEKTSV4RRFFQ69G5VA1";
const V2 = "01ARZ3NDEKTSV4RRFFQ69G5VA2";

// The account picture llm's server module answers, signed in with a Jev key.
const picture = { signedIn: true, provider: "echo", providers: [], model: "", models: [], effort: "default", efforts: [], ttl: "1h" };

const rowsStore = (initial, key = "id") => {
  const rows = new Map(initial.map((r) => [r[key], r]));
  return {
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r[key], r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const checksStore = () => ({
  settingsGet: async () => null,
  settingsPut: async () => {},
  answerAll: async () => [],
  answerPut: async () => {},
  outboxAll: async () => [],
  outboxPut: async () => {},
  outboxDelete: async () => {},
  metaGet: async () => undefined,
  metaPut: async () => {},
});

const schema = (component, name) => JSON.parse(readFileSync(new URL(`../../${component}/events/${name}.json`, import.meta.url)));

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-values",
    meta: { kind: "view", emits: ["value-checks.edited", "day.shown", "values.saved"], asks: ["value-checks: read"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "values.checked": { actions: ({ event }) => heard.push(event) },
      "value-checks.changed": { actions: () => {} },
    },
  });
  const actor = mount(machine, {
    events: {
      "value-checks.edited": schema("settings-sheet", "value-checks.edited"),
      "day.shown": schema("journal-entry", "day.shown"),
      "values.saved": schema("values-sheet", "values.saved"),
    },
  });
  return { actor, read: (payload) => ask(machine, "value-checks", "read", payload) };
}

test("a finished row of today's values is checked by Jev through llm, and read reports it", async () => {
  const evaluator = {
    id: EV,
    book: BOOK,
    name: "Is it a value?",
    on: true,
    version: 1,
    questions: [
      {
        id: Q1,
        kind: "pick",
        text: "What is this?",
        yes: "",
        no: "",
        expect: O1,
        options: [
          { id: O1, name: "A value", description: "" },
          { id: O2, name: "A goal", description: "" },
        ],
      },
    ],
  };
  const asked = [];
  const decide = async (payload) => {
    asked.push(payload.state.text);
    return { answers: [{ id: Q1, p: 0.9, choice: payload.state.text === "Honesty" ? O1 : O2 }], inputTokens: 1, ms: 1 };
  };
  const { actors, unwire } = await wire(["llm", "evaluators", "values", "value-checks"], {
    llm: { session: async () => ({ userId: "u1" }), read: async () => ({ ...picture, jev: { keySet: true } }), decide },
    evaluators: { store: rowsStore([evaluator]) },
    values: { store: rowsStore([{ day: DAY, values: [{ id: V1, name: "Honesty", meaning: "" }], version: 1 }], "day"), now: () => NOW },
    "value-checks": { store: checksStore() },
  });
  const heard = [];
  const sheet = standIn(heard);
  try {
    await until(() => actors["value-checks"].getSnapshot().matches("ready"));
    sheet.actor.send({ type: "go", body: { type: "value-checks.edited", values: EV, examples: null } });
    sheet.actor.send({ type: "go", body: { type: "day.shown", day: DAY } });
    await until(() => heard.at(-1)?.values[0]?.lines[0]?.status === "done");
    const values = [
      { id: V1, name: "Honesty", meaning: "" },
      { id: V2, name: "Run a marathon", meaning: "" },
    ];
    sheet.actor.send({ type: "go", body: { type: "values.saved", day: DAY, values, finished: [V2] } });
    await until(() => heard.at(-1)?.values.length === 2 && heard.at(-1).values.every((v) => v.lines[0].status === "done"));
    assert.deepEqual(asked, ["Honesty", "Run a marathon"]);
    const reply = await sheet.read({ day: DAY });
    assert.equal(reply.keySet, true);
    assert.deepEqual(reply.settings, { values: EV, examples: null });
    assert.deepEqual(
      reply.values.map((v) => [v.id, v.lines[0].unexpected]),
      [
        [V1, []],
        [V2, ["A goal"]],
      ],
    );
  } finally {
    unmount(sheet.actor);
    unwire();
  }
});
