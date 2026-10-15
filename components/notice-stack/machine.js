import { setup, enqueueActions } from "xstate";

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
  const row = TABLE[event.type](event);
  const notice = { key: row.key, standing: row.standing, source: event, actions: row.actions, settle: row.settle ?? null, gone: false };
  enqueue.assign({ notices: ({ context }) => replaced(context.notices, notice) });
  fade(context, notice, enqueue);
}

export const machine = setup({}).createMachine({
  id: "notice-stack",
  meta: {
    description:
      "Shows what a fact could not do for the user as notices that can be dismissed: a refused " +
      "sign-in, a book that could not be added, and a save conflict. A conflict offers Keep mine, which saves " +
      "the user's copy again, because `notes` otherwise keeps the server's copy. Something the " +
      "user deleted or removed shows as a dark notice with Undo for the undo window; hovering or " +
      "focusing it holds the window, and when the window runs out or the notice is dismissed the " +
      "removal is final. Leaving the page makes every open removal final. Notices are " +
      "held only in this tab: after a reload a conflict and the copy it carried are gone, " +
      "because `notes` does not keep conflicts.",
    kind: "view", emits: ["note.saved", "removal.undone", "removal.settled"], attributes: [], asks: [],
  },
  context: ({ input }) => ({
    // How long a passing notice stays (the --duration-undo token, read in the view
    // and passed in so the machine stays importable in Node).
    fadeMs: input.fadeMs,
    notices: new Map(),
  }),
  initial: "ready",
  states: { ready: {} },
  on: {
    "note.conflicted": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "session.refused": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "book.refused": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
    "removal.started": { actions: enqueueActions(({ context, event, enqueue }) => show(context, event, enqueue)) },
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
