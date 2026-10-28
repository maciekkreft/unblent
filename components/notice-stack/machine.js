import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view of refused gestures (12): what a fact could not honour, shown where the
// user can see it. It owns only UI state — the notices on screen and their fade
// timers — and learns everything from the facts' own events. It is the one view
// allowed to act on a conflict: keeping the user's copy re-emits note.saved, the
// view where the user acted being a permitted sender (4). notes otherwise adopts
// the server's copy and the edit is lost, so this is where the copy survives.
//
// One row per consumed event, below: what its key is (a repeat replaces, so the
// stack never fills with the same news twice), whether it stands until dismissed
// or passes on its own, and which actions it offers. A future refusal is one more
// row and one more handler; nothing else here changes.
const TABLE = {
  "note.conflicted": (p) => ({
    key: `note.conflicted:${p.id}`,
    standing: true,
    actions: [
      {
        label: "keep-mine",
        // Based on theirs: after a conflict notes holds the server's copy at that
        // version (5), so this save lands as a fresh edit on top of it.
        emit: { type: "note.saved", id: p.id, title: p.mine.title, body: p.mine.body, baseVersion: p.theirs.version },
      },
    ],
  }),
  "session.refused": (p) => ({
    key: `session.refused:${p.reason}`,
    // A closed registry or an unknown passkey needs the user to act; a cancelled
    // prompt or a network fault is only news.
    standing: p.reason === "registration-closed" || p.reason === "unknown-credential",
    actions: [],
  }),
  // A book could not be added (signed out, not an epub, server down): only news, one
  // row per reason so a repeat replaces rather than piles up.
  "book.refused": (p) => ({
    key: `book.refused:${p.reason}`,
    standing: false,
    actions: [],
  }),
  // A removal waits out the undo window here, so every delete is reversible in one step: Undo brings
  // the thing back; the window running out, or a dismiss, lets it go. One row per
  // thing, so several removals stack, each with its own window.
  "removal.started": (p) => ({
    key: `removal:${p.kind}:${p.id}`,
    standing: false,
    actions: [{ label: "undo", emit: { type: "removal.undone", kind: p.kind, id: p.id } }],
    settle: { type: "removal.settled", kind: p.kind, id: p.id },
  }),
  // The admin's actions on a guest in People (12) take effect at once; Undo sends the
  // opposite gesture. An Undo of Reset use is itself no news to show.
  "use.reset": (p) =>
    p.undone
      ? null
      : {
          key: `use.reset:${p.user}`,
          standing: false,
          undo: true,
          actions: [{ label: "undo", emit: { type: "use.reset", user: p.user, undone: true } }],
        },
  "guest.blocked": (p) => ({
    key: `guest.blocked:${p.user}`,
    standing: false,
    undo: true,
    actions: [{ label: "undo", emit: { type: "guest.blocked", user: p.user, blocked: !p.blocked } }],
  }),
  // A step that asked for it (a delete) shows the dark notice with Undo, the same as the
  // top bar's, and no countdown: Undo goes on working after it has gone (12, Undo). One
  // notice for all of them, so the next one replaces it.
  "step.recorded": (p) =>
    p.notice === true
      ? {
          key: "step",
          step: p.id,
          standing: false,
          undo: true,
          bar: false,
          actions: [{ label: "undo", emit: { type: "step.requested", direction: "undo" } }],
        }
      : null,
  // A step its owner refused, or one whose owner is not on this page, is only news.
  "step.settled": (p, context) => {
    if (p.outcome === "applied") return null;
    const known = context.steps[p.id];
    return {
      key: `step.settled:${p.id}`,
      standing: false,
      actions: [],
      source: { ...p, label: known?.label ?? "", side: known?.side ?? "undo" },
    };
  },
};

