import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): choice-point-checks with its partners evaluators, choice-points and llm,
// all real, on the real bus with their real schemas; llm's own call to Jev is faked, so
// no request leaves the test. A stand-in mounted with the emitters' own schemas sends the
// gestures settings-sheet and journal-entry send and asks the way the choice point will.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const DAY = "2026-10-14";
const CP = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G5PT2";

const rowsStore = (initial) => {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const checksStore = () => ({
  boxAll: async () => [],
  boxPut: async () => {},
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
    id: "test-journal",
    meta: { kind: "view", emits: ["checks.edited", "day.shown"], asks: ["choice-point-checks: read"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "lines.checked": { actions: ({ event }) => heard.push(event) },
      "checks.changed": { actions: () => {} },
    },
  });
  const actor = mount(machine, {
    events: { "checks.edited": schema("settings-sheet", "checks.edited"), "day.shown": schema("journal-entry", "day.shown") },
  });
  return { actor, read: (payload) => ask(machine, "choice-point-checks", "read", payload) };
}

test("a box's evaluator asks Jev through llm about each line of the day's choice points", async () => {
  const evaluator = {
    id: EV,
    book: BOOK,
    name: "Therapy Goal",
    on: false,
    version: 1,
    questions: [
      {
        id: Q1,
        kind: "pick",
        text: "What kind of goal?",
        yes: "",
        no: "",
        options: [
          { id: O1, name: "Behavioral goal", description: "" },
          { id: O2, name: "Emotional goal", description: "" },
        ],
      },
    ],
  };
  const choicePoint = { id: CP, day: DAY, situation: "", thoughts: "", away: "", towards: "Call mum\nFeel calm", version: 1 };
  const asked = [];
  const decide = async (payload) => {
    asked.push(payload);
    const choice = payload.state.text === "Call mum" ? O1 : O2;
    return { answers: [{ id: Q1, p: 0.9, choice }], inputTokens: 1, ms: 1 };
  };
  const { actors, unwire } = await wire(["llm", "evaluators", "choice-points", "choice-point-checks"], {
    llm: { session: async () => ({ userId: "u1" }), read: async () => ({ jev: { keySet: true } }), decide },
    evaluators: { store: rowsStore([evaluator]) },
    "choice-points": { store: rowsStore([choicePoint]) },
    "choice-point-checks": { store: checksStore() },
  });
  const heard = [];
  const journal = standIn(heard);
  try {
    await until(() => actors["choice-point-checks"].getSnapshot().matches("ready"));
    const questions = [{ id: Q1, show: true, expect: O1, when: null, icons: {} }];
    journal.actor.send({ type: "go", body: { type: "checks.edited", field: "towards", evaluator: EV, questions } });
    journal.actor.send({ type: "go", body: { type: "day.shown", day: DAY } });
    await until(() => heard.at(-1)?.lines.every((l) => l.status === "done"));
    assert.deepEqual(asked.map((p) => p.state.text), ["Call mum", "Feel calm"], "a switched-off evaluator still checks");
    assert.deepEqual(
      heard.at(-1).lines.map((l) => [l.text, l.answers[0].name]),
      [
        ["Call mum", "Behavioral goal"],
        ["Feel calm", "Emotional goal"],
      ],
    );
    const reply = await journal.read({ day: DAY });
    assert.equal(reply.settings.towards.evaluator, EV);
    assert.deepEqual(reply.choicePoints.map((c) => c.choicePoint), [CP]);
  } finally {
    unmount(journal.actor);
    unwire();
  }
});
