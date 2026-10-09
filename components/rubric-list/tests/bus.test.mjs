import { test } from "node:test";
import assert from "node:assert/strict";
import { rows, subtitle } from "../machine.js";

// The kit (10): the list and its two facts, real machines on the real bus.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const fact = () => ({ stored: null, save: () => {} });

test("the list shows the seeded tools, a tick reaches rubrics, and a switch of project follows", async () => {
  const { actors, unwire } = await wire(["projects", "rubrics", "rubric-list"], {
    projects: fact(),
    rubrics: fact(),
    "rubric-list": { mint: () => "01K6TEST000000000000000D01" },
  });
  try {
    const list = actors["rubric-list"];
    const shown = () => rows(list.getSnapshot().context.rubrics, list.getSnapshot().context.current);
    await until(() => list.getSnapshot().matches("ready"));
    assert.deepEqual(shown().map((r) => [r.name, subtitle(r)]), [
      ["Goal or value", "1 question"],
      ["Goal or value (yes / no)", "2 questions · off"],
    ]);
    list.send({ type: "_switch", id: shown()[1].id, on: true });
    await until(() => shown()[1].on === true);

    const replies = actors.projects.getSnapshot().context.projects.find((p) => p.name === "Replies");
    actors.projects.send({ type: "project.selected", id: replies.id });
    await until(() => shown().length === 6);
    assert.deepEqual(shown().filter((r) => r.on).map((r) => r.name), ["Replyability"]);
  } finally {
    unwire();
  }
});
