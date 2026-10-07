import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): both real machines on the real bus, with their real schemas.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

test("the list shows the seed from gauge and a pick goes out on the bus", async () => {
  const { actors, records, unwire } = await wire(["gauge", "gauge-list"], {
    gauge: { stored: null, save: () => {}, now: () => 1 },
    "gauge-list": { mint: () => "01K6TEST000000000000000D01" },
  });
  try {
    const list = actors["gauge-list"];
    await until(() => list.getSnapshot().matches("ready"));
    const names = list.getSnapshot().context.gauges.map((g) => g.name);
    assert.deepEqual(names, ["Followability", "Shareability", "Likeability", "Saveability"]);
    list.send({ type: "_pick", id: list.getSnapshot().context.gauges[1].id });
    await until(() => records.some((r) => r.name === "gauge.selected" || r.type === "gauge.selected" || JSON.stringify(r).includes("gauge.selected")));
  } finally {
    unwire();
  }
});
