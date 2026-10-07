import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): both real machines on the real bus, with their real schemas.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const scoring = (id, at) => ({ id, at, text: `Post at ${at}`, gauges: [] });
const A = "01K6TEST000000000000000S0A";
const B = "01K6TEST000000000000000S0B";

test("the list shows what scorings holds, newest first, and a delete removes it from scorings", async () => {
  let stored = JSON.stringify([scoring(B, 2), scoring(A, 1)]);
  const { actors, unwire } = await wire(["scorings", "scoring-list"], {
    scorings: { stored, save: (v) => (stored = v) },
    "scoring-list": { undoMs: 10 },
  });
  try {
    const list = actors["scoring-list"];
    await until(() => list.getSnapshot().matches("ready"));
    assert.deepEqual(list.getSnapshot().context.scorings.map((s) => s.id), [B, A]);
    assert.equal(list.getSnapshot().context.open, B);
    list.send({ type: "_delete", id: A });
    await until(() => list.getSnapshot().context.scorings.length === 1);
    assert.deepEqual(JSON.parse(stored).map((s) => s.id), [B]);
  } finally {
    unwire();
  }
});
