import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

const VIEWS = [
  { name: "token-sheet", label: "Tokens" },
  { name: "contract-list", label: "Contracts" },
  { name: "trace-list", label: "Trace" },
];

// The actor is where decisions live (3.2): it is driven with a fake ask, the shape
// the bus's `ask` returns (4.2).
function settle(ask, { views = VIEWS } = {}) {
  const actor = createActor(machine, { input: { ask, views } });
  const emitted = [];
  actor.on("dock.arranged", (e) => emitted.push(e));
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (!s.matches("loading")) resolve({ actor, emitted, snapshot: s });
    });
    actor.start();
  });
}

const layout = (ctx) => ({ stage: ctx.stage, docks: ctx.docks });
const stored = (value) => () => Promise.resolve(value);

test("the starting picture is reconciled to the children present", async () => {
  // Unknown names dropped, a docked view is never the stage, the stored stage kept.
  const { snapshot } = await settle(
    stored({ stage: "trace-list", docks: { right: { open: true, views: ["contract-list", "ghost"] } } }),
  );
  assert.equal(snapshot.value, "ready");
  assert.deepEqual(layout(snapshot.context), {
    stage: "trace-list",
    docks: { right: { open: true, views: ["contract-list"] } },
  });
});

test("a side left empty after reconciling is dropped", async () => {
  const { snapshot } = await settle(stored({ stage: "token-sheet", docks: { right: { open: true, views: ["ghost"] } } }));
  assert.deepEqual(layout(snapshot.context), { stage: "token-sheet", docks: {} });
});

test("a stage that is docked or unknown falls back to the first candidate", async () => {
  const { snapshot } = await settle(
    stored({ stage: "token-sheet", docks: { left: { open: false, views: ["token-sheet"] } } }),
  );
  assert.deepEqual(layout(snapshot.context), {
    stage: "contract-list",
    docks: { left: { open: false, views: ["token-sheet"] } },
  });
});

test("reconcile keeps a valid active and drops a stale one", async () => {
  const kept = await settle(
    stored({ stage: null, docks: { right: { open: true, views: ["token-sheet", "trace-list"], active: "trace-list" } } }),
  );
  assert.equal(kept.snapshot.context.docks.right.active, "trace-list");
  const stale = await settle(
    stored({ stage: null, docks: { right: { open: true, views: ["token-sheet", "ghost"], active: "ghost" } } }),
  );
  assert.deepEqual(stale.snapshot.context.docks.right, { open: true, views: ["token-sheet"] });
});

test("an error reply fails the view", async () => {
  const { snapshot } = await settle(stored({ error: "unavailable" }));
  assert.equal(snapshot.value, "failed");
});

test("a rejected ask fails the view", async () => {
  const { snapshot } = await settle(() => Promise.reject(new Error("boom")));
  assert.equal(snapshot.value, "failed");
});

const fresh = stored({ stage: "token-sheet", docks: {} });

test("_open emits the whole layout and does not change context", async () => {
  const { actor, emitted, snapshot } = await settle(fresh);
  const before = layout(snapshot.context);
  actor.send({ type: "_open", name: "trace-list" });
  assert.deepEqual(emitted, [{ type: "dock.arranged", stage: "trace-list", docks: {} }]);
  assert.deepEqual(layout(actor.getSnapshot().context), before);
});

test("_dock opens the side on the view and moves the stage on", async () => {
  const { actor, emitted } = await settle(fresh);
  actor.send({ type: "_dock", name: "token-sheet", side: "right" });
  assert.deepEqual(emitted, [
    {
      type: "dock.arranged",
      stage: "contract-list",
      docks: { right: { open: true, views: ["token-sheet"], active: "token-sheet" } },
    },
  ]);
});

test("_dock needs a side", async () => {
  const { actor, emitted } = await settle(fresh);
  actor.send({ type: "_dock", name: "token-sheet" });
  assert.deepEqual(emitted, []);
});

test("_dock of the last stage tab leaves the stage empty", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "trace-list", docks: { left: { open: true, views: ["token-sheet", "contract-list"] } } }),
  );
  actor.send({ type: "_dock", name: "trace-list", side: "bottom" });
  assert.equal(emitted[0].stage, null);
});

test("_undock stages the returned view", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["trace-list"] } } }),
  );
  actor.send({ type: "_undock", name: "trace-list" });
  assert.deepEqual(emitted, [{ type: "dock.arranged", stage: "trace-list", docks: {} }]);
});

test("_move into a folded side unfolds it and shows the mover", async () => {
  const { actor, emitted } = await settle(
    stored({
      stage: "token-sheet",
      docks: { right: { open: true, views: ["trace-list"] }, bottom: { open: false, views: ["contract-list"] } },
    }),
  );
  actor.send({ type: "_move", name: "trace-list", side: "bottom" });
  assert.deepEqual(emitted, [
    {
      type: "dock.arranged",
      stage: "token-sheet",
      docks: { bottom: { open: true, views: ["contract-list", "trace-list"], active: "trace-list" } },
    },
  ]);
});

test("a side's active follows the removal of the shown tab", async () => {
  const { actor, emitted } = await settle(
    stored({
      stage: null,
      docks: { right: { open: true, views: ["token-sheet", "contract-list", "trace-list"], active: "contract-list" } },
    }),
  );
  actor.send({ type: "_move", name: "contract-list", side: "left" });
  assert.deepEqual(emitted[0].docks, {
    right: { open: true, views: ["token-sheet", "trace-list"], active: "token-sheet" },
    left: { open: true, views: ["contract-list"], active: "contract-list" },
  });
});

test("_move to the same side does nothing", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["trace-list"] } } }),
  );
  actor.send({ type: "_move", name: "trace-list", side: "right" });
  assert.deepEqual(emitted, []);
});

test("_activate shows the tab and unfolds its side", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: null, docks: { left: { open: false, views: ["token-sheet", "trace-list"] } } }),
  );
  actor.send({ type: "_activate", name: "trace-list", side: "left" });
  assert.deepEqual(emitted, [
    {
      type: "dock.arranged",
      stage: "contract-list",
      docks: { left: { open: true, views: ["token-sheet", "trace-list"], active: "trace-list" } },
    },
  ]);
  actor.send({ type: "_activate", name: "contract-list", side: "left" });
  assert.equal(emitted.length, 1, "a tab not on that side is ignored");
});

test("_fold and _unfold set that side's open flag", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["trace-list"] } } }),
  );
  actor.send({ type: "_fold", side: "right" });
  actor.send({ type: "_unfold", side: "right" });
  assert.deepEqual(
    emitted.map((e) => e.docks.right.open),
    [false, true],
  );
});

test("dock.changed is adopted (4.3, fourth rule)", async () => {
  const { actor } = await settle(fresh);
  actor.send({
    type: "dock.changed",
    stage: "token-sheet",
    docks: { bottom: { open: true, views: ["trace-list"] } },
  });
  assert.deepEqual(layout(actor.getSnapshot().context), {
    stage: "token-sheet",
    docks: { bottom: { open: true, views: ["trace-list"] } },
  });
});

test("in failed, _open switches the stage locally", async () => {
  const { actor, emitted } = await settle(stored({ error: "unavailable" }));
  actor.send({ type: "_open", name: "trace-list" });
  assert.equal(actor.getSnapshot().context.stage, "trace-list");
  assert.deepEqual(emitted, []);
});
