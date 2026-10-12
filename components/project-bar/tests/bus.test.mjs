import { test } from "node:test";
import assert from "node:assert/strict";
import { summary } from "../machine.js";

// The kit (10): the bar and its three facts, real machines on the real bus.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const NEW = "01K6TEST000000000000000NEW";
const fact = () => ({ stored: null, save: () => {} });

test("the bar counts the seeds, and a new project becomes current", async () => {
  const { actors, unwire } = await wire(["projects", "rubrics", "cases", "project-bar"], {
    projects: fact(),
    rubrics: fact(),
    cases: fact(),
    "project-bar": { mint: () => NEW },
  });
  try {
    const bar = actors["project-bar"];
    await until(() => bar.getSnapshot().matches("ready"));
    const { projects, current, rubrics, cases } = bar.getSnapshot().context;
    assert.deepEqual(projects.map((p) => p.name), ["Goals and values", "Replies", "Cognitive Distortion"]);
    assert.equal(summary(current, rubrics, cases), "2 tools · 18 cases");

    bar.send({ type: "_new" });
    await until(() => bar.getSnapshot().context.current === NEW);
    bar.send({ type: "_rename", name: "Habits" });
    await until(() => bar.getSnapshot().context.projects.some((p) => p.id === NEW && p.name === "Habits"));
    assert.equal(summary(NEW, bar.getSnapshot().context.rubrics, bar.getSnapshot().context.cases), "0 tools · 0 cases");

    bar.send({ type: "_delete" });
    await until(() => bar.getSnapshot().context.projects.find((p) => p.id === NEW)?.removing);
    assert.notEqual(bar.getSnapshot().context.current, NEW);
  } finally {
    unwire();
  }
});
