import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): both real machines on the real bus, with their real schemas.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const NEW = "01K6TEST000000000000000N01";

test("a new tool typed in the editor reaches gauge, is stored and comes back as gauge.changed", async () => {
  const stored = [];
  // An empty list stored at a seed version no example set reaches, so gauge adds none.
  const { actors, unwire } = await wire(["gauge", "gauge-editor"], {
    gauge: { stored: JSON.stringify({ version: 1000, gauges: [] }), save: (v) => stored.push(v), now: () => 1 },
    "gauge-editor": { mint: () => "01K6TEST000000000000000Q01", undoMs: 100, throttleMs: 0 },
  });
  try {
    const editor = actors["gauge-editor"];
    await until(() => editor.getSnapshot().matches("idle"));
    editor.send({ type: "gauge.selected", id: NEW });
    editor.send({ type: "_edit", patch: { name: "Warmth" } });
    editor.send({ type: "_blur" });
    await until(() => stored.length > 0);
    const [g] = JSON.parse(stored.at(-1)).gauges;
    assert.equal(g.id, NEW);
    assert.equal(g.name, "Warmth");
    await until(() => editor.getSnapshot().context.gauges.some((x) => x.id === NEW));
  } finally {
    unwire();
  }
});
