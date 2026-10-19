import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, nextGroup, nextTab, tabsOf, stripOf, entryOf } from "../machine.js";

const VIEWS = [
  { name: "token-sheet", label: "Tokens" },
  { name: "contract-list", label: "Contracts" },
  { name: "trace-list", label: "Trace" },
];

// The actor is where decisions live (3.2): it is driven with a fake ask, the shape
// the bus's `ask` returns (4.2).
function settle(ask, { views = VIEWS, narrow, pressed } = {}) {
  const actor = createActor(machine, { input: { ask, views, narrow, pressed } });
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

test("a view the stored layout never named joins its side at load while that side holds a tab", async () => {
  // The page gained a tab after the user's desk was stored: it joins the end of its
  // side, not the stage. A side the user emptied keeps such a view on the stage, since
  // the user may have moved it there.
  const views = [
    { name: "book-stage", label: "Reader" },
    { name: "notes", label: "Notes", side: "right" },
    { name: "evaluators", label: "Evaluators", side: "right" },
    { name: "outline", label: "Outline", side: "left" },
  ];
  const { actor, snapshot } = await settle(
    stored({ stage: "book-stage", docks: { right: { open: true, views: ["notes"], active: "notes" } } }),
    { views, narrow: () => true },
  );
  assert.deepEqual(layout(snapshot.context), {
    stage: "book-stage",
    docks: { right: { open: true, views: ["notes", "evaluators"], active: "notes" } },
  });
  // Moved to the stage tabs since: a layout from the fact that no longer names it keeps it there.
  actor.send({ type: "dock.changed", stage: "book-stage", docks: { right: { open: true, views: ["notes"] } } });
  assert.deepEqual(actor.getSnapshot().context.docks, { right: { open: true, views: ["notes"] } });
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
  { name: "chats", label: "Chat", side: "right", showsOn: "conversation.selected" },
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

test("a chat picked shows its tab on its side (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: { right: { open: false, views: ["note-editor", "chats"], active: "note-editor" } } }),
    { views: FOLLOWERS },
  );
  actor.send({ type: "conversation.selected", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
  assert.deepEqual(emitted, [
    {
      type: "dock.arranged",
      stage: "reader",
      docks: { right: { open: true, views: ["note-editor", "chats"], active: "chats" } },
    },
  ]);
});

test("an evaluator picked shows its tab on its side (6.4)", async () => {
  const views = [...FOLLOWERS, { name: "evaluators", label: "Evaluators", showsOn: "evaluator.selected" }];
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: { right: { open: true, views: ["chats", "evaluators"] } } }),
    { views },
  );
  actor.send({ type: "evaluator.selected", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", book: "01ARZ3NDEKTSV4RRFFQ69G5FAW" });
  assert.deepEqual(emitted, [
    { type: "dock.arranged", stage: "reader", docks: { right: { open: true, views: ["chats", "evaluators"], active: "evaluators" } } },
  ]);
});

// A list docked on the left whose pick shows its item on the stage, beside another stage
// tab: the item's tab comes forward when the list picks.
const PICKER = [
  { name: "reader", label: "Reader" },
  { name: "note-list", label: "Notes", side: "left" },
  { name: "note-editor", label: "Note", showsOn: "note.selected" },
];
const N = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("a pick in a docked list stages its item (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: { left: { open: true, views: ["note-list"] } } }),
    { views: PICKER },
  );
  actor.send({ type: "note.selected", id: N });
  assert.deepEqual(emitted.map((e) => e.stage), ["note-editor"]);
});

test("on a narrow desk, a pick in the left drawer folds the drawers and shows the item (6.4)", async () => {
  const docks = { left: { open: true, views: ["note-list"] }, right: { open: true, views: ["chats"] } };
  const { actor, emitted } = await settle(stored({ stage: "note-editor", docks }), {
    views: [...PICKER, { name: "chats", label: "Chat", side: "right" }],
    narrow: () => true,
  });
  actor.send({ type: "note.selected", id: N });
  assert.deepEqual(emitted, [
    {
      type: "dock.arranged",
      stage: "note-editor",
      docks: { left: { open: false, views: ["note-list"] }, right: { open: false, views: ["chats"] } },
    },
  ]);
});

