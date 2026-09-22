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
function settle(ask, { views = VIEWS, narrow, marking } = {}) {
  const actor = createActor(machine, { input: { ask, views, narrow, marking } });
  const emitted = [];
  actor.on("dock.arranged", (e) => emitted.push(e));
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready") || s.matches("failed")) resolve({ actor, emitted, snapshot: s });
    });
    actor.start();
  });
}

const layout = (ctx) => ({ stage: ctx.stage, docks: ctx.docks });
// The dock read answers `value`; the settings read answers an arrangeable desk by
// default, or `settings` when a test turns arranging off.
const stored = (value, settings = {}) => (target) =>
  target === "settings"
    ? Promise.resolve({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, ...settings })
    : Promise.resolve(value);

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

test("an instanced view (name#id, 4.1) is reconciled, staged and docked like any name", async () => {
  // The machine treats a name as an opaque string, so the `#id` a page gives two
  // instances of one view flows through reconcile untouched. The page-level check
  // that two instances live as distinct tabs waits for a page that holds two.
  const views = [
    { name: "list-then-item#books", label: "Books", side: "left" },
    { name: "list-then-item#notes", label: "Notes", side: "right" },
  ];
  const { snapshot } = await settle(
    stored({ stage: "list-then-item#books", docks: { right: { open: true, views: ["list-then-item#notes"] } } }),
    { views },
  );
  assert.deepEqual(layout(snapshot.context), {
    stage: "list-then-item#books",
    docks: { right: { open: true, views: ["list-then-item#notes"] } },
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

test("an empty layout seeds from the children's declared sides", async () => {
  // A fresh desk (nothing staged, nothing docked): a view declaring side:"right"
  // lands docked open on the right, the stage takes the first undocked view.
  const views = [
    { name: "note-editor", label: "Editor" },
    { name: "note-list", label: "Notes" },
    { name: "trace-list", label: "Trace", side: "right" },
  ];
  const { snapshot } = await settle(stored({ stage: null, docks: {} }), { views });
  assert.equal(snapshot.value, "ready");
  assert.deepEqual(layout(snapshot.context), {
    stage: "note-editor",
    docks: { right: { open: true, views: ["trace-list"] } },
  });
});

test("a narrow desk seeds left and right folded, the bottom open", async () => {
  // Too narrow for a dock beside the stage (6.4): an open left/right would be a
  // drawer over the stage and its header, so it seeds folded; the bottom is a sheet
  // under the stage, so it stays open.
  const views = [
    { name: "note-editor", label: "Editor" },
    { name: "note-list", label: "Notes", side: "right" },
    { name: "trace-list", label: "Trace", side: "bottom" },
  ];
  const { snapshot } = await settle(stored({ stage: null, docks: {} }), { views, narrow: () => true });
  assert.deepEqual(layout(snapshot.context), {
    stage: "note-editor",
    docks: { right: { open: false, views: ["note-list"] }, bottom: { open: true, views: ["trace-list"] } },
  });
});

test("a stored layout wins over declared sides even on a narrow desk", async () => {
  // A user's arrangement is reconciled untouched; narrow only affects the seed.
  const views = [
    { name: "note-editor", label: "Editor" },
    { name: "note-list", label: "Notes", side: "right" },
  ];
  const { snapshot } = await settle(
    stored({ stage: "note-editor", docks: { right: { open: true, views: ["note-list"] } } }),
    { views, narrow: () => true },
  );
  assert.deepEqual(layout(snapshot.context), {
    stage: "note-editor",
    docks: { right: { open: true, views: ["note-list"] } },
  });
});

test("a stored layout wins over declared sides", async () => {
  // The user has arranged the desk: their layout is reconciled, the declared side
  // is ignored (trace-list stays a stage tab because storage docks nothing).
  const views = [
    { name: "note-editor", label: "Editor" },
    { name: "trace-list", label: "Trace", side: "right" },
  ];
  const { snapshot } = await settle(stored({ stage: "trace-list", docks: {} }), { views });
  assert.deepEqual(layout(snapshot.context), { stage: "trace-list", docks: {} });
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

test("_shift swaps a docked tab with its neighbour and keeps the rest (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({
      stage: null,
      docks: {
        left: { open: false, views: ["trace-list"] },
        right: { open: true, views: ["token-sheet", "contract-list"], active: "contract-list" },
      },
    }),
  );
  actor.send({ type: "_shift", name: "contract-list", step: -1 });
  actor.send({ type: "_shift", name: "token-sheet", step: -1 });
  assert.deepEqual(emitted, [
    {
      type: "dock.arranged",
      stage: null,
      docks: {
        left: { open: false, views: ["trace-list"] },
        right: { open: true, views: ["contract-list", "token-sheet"], active: "contract-list" },
      },
    },
    // The desk assigns nothing itself, so the second gesture still sees the stored
    // order: token-sheet is first there, and a step off the end announces nothing.
  ]);
  actor.send({ type: "_shift", name: "token-sheet", step: 1 });
  assert.deepEqual(emitted[1].docks.right.views, ["contract-list", "token-sheet"]);
});

test("_shift off either end, of a stage tab, or by another step does nothing", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["trace-list", "contract-list"] } } }),
  );
  actor.send({ type: "_shift", name: "trace-list", step: -1 });
  actor.send({ type: "_shift", name: "contract-list", step: 1 });
  actor.send({ type: "_shift", name: "token-sheet", step: 1 });
  actor.send({ type: "_shift", name: "trace-list", step: 2 });
  actor.send({ type: "_shift", name: "trace-list" });
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

