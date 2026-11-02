import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): line-checks with its partners evaluators and llm, all real, on the real
// bus with their real schemas; llm's own call to Jev is faked, so no request leaves the
// test. A stand-in mounted with the emitters' own schemas sends the saves note-editor and
// journal-entry send, the journal's news of which day is open, and asks the way an editor
// will.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const NOTE = "01ARZ3NDEKTSV4RRFFQ69G5NT1";
const TODAY = "01ARZ3NDEKTSV4RRFFQ69G5DY2";
const PAST = "01ARZ3NDEKTSV4RRFFQ69G5DY1";
const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G5PT2";

// The account picture llm's server module answers, signed in with a Jev key.
const picture = { signedIn: true, provider: "echo", providers: [], model: "", models: [], effort: "default", efforts: [], ttl: "1h" };

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
    id: "test-editor",
    meta: { kind: "view", emits: ["note.saved", "day.saved", "journal.changed"], asks: ["line-checks: read"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "text.checked": { actions: ({ event }) => heard.push(event) },
    },
  });
  const actor = mount(machine, {
    events: {
      "note.saved": schema("note-editor", "note.saved"),
      "day.saved": schema("journal-entry", "day.saved"),
      "journal.changed": schema("journal", "journal.changed"),
    },
  });
  return { actor, read: (payload) => ask(machine, "line-checks", "read", payload) };
}

const evaluator = {
  id: EV,
  book: BOOK,
  name: "In my control",
  on: true,
  version: 1,
  questions: [
    {
      id: Q1,
      kind: "pick",
      text: "Is this in my control?",
      yes: "",
      no: "",
      options: [
        { id: O1, name: "In my control", description: "", icon: "check" },
        { id: O2, name: "Not in my control", description: "" },
      ],
    },
  ],
};

const dayEntry = (id, text) => ({ id, day: id === PAST ? "2026-10-13" : "2026-10-14", text, editedAt: 1, version: 1, waiting: [], unanswered: [] });

test("a finished line under a hashtag is asked through llm; a past day and read never ask", async () => {
  const asked = [];
  const decide = async (payload) => {
    asked.push(payload.state.text);
    return { answers: [{ id: Q1, p: 0.9, choice: payload.state.text === "Rent is due" ? O1 : O2 }], inputTokens: 1, ms: 1 };
  };
  const { actors, unwire } = await wire(["llm", "evaluators", "line-checks"], {
    llm: { session: async () => ({ userId: "u1" }), read: async () => ({ ...picture, jev: { keySet: true } }), decide },
    evaluators: { store: rowsStore([evaluator]) },
    "line-checks": { store: checksStore() },
  });
  const heard = [];
  const editor = standIn(heard);
  const go = (body) => editor.actor.send({ type: "go", body });
  try {
    await until(() => actors["line-checks"].getSnapshot().matches("ready"));
    const body = "Things on my mind #in-my-control\nRent is due\nThe weather";
    go({ type: "note.saved", id: NOTE, title: "", body, baseVersion: null, finished: ["Rent is due", "The weather"] });
    await until(() => heard.at(-1)?.lines.length === 2 && heard.at(-1).lines.every((l) => l.status === "done"));
    assert.deepEqual(asked, ["Rent is due", "The weather"]);
    assert.deepEqual(
      heard.at(-1).lines.map((l) => [l.text, l.marks.map((m) => [m.name, m.icon ?? null])]),
      [
        ["Rent is due", [["In my control", "check"]]],
        ["The weather", [["Not in my control", null]]],
      ],
    );

    const days = [dayEntry(PAST, ""), dayEntry(TODAY, "")];
    go({ type: "journal.changed", days, projects: [], detectors: [], answers: [], open: TODAY, reason: null });
    go({ type: "day.saved", id: PAST, text: "#in-my-control\nOld worry", finished: ["Old worry"] });
    go({ type: "day.saved", id: TODAY, text: "#in-my-control\nRent is due\nNew worry", finished: ["Rent is due", "New worry"] });
    await until(() => asked.length === 3);
    assert.equal(asked[2], "New worry", "a past day never asks, and a kept answer is reused");

    const reply = await editor.read({ kind: "day", id: PAST, text: "#in-my-control\nRent is due\nUnasked" });
    assert.deepEqual(reply.lines.map((l) => [l.text, l.status]), [["Rent is due", "done"]]);
    assert.equal(asked.length, 3, "read never asks");
  } finally {
    unmount(editor.actor);
    unwire();
  }
});