// A Map with one entry replaced, or removed, as a new Map so assign sees a fresh
// value (XState keeps context immutable). Insertion order is display order, so a
// replaced notice keeps its place.
const replaced = (map, notice) => new Map(map).set(notice.key, notice);
const without = (map, key) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

// A passing notice fades after the window; a standing one has no timer. The cancel
// first makes a repeat restart its window rather than end early.
function fade(context, notice, enqueue) {
  enqueue.cancel(`fade:${notice.key}`);
  if (notice.standing) return;
  enqueue.raise({ type: "_elapsed", key: notice.key }, { delay: ({ context }) => context.fadeMs, id: `fade:${notice.key}` });
}

// A notice that ends without its action (elapsed, dismissed, the page leaving) lets
// its pending news go out, if it has any: a removal settles.
function end(context, key, enqueue) {
  const settle = context.notices.get(key)?.settle;
  if (settle) enqueue.emit(settle);
  enqueue.cancel(`fade:${key}`);
  enqueue.assign({ notices: ({ context }) => without(context.notices, key) });
}

function show(context, event, enqueue) {
  const row = TABLE[event.type](event, context);
  if (!row) return;
  const notice = {
    key: row.key,
    standing: row.standing,
    source: row.source ?? event,
    actions: row.actions,
    settle: row.settle ?? null,
    undo: Boolean(row.settle || row.undo),
    bar: row.bar !== false,
    step: row.step ?? null,
    gone: false,
  };
  enqueue.assign({ notices: ({ context }) => replaced(context.notices, notice) });
  fade(context, notice, enqueue);
}

// What Undo and Redo name now, remembered by id with the side it stood on, so a refusal
// can name its step after `undo` has dropped it.
function learn(context, picture, enqueue) {
  const steps = { ...context.steps };
  for (const side of ["undo", "redo"]) {
    const step = picture?.[side];
    if (step && typeof step.id === "string") steps[step.id] = { label: step.label, side };
  }
  enqueue.assign({ steps });
  // The delete notice is about the step on top; once another is, it goes.
  const notice = context.notices.get("step");
  if (notice && picture && picture.undo?.id !== notice.step) {
    enqueue.cancel("fade:step");
    enqueue.assign({ notices: ({ context }) => without(context.notices, "step") });
  }
}

