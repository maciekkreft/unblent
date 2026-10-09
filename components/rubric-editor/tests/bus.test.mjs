import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the editor and its two facts, real machines on the real bus.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const fact = () => ({ stored: null, save: () => {} });
const GOAL_OR_VALUE = "01K6SEED00000000000000RB01";
const VALUE = "01K6SEED00000000000000RC02";
const NEW = "01K6TEST000000000000000N01";

test("an edit reaches rubrics, a removed option is flagged and hidden, and a new tool joins the current project", async () => {
  let n = 0;
  const { actors, unwire } = await wire(["projects", "rubrics", "rubric-editor"], {
    projects: fact(),
    rubrics: fact(),
    "rubric-editor": { mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`, throttleMs: 0 },
  });
  try {
    const editor = actors["rubric-editor"];
    const stored = (id) => actors.rubrics.getSnapshot().context.rubrics.find((r) => r.id === id);
    const draft = () => editor.getSnapshot().context.draft;
    await until(() => editor.getSnapshot().matches("ready"));

    editor.send({ type: "rubric.selected", id: GOAL_OR_VALUE });
    const [q] = draft().questions;
    editor.send({ type: "_removeOption", question: q.id, id: VALUE });
    assert.equal(stored(GOAL_OR_VALUE).questions[0].options.find((o) => o.id === VALUE).removing, true);
    assert.equal(draft().questions[0].options.find((o) => o.id === VALUE).removing, true);
    actors.rubrics.send({ type: "removal.undone", kind: "option", id: VALUE, name: "Value" });
    assert.equal(draft().questions[0].options.find((o) => o.id === VALUE).removing, false);

    editor.send({ type: "rubric.selected", id: NEW });
    editor.send({ type: "_editQuestion", id: draft().questions[0].id, patch: { text: "Is it kind?" } });
    editor.send({ type: "_blur" });
    const current = actors.projects.getSnapshot().context.current;
    assert.equal(stored(NEW).project, current);
    assert.deepEqual(stored(NEW).questions.map((x) => x.text), ["Is it kind?"]);
  } finally {
    unwire();
  }
});