test("a desk not being arranged bars arranging, but folds and switches tabs", async () => {
  const { actor, emitted } = await settle(
    stored(
      { stage: "token-sheet", docks: { right: { open: true, views: ["trace-list", "contract-list"] } } },
      { arranging: false },
    ),
  );
  assert.equal(actor.getSnapshot().context.arranging, false);
  actor.send({ type: "_dock", name: "token-sheet", side: "left" });
  actor.send({ type: "_undock", name: "trace-list" });
  actor.send({ type: "_move", name: "trace-list", side: "bottom" });
  actor.send({ type: "_shift", name: "trace-list", step: 1 });
  assert.deepEqual(emitted, [], "no dock/undock/move/shift gesture is honoured while not arranging");

  // Folding is daily use, not a layout change: it stays while not arranging.
  actor.send({ type: "_fold", side: "right" });
  actor.send({ type: "_unfold", side: "right" });
  assert.deepEqual(
    emitted.map((e) => e.docks.right.open),
    [false, true],
    "folds and unfolds while not arranging",
  );

  // Viewing is not arranging: a rail tab still shows its tab and unfolds its side.
  actor.send({ type: "_activate", name: "contract-list", side: "right" });
  assert.equal(emitted.length, 3, "a rail tab still unfolds its side (_activate)");
  assert.equal(emitted[2].docks.right.active, "contract-list");
});

test("settings.changed turns arranging off and on (4.3, fourth rule)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["trace-list"] } } }),
  );
  actor.send({ type: "settings.changed", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: false });
  assert.equal(actor.getSnapshot().context.arranging, false);
  actor.send({ type: "_undock", name: "trace-list" });
  assert.deepEqual(emitted, [], "not arrangeable after settings.changed");
  actor.send({ type: "settings.changed", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true });
  actor.send({ type: "_undock", name: "trace-list" });
  assert.equal(emitted.length, 1, "arrangeable again");
});

// Views that follow a selection gesture with `shows-on` (6.4).
const FOLLOWERS = [
  { name: "reader", label: "Reader" },
  { name: "book-toc", label: "Contents", side: "left", showsOn: "book.selected" },
  { name: "note-editor", label: "Editor", showsOn: "note.selected" },
];

test("a shows-on view docked on a folded side is shown and unfolded (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: { left: { open: false, views: ["book-toc"] } } }),
    { views: FOLLOWERS },
  );
  actor.send({ type: "book.selected", id: "b1" });
  assert.deepEqual(emitted, [
    {
      type: "dock.arranged",
      stage: "reader",
      docks: { left: { open: true, views: ["book-toc"], active: "book-toc" } },
    },
  ]);
});

test("a shows-on view on the stage is staged (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: {} }),
    { views: FOLLOWERS },
  );
  actor.send({ type: "note.selected", id: "n1" });
  assert.deepEqual(emitted, [{ type: "dock.arranged", stage: "note-editor", docks: {} }]);
});

test("a shows-on view already in view announces nothing (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: { left: { open: true, views: ["book-toc"], active: "book-toc" } } }),
    { views: FOLLOWERS },
  );
  actor.send({ type: "book.selected", id: "b1" });
  assert.deepEqual(emitted, [], "the tab is already shown, so `dock` stores nothing");
});

test("a shows-on gesture is followed while not arranging (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: {} }, { arranging: false }),
    { views: FOLLOWERS },
  );
  actor.send({ type: "note.selected", id: "n1" });
  assert.deepEqual(emitted, [{ type: "dock.arranged", stage: "note-editor", docks: {} }]);
});

test("in failed, a shows-on gesture stages the followed view (6.4)", async () => {
  const { actor } = await settle(stored({ error: "unavailable" }), { views: FOLLOWERS });
  actor.send({ type: "note.selected", id: "n1" });
  assert.equal(actor.getSnapshot().context.stage, "note-editor");
});

test("in failed, _open switches the stage locally", async () => {
  const { actor, emitted } = await settle(stored({ error: "unavailable" }));
  actor.send({ type: "_open", name: "trace-list" });
  assert.equal(actor.getSnapshot().context.stage, "trace-list");
  assert.deepEqual(emitted, []);
});

// The subject mark (12): with `marks-subject`, the desk asks `subject: read` and
// follows `subject.changed`, so it knows which tab to mark. Off, it asks nothing.
const SUBJECT = { kind: "book", id: "b1", title: "Dune", view: "book-reader" };
const withSubject =
  (subject) =>
  (target, name) => {
    if (target === "subject" && name === "read") return Promise.resolve({ subject });
    if (target === "settings")
      return Promise.resolve({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true });
    return Promise.resolve({ stage: "book-reader", docks: {} });
  };

test("without marks-subject the desk asks no subject and marks nothing", async () => {
  // The ask would answer a subject, but the flag is off, so it is never asked.
  const asked = [];
  const ask = (target, name, payload) => {
    asked.push(`${target}:${name}`);
    return withSubject(SUBJECT)(target, name, payload);
  };
  const { snapshot } = await settle(ask);
  assert.equal(snapshot.context.subject, null);
  assert.ok(!asked.includes("subject:read"));
});

test("with marks-subject the context follows subject: read then subject.changed", async () => {
  const { actor } = await settle(withSubject(SUBJECT), { marking: true });
  // Give the lifelong subject read a tick to land.
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(actor.getSnapshot().context.subject, SUBJECT);
  actor.send({ type: "subject.changed", subject: null });
  assert.equal(actor.getSnapshot().context.subject, null);
});

test("with marks-subject and no subject answerer the context stays null", async () => {
  const { actor } = await settle(withSubject(null), { marking: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(actor.getSnapshot().context.subject, null);
});