export const machine = setup({
  actors: {
    // On a page without undo the reply is no-answerer and no step is named.
    undo: fromPromise(({ input }) => (input.ask ? input.ask("undo", "read", {}) : Promise.resolve(null))),
  },
}).createMachine({
  id: "notice-stack",
  meta: {
    description:
      "Shows what a fact could not do for the user as notices that can be dismissed: a refused " +
      "sign-in, a book that could not be added, and a save conflict. A conflict offers Keep mine, which saves " +
      "the user's copy again, because `notes` otherwise keeps the server's copy. Something the " +
      "user deleted or removed, a guest's account in Administration among them, shows as a " +
      "dark notice with Undo for the undo window; hovering or " +
      "focusing it holds the window, and when the window runs out or the notice is dismissed the " +
      "removal is final. Leaving the page makes every open removal final. Reset use, Block and " +
      "Unblock on a guest in Administration take effect at once and show the same dark notice, " +
      "whose Undo does the opposite. Notices are " +
      "held only in this tab: after a reload a conflict and the copy it carried are gone, " +
      "because `notes` does not keep conflicts. A step that is a delete (12, Undo) shows a " +
      "short dark notice naming it, such as Remove value Courage, with Undo and no countdown; " +
      "its Undo is the same as the top bar's, and the notice goes when it times out, is " +
      "dismissed, or another step is recorded or undone, while Undo goes on working. A step " +
      "Undo or Redo could not apply says so: Couldn't undo it, it changed since, when the " +
      "thing changed on another device or in another tab, and Can't undo it on this page when " +
      "the part that owns it is not on the page. Notices sit in the bottom corner of the " +
      "window, and in the phone preview in the bottom of the phone's screen.",
    kind: "view",
    emits: ["note.saved", "removal.undone", "removal.settled", "use.reset", "guest.blocked", "step.requested"],
    attributes: [],
    asks: ["undo: read"],
  },
  context: ({ input }) => ({
    // How long a passing notice stays (the --duration-undo token, read in the view
    // and passed in so the machine stays importable in Node).
    fadeMs: input.fadeMs,
    ask: input.ask,
    notices: new Map(),
    // Each step Undo or Redo has named, by id: { label, side }.
    steps: {},
  }),
  invoke: {
    src: "undo",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: enqueueActions(({ context, event, enqueue }) => learn(context, event.output, enqueue)) },
    onError: { actions: [] },
  },
  initial: "ready",
  states: { ready: {} },
  on: {
    "note.conflicted": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "session.refused": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "book.refused": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "removal.started": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "use.reset": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "guest.blocked": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "step.recorded": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ steps: { ...context.steps, [event.id]: { label: event.label, side: "undo" } } });
        const notice = context.notices.get("step");
        if (notice && notice.step !== event.id) {
          enqueue.cancel("fade:step");
          enqueue.assign({ notices: ({ context }) => without(context.notices, "step") });
        }
        show(context, event, enqueue);
      }),
    },
    "step.settled": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "undo.changed": { actions: enqueueActions(({ context, event, enqueue }) => learn(context, event, enqueue)) },
    // A delete always wins (5): a keep-mine onto a tombstone would be dropped by
    // notes, so the conflict notice for a note that is gone offers nothing, and
    // says so. notes emits note.conflicted before note.deleted, so the notice exists.
    "note.deleted": {
      guard: ({ context, event }) => context.notices.has(`note.conflicted:${event.id}`),
      actions: enqueueActions(({ context, event, enqueue }) => {
        const notice = context.notices.get(`note.conflicted:${event.id}`);
        enqueue.assign({ notices: ({ context }) => replaced(context.notices, { ...notice, actions: [], gone: true }) });
      }),
    },
    // The dismiss on a notice, or Escape (7.2, internal gestures). On a conflict this
    // keeps theirs, which is already the state, so nothing is emitted; a removal settles.
    _dismiss: {
      guard: ({ context, event }) => context.notices.has(event.key),
      actions: enqueueActions(({ context, event, enqueue }) => end(context, event.key, enqueue)),
    },
    // The page is going away (pagehide): no one is left to press Undo, so every open
    // removal settles now and a closed tab completes the delete.
    _leave: {
      actions: enqueueActions(({ context, enqueue }) => {
        for (const [key, notice] of context.notices) if (notice.settle) end(context, key, enqueue);
      }),
    },
    // An action on a notice: the event it carries goes out as the user's gesture (4,
    // fifth rule), and the notice is done.
    _act: {
      guard: ({ context, event }) => Boolean(context.notices.get(event.key)?.actions[event.index]),
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.emit(context.notices.get(event.key).actions[event.index].emit);
        enqueue.cancel(`fade:${event.key}`);
        enqueue.assign({ notices: ({ context }) => without(context.notices, event.key) });
      }),
    },
    // A notice being read never vanishes (forgiveness): hover or focus holds it, and
    // leaving starts a whole window again.
    _hold: {
      guard: ({ context, event }) => context.notices.has(event.key),
      actions: enqueueActions(({ event, enqueue }) => enqueue.cancel(`fade:${event.key}`)),
    },
    _release: {
      guard: ({ context, event }) => context.notices.has(event.key),
      actions: enqueueActions(({ context, event, enqueue }) => fade(context, context.notices.get(event.key), enqueue)),
    },
    // The window ran out (the timer above).
    _elapsed: {
      guard: ({ context, event }) => context.notices.has(event.key) && !context.notices.get(event.key).standing,
      actions: enqueueActions(({ context, event, enqueue }) => end(context, event.key, enqueue)),
    },
  },
});
