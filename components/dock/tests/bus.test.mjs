import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): `dock` with dock-desk and `settings`, real machines on the real bus, the
// stores faked. A gesture on the desk is announced as dock.arranged; `dock` keeps the
// layout and announces it back as dock.changed, which is the only way the desk's
// picture changes (4.3, fourth and fifth rules).
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const VIEWS = [
  { name: "token-sheet", label: "Tokens" },
  { name: "contract-list", label: "Contracts" },
  { name: "trace-list", label: "Trace" },
];

test("docking a view goes to dock and comes back to the desk as dock.changed", async () => {
  const saved = [];
  const { actors, unwire } = await wire(["settings", "dock", "dock-desk"], {
    settings: {
      product: false,
      stored: { workshop: null, product: null, profile: null },
      save: { workshop: () => {}, product: () => {}, profile: () => {} },
    },
    dock: { stored: JSON.stringify({ stage: "token-sheet", docks: {} }), save: (json) => saved.push(JSON.parse(json)) },
    "dock-desk": { views: VIEWS },
  });
  const desk = () => actors["dock-desk"].getSnapshot();
  try {
    await until(() => desk().matches("ready") && desk().context.arranging);
    actors["dock-desk"].send({ type: "_dock", name: "trace-list", side: "right" });
    await until(() => desk().context.docks.right?.views.includes("trace-list"));
    assert.equal(desk().context.stage, "token-sheet", "the stage keeps the view it showed");
    assert.deepEqual(saved.at(-1)?.docks.right?.views, ["trace-list"], "dock stored the new layout");
  } finally {
    unwire();
  }
});
