import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): feature-flags with `flags`, real machines on the real bus, the server
// faked. A switch reaches the server through flag.switched, and a refused one comes back
// as the same picture, which puts the switch back.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

test("a switch in the tab is saved by flags, and a refused one goes back", async () => {
  let off = [];
  let offline = false;
  const saved = [];
  const { actors, unwire } = await wire(["flags", "feature-flags"], {
    flags: {
      cached: null,
      remember: () => {},
      load: async () => ({ off, hidden: [] }),
      save: async (feature, on) => {
        saved.push([feature, on]);
        if (offline) throw new Error("offline");
        off = on ? off.filter((f) => f !== feature) : [...off, feature];
        return { off, hidden: [] };
      },
    },
  });
  try {
    const view = actors["feature-flags"];
    await until(() => view.getSnapshot().context.off !== null && view.getSnapshot().context.off.length === 0);
    view.send({ type: "_switch", feature: "evaluators", on: false });
    await until(() => Object.keys(view.getSnapshot().context.waiting).length === 0);
    assert.deepEqual(saved, [["evaluators", false]]);
    assert.deepEqual(view.getSnapshot().context.off, ["evaluators"]);
    offline = true;
    view.send({ type: "_switch", feature: "evaluators", on: true });
    await until(() => view.getSnapshot().context.refused === "evaluators");
    assert.deepEqual(view.getSnapshot().context.off, ["evaluators"], "nothing changed");
  } finally {
    unwire();
  }
});
