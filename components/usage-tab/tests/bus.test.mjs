import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): usage-tab with `settings`, real machines on the real bus, the store
// faked. The switch reaches settings as settings.edited and comes back as
// settings.changed, which is the only way the tab's switch moves (4.3).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

test("the switch is saved by settings and comes back on", async () => {
  const saved = [];
  const { actors, unwire } = await wire(["settings", "usage-tab"], {
    settings: {
      product: true,
      stored: { workshop: null, product: null, profile: null },
      save: { workshop: () => {}, product: (json) => saved.push(JSON.parse(json)), profile: () => {} },
    },
  });
  const tab = () => actors["usage-tab"].getSnapshot().context;
  try {
    await until(() => tab().settings !== null);
    assert.equal(tab().settings.usageCounting, false, "off until the person turns it on");
    actors["usage-tab"].send({ type: "_toggle" });
    await until(() => tab().settings.usageCounting === true);
    assert.equal(saved.at(-1)?.usageCounting, true, "settings kept it");
  } finally {
    unwire();
  }
});