test("on a wide desk, a pick leaves the docks open (6.4)", async () => {
  const docks = { left: { open: true, views: ["note-list"] } };
  const { actor, emitted } = await settle(stored({ stage: "note-editor", docks }), { views: PICKER, narrow: () => false });
  actor.send({ type: "note.selected", id: N });
  assert.deepEqual(emitted, [], "the item is already staged and the dock stays");
});

test("on a narrow desk, a gesture that shows a docked view keeps its own side open (6.4)", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: { left: { open: false, views: ["book-toc"] } } }),
    { views: FOLLOWERS, narrow: () => true },
  );
  actor.send({ type: "book.selected", id: "b1" });
  assert.deepEqual(emitted.at(-1).docks.left, { open: true, views: ["book-toc"], active: "book-toc" });
});

test("in failed, a pick stages its view (6.4)", async () => {
  const { actor } = await settle(stored({ error: "unavailable" }), { views: PICKER });
  actor.send({ type: "note.selected", id: N });
  assert.equal(actor.getSnapshot().context.stage, "note-editor");
});

test("in failed, _open switches the stage locally", async () => {
  const { actor, emitted } = await settle(stored({ error: "unavailable" }));
  actor.send({ type: "_open", name: "trace-list" });
  assert.equal(actor.getSnapshot().context.stage, "trace-list");
  assert.deepEqual(emitted, []);
});

// A header button (6.4): pressing shows its child on the stage, pressing again or
// choosing something else returns to the stage. `pressed` is the desk's own state,
// never emitted; the view keeps it in the browser and hands it back on a reload.
test("a pressed button handed back by the view starts pressed and still stores nothing", async () => {
  const { actor, emitted } = await settle(fresh, { pressed: "settings-tabs" });
  assert.equal(actor.getSnapshot().context.pressed, "settings-tabs");
  actor.send({ type: "_press", name: "settings-tabs" });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.deepEqual(emitted, []);
});

test("_press toggles pressed and a second name replaces it", async () => {
  const { actor, emitted } = await settle(fresh);
  actor.send({ type: "_press", name: "settings-sheet" });
  assert.equal(actor.getSnapshot().context.pressed, "settings-sheet");
  // A second name replaces, so only one child ever holds the stage.
  actor.send({ type: "_press", name: "help-sheet" });
  assert.equal(actor.getSnapshot().context.pressed, "help-sheet");
  // The same name again toggles back to the stage.
  actor.send({ type: "_press", name: "help-sheet" });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.deepEqual(emitted, [], "pressing a header button stores nothing");
});

test("a stage tab click clears the pressed header button and still emits the layout", async () => {
  const { actor, emitted } = await settle(fresh);
  actor.send({ type: "_press", name: "settings-sheet" });
  actor.send({ type: "_open", name: "trace-list" });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.deepEqual(emitted, [{ type: "dock.arranged", stage: "trace-list", docks: {} }]);
  assert.ok(!("pressed" in emitted[0]), "pressed rides no fact");
});

test("an _open whose guard fails still clears the pressed button and emits nothing", async () => {
  const { actor, emitted } = await settle(fresh);
  actor.send({ type: "_press", name: "settings-sheet" });
  actor.send({ type: "_open", name: "ghost" });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.deepEqual(emitted, [], "a non-stage-tab name stores nothing");
});

test("a selection gesture that changes the layout clears pressed and emits its layout", async () => {
  const { actor, emitted } = await settle(stored({ stage: "reader", docks: {} }), { views: FOLLOWERS });
  actor.send({ type: "_press", name: "settings-sheet" });
  actor.send({ type: "note.selected", id: "n1" });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.deepEqual(emitted, [{ type: "dock.arranged", stage: "note-editor", docks: {} }]);
});

