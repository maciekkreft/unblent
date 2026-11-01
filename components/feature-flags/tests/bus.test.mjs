import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): feature-flags with `flags`, real machines on the real bus, the server
// faked, and `session` faked as an answer. A switch reaches the server through
// flag.switched with its column, and a refused one comes back as the same picture,
// which puts the switch back.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

test("a switch in the tab is saved by flags, and a refused one goes back", async () => {
  let shown = ["choice-points", "undo"];
  let offline = false;
  const saved = [];
  const picture = () => ({ off: [], hidden: [], released: ["choice-points", "undo"], shown });
  const { actors, unwire } = await wire(["flags", "feature-flags"], {
    flags: {
      cached: null,
      remember: () => {},
      load: async () => picture(),
      save: async (feature, on, column) => {
        saved.push([feature, on, column]);
        if (offline) throw new Error("offline");
        shown = on ? [...shown, feature] : shown.filter((f) => f !== feature);
        return picture();
      },
    },
  });
  try {
    const view = actors["feature-flags"];
    await until(() => view.getSnapshot().context.released?.length === 2);
    // session is not mounted here, so the view takes the account as signed in by hand.
    view.send({ type: "session.changed", userId: "u1" });
    view.send({ type: "_switch", column: "show", feature: "undo", on: false });
    await until(() => Object.keys(view.getSnapshot().context.waiting).length === 0);
    assert.deepEqual(saved, [["undo", false, "show"]]);
    assert.deepEqual(view.getSnapshot().context.shown, ["choice-points"]);
    offline = true;
    view.send({ type: "_switch", column: "show", feature: "undo", on: true });
    await until(() => view.getSnapshot().context.refused?.id === "undo");
    assert.deepEqual(view.getSnapshot().context.shown, ["choice-points"], "nothing changed");
  } finally {
    unwire();
  }
});