test("a selection gesture that changes nothing still clears pressed and emits nothing", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "reader", docks: { left: { open: true, views: ["book-toc"], active: "book-toc" } } }),
    { views: FOLLOWERS },
  );
  actor.send({ type: "_press", name: "settings-sheet" });
  actor.send({ type: "book.selected", id: "b1" });
  assert.equal(actor.getSnapshot().context.pressed, null, "choosing something else ends the detour");
  assert.deepEqual(emitted, [], "the tab is already shown, so `dock` stores nothing");
});

test("clicking a dock tab, folding, and the fact's news leave the pressed button alone", async () => {
  const { actor } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["trace-list"] } } }),
  );
  actor.send({ type: "_press", name: "settings-sheet" });
  actor.send({ type: "_activate", name: "trace-list", side: "right" });
  actor.send({ type: "_fold", side: "right" });
  actor.send({ type: "dock.changed", stage: "token-sheet", docks: {} });
  actor.send({ type: "settings.changed", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: false });
  assert.equal(actor.getSnapshot().context.pressed, "settings-sheet", "only leaving the detour clears it");
});

test("in failed, _press toggles and a stage tab or a gesture clears it", async () => {
  const { actor, emitted } = await settle(stored({ error: "unavailable" }));
  actor.send({ type: "_press", name: "settings-sheet" });
  assert.equal(actor.getSnapshot().context.pressed, "settings-sheet");
  actor.send({ type: "_open", name: "trace-list" });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.equal(actor.getSnapshot().context.stage, "trace-list");
  actor.send({ type: "_press", name: "settings-sheet" });
  actor.send({ type: "note.selected", id: "n1" });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.deepEqual(emitted, [], "a failed desk stores nothing");
});

// "Vim keys" (12): the desk reads the preference with arranging and follows it.
test("vimKeys comes from the settings read and follows settings.changed", async () => {
  const { actor } = await settle(stored({ stage: "token-sheet", docks: {} }, { vimKeys: true }));
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "settings.changed", nav: [], arranging: true, vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
  actor.send({ type: "settings.changed", nav: [], arranging: true, vimKeys: true });
  assert.equal(actor.getSnapshot().context.vimKeys, true);
});

test("vimKeys is off when the settings read has none or fails", async () => {
  const off = await settle(stored({ stage: "token-sheet", docks: {} }));
  assert.equal(off.actor.getSnapshot().context.vimKeys, false);
  const failed = await settle((target) =>
    target === "settings" ? Promise.resolve({ error: "no-answerer" }) : Promise.resolve({ stage: null, docks: {} }),
  );
  assert.equal(failed.actor.getSnapshot().context.vimKeys, false);
});

test("Ctrl+h and Ctrl+l walk left dock, stage, right dock, passing over what is missing", () => {
  const all = ["left", "stage", "right", "bottom"];
  assert.equal(nextGroup("stage", "l", all), "right");
  assert.equal(nextGroup("stage", "h", all), "left");
  assert.equal(nextGroup("left", "l", all), "stage");
  assert.equal(nextGroup("right", "h", all), "stage");
  assert.equal(nextGroup("right", "l", all), null, "the right edge goes nowhere");
  assert.equal(nextGroup("left", "h", all), null, "the left edge goes nowhere");
  assert.equal(nextGroup("left", "l", ["left", "right"]), "right", "an empty stage is passed over");
  assert.equal(nextGroup("stage", "h", ["stage", "right"]), null, "no left dock, nowhere to go");
});

test("Ctrl+j goes down to the bottom dock and Ctrl+k back up to the stage", () => {
  const all = ["left", "stage", "right", "bottom"];
  for (const from of ["left", "stage", "right"]) assert.equal(nextGroup(from, "j", all), "bottom");
  assert.equal(nextGroup("bottom", "j", all), null);
  assert.equal(nextGroup("bottom", "k", all), "stage");
  assert.equal(nextGroup("stage", "k", all), null);
  assert.equal(nextGroup("stage", "j", ["left", "stage"]), null, "no bottom dock");
  assert.equal(nextGroup("bottom", "h", all), "left", "the bottom spans under the row");
  assert.equal(nextGroup("bottom", "l", all), "right");
});

// The tab keys step through a group in the order its strip draws it, left to right.
test("the tab keys follow a side's own order after its tabs were moved", async () => {
  const views = [...VIEWS, { name: "note-list", label: "Notes" }];
  const { actor, emitted } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["contract-list", "trace-list"] } } }),
    { views },
  );
  actor.send({ type: "_shift", name: "trace-list", step: -1 });
  actor.send({ ...emitted.at(-1), type: "dock.changed" });
  actor.send({ type: "_dock", name: "note-list", side: "right" });
  actor.send({ ...emitted.at(-1), type: "dock.changed" });
  const { context } = actor.getSnapshot();
  assert.deepEqual(tabsOf(context, "right"), ["trace-list", "contract-list", "note-list"]);
  assert.deepEqual(nextTab(context, "right", { view: "trace-list" }, 1), { view: "contract-list" });
  assert.deepEqual(nextTab(context, "right", { view: "note-list" }, 1), { view: "trace-list" });
  assert.deepEqual(nextTab(context, "right", { view: "trace-list" }, -1), { view: "note-list" });
});

test("the stage's tab keys follow the page's order, which a returned tab takes", async () => {
  const { actor, emitted } = await settle(
    stored({ stage: "token-sheet", docks: { right: { open: true, views: ["contract-list"] } } }),
  );
  actor.send({ type: "_undock", name: "contract-list" });
  actor.send({ ...emitted.at(-1), type: "dock.changed" });
  const { context } = actor.getSnapshot();
  assert.deepEqual(tabsOf(context, "stage"), ["token-sheet", "contract-list", "trace-list"]);
  assert.deepEqual(nextTab(context, "stage", { view: "token-sheet" }, 1), { view: "contract-list" });
  assert.deepEqual(nextTab(context, "stage", { view: "token-sheet" }, -1), { view: "trace-list" });
});

test("the tab keys from no shown tab start at an end, and an empty group has none", () => {
  const context = { views: VIEWS, docks: { left: { open: true, views: ["trace-list"] } } };
  assert.deepEqual(nextTab(context, "stage", null, 1), { view: "token-sheet" });
  assert.deepEqual(nextTab(context, "stage", null, -1), { view: "contract-list" });
  assert.deepEqual(nextTab(context, "left", { view: "trace-list" }, 1), { view: "trace-list" });
  assert.equal(nextTab(context, "bottom", null, 1), null);
});

// A child that announces its own tabs (tabs.shown) is drawn as them, in its place.
const BOOKS = {
  type: "tabs.shown",
  view: "contract-list",
  tabs: [
    { id: "journal", label: "Journal", closable: true },
    { id: "b1", label: "Walden", closable: true },
    { id: "b2", label: "Emma", closable: false },
  ],
  active: "b1",
};

async function withTabs({ arranging = false, docks = {} } = {}) {
  const settled = await settle(stored({ stage: "contract-list", docks }, { arranging }));
  const picked = [];
  const closed = [];
  settled.actor.on("tab.picked", (e) => picked.push(e));
  settled.actor.on("tab.closed", (e) => closed.push(e));
  settled.actor.send(BOOKS);
  return { ...settled, picked, closed };
}

test("a child's own tabs take its place in the strip, in order", async () => {
  const { actor } = await withTabs();
  const { context } = actor.getSnapshot();
  assert.deepEqual(
    stripOf(context, "stage").map((e) => e.id ?? e.view),
    ["token-sheet", "journal", "b1", "b2", "trace-list"],
  );
  assert.deepEqual(entryOf(context, "contract-list"), { view: "contract-list", id: "b1" });
  assert.deepEqual(entryOf(context, "token-sheet"), { view: "token-sheet" });
});

test("the tab keys step through a child's tabs inside the group's order", async () => {
  const { actor } = await withTabs();
  const { context } = actor.getSnapshot();
  const shown = { view: "contract-list", id: "b1" };
  assert.equal(nextTab(context, "stage", shown, 1).id, "b2");
  assert.equal(nextTab(context, "stage", shown, -1).id, "journal");
  assert.deepEqual(nextTab(context, "stage", { view: "contract-list", id: "b2" }, 1), { view: "trace-list" });
  assert.equal(nextTab(context, "stage", { view: "token-sheet" }, 1).id, "journal");
  assert.deepEqual(nextTab(context, "stage", { view: "token-sheet" }, -1), { view: "trace-list" }, "wraps");
});

test("a docked child's tabs are drawn on its side", async () => {
  const { actor } = await withTabs({ docks: { right: { open: true, views: ["trace-list", "contract-list"] } } });
  const { context } = actor.getSnapshot();
  assert.deepEqual(stripOf(context, "right").map((e) => e.id ?? e.view), ["trace-list", "journal", "b1", "b2"]);
  assert.deepEqual(stripOf(context, "stage").map((e) => e.view), ["token-sheet"]);
});

test("while arranging, or with no tabs, the child is its one tab", async () => {
  const { actor } = await withTabs({ arranging: true });
  assert.deepEqual(stripOf(actor.getSnapshot().context, "stage"), [
    { view: "token-sheet" },
    { view: "contract-list" },
    { view: "trace-list" },
  ]);
  assert.deepEqual(entryOf(actor.getSnapshot().context, "contract-list"), { view: "contract-list" });
  actor.send({ type: "settings.changed", arranging: false, vimKeys: false });
  actor.send({ ...BOOKS, tabs: [], active: null });
  assert.deepEqual(stripOf(actor.getSnapshot().context, "stage").map((e) => e.view), ["token-sheet", "contract-list", "trace-list"]);
});

test("tabs.shown from a view not on the desk is ignored", async () => {
  const { actor } = await withTabs();
  actor.send({ ...BOOKS, view: "ghost" });
  assert.equal(actor.getSnapshot().context.tabs.ghost, undefined);
});

test("picking another of a staged child's tabs emits tab.picked and leaves the layout", async () => {
  const { actor, emitted, picked } = await withTabs();
  const before = emitted.length;
  actor.send({ type: "_pick", name: "contract-list", id: "b2" });
  assert.deepEqual(picked, [{ type: "tab.picked", view: "contract-list", id: "b2" }]);
  assert.equal(emitted.length, before, "the child is already staged");
  actor.send({ type: "_pick", name: "contract-list", id: "b1" });
  assert.equal(picked.length, 1, "the tab already in front is not picked again");
  actor.send({ type: "_pick", name: "contract-list", id: "nope" });
  assert.equal(picked.length, 1, "a tab the child did not announce");
});

test("picking a child's tab stages the child, and clears a pressed button", async () => {
  const { actor, emitted, picked } = await withTabs();
  actor.send({ type: "_open", name: "token-sheet" });
  actor.send({ ...emitted.at(-1), type: "dock.changed" });
  actor.send({ type: "_press", name: "settings-sheet" });
  actor.send({ type: "_pick", name: "contract-list", id: "b1" });
  assert.deepEqual(emitted.at(-1), { type: "dock.arranged", stage: "contract-list", docks: {} });
  assert.equal(actor.getSnapshot().context.pressed, null);
  assert.equal(picked.length, 0, "b1 was already the child's tab in front");
});

test("picking a docked child's tab shows it on its side, unfolded", async () => {
  const { actor, emitted, picked } = await withTabs({ docks: { right: { open: false, views: ["trace-list", "contract-list"] } } });
  actor.send({ type: "_pick", name: "contract-list", id: "journal" });
  assert.deepEqual(emitted.at(-1).docks.right, { open: true, views: ["trace-list", "contract-list"], active: "contract-list" });
  assert.deepEqual(picked, [{ type: "tab.picked", view: "contract-list", id: "journal" }]);
});

test("the close button emits tab.closed for a closable tab only", async () => {
  const { actor, closed } = await withTabs();
  actor.send({ type: "_close", name: "contract-list", id: "journal" });
  actor.send({ type: "_close", name: "contract-list", id: "b2" });
  assert.deepEqual(closed, [{ type: "tab.closed", view: "contract-list", id: "journal" }]);
});
