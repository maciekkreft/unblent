import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The fact component that owns the notes (3.1): headless, the single place a note
// lives, emitting note.changed whenever one changes and answering list and read.
// Local-only (5): an in-memory Map is the working copy, IndexedDB is write-behind,
// so a decision is synchronous and note.changed is announced the moment note.saved
// arrives (local-first). Everything with a side effect — the store, the clock —
// arrives through input, so this stays a pure definition importable in Node.

// A note as stored and as returned by read (the note.changed payload without
// pending, which is a fact-of-the-moment, not part of the record).
function replyList(context, reply) {
  const notes = [...context.notes.values()]
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  reply({ notes });
}

function replyRead(context, id, reply) {
  const stored = context.notes.get(id);
  reply(stored ? { note: { ...stored, pending: false } } : { error: "not-found" });
}

// The user's gesture (4.3, fifth rule). A stale base is a conflict the view must
// resolve, not a write we silently lose (5).
function applySave(context, event, enqueue) {
  const { id, title, body, baseVersion } = event;
  const current = context.notes.get(id);
  // A base that does not match the held version is stale — a null base for an id we
  // already hold included. There is a `theirs` to show, so it is a conflict.
  if (current && baseVersion !== current.version) {
    enqueue.emit({
      type: "note.conflicted",
      id,
      mine: { title, body, baseVersion },
      theirs: { title: current.title, body: current.body, version: current.version, updatedAt: current.updatedAt },
    });
    return;
  }
  // The same text on the right base is not a change: no version, no news (5, writes
  // are idempotent). The fact decides whether the fact changed.
  if (current && title === current.title && body === current.body) return;
  // No current with a non-null base is an idempotent upsert of the browser's own id
  // (5), not a conflict: there is no theirs to show.
  const version = current ? current.version + 1 : baseVersion === null ? 1 : baseVersion + 1;
  const record = { id, title, body, version, updatedAt: context.now() };
  context.notes.set(id, record);
  // Fire-and-forget: local-only has no outbox, so a rejected write is dropped
  // silently until replication (5) gives it one.
  enqueue(() => context.store.put(record).catch(() => {}));
  enqueue.emit({ type: "note.changed", ...record, pending: false });
}

// A query or gesture that arrived before the store loaded, replayed in order once
// it has (so an early asker, or a keystroke, is answered rather than lost).
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "read?") replyRead(context, message.payload.id, message.reply);
  else if (message.type === "note.saved") applySave(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

export const machine = setup({
  actors: { load: fromPromise(({ input }) => input.store.all()) },
}).createMachine({
  id: "notes",
  meta: {
    kind: "fact",
    shape: "local-only",
    emits: ["note.changed", "note.deleted", "note.conflicted"],
    owns: "the notes",
  },
  context: ({ input }) => ({ notes: new Map(), store: input.store, now: input.now, queued: [] }),
  initial: "loading",
  states: {
    // The store is read once on start; until it answers, queries and gestures wait
    // in `queued` so nothing that arrived first is dropped (a future note-list asks
    // on page load).
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            for (const row of event.output) context.notes.set(row.id, row);
            for (const message of context.queued) flush(context, message, enqueue);
            enqueue.assign({ queued: [] });
          }),
        },
        // The store could not be read. Queries still get an honest reply (4.2); a
        // queued gesture is dropped, the draft still living in the editor.
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) {
              if (message.type === "list?") message.reply({ notes: [] });
              else if (message.type === "read?") message.reply({ error: "not-found" });
            }
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "note.saved": { actions: queue },
      },
    },
    ready: {
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload.id, event.reply) },
        "note.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        // note.deleted is owned here and has a schema, but nothing triggers a delete
        // yet (the gesture arrives with note-list); the emit stays unused.
      },
    },
    failed: {
      on: {
        "list?": { actions: ({ event }) => event.reply({ notes: [] }) },
        "read?": { actions: ({ event }) => event.reply({ error: "not-found" }) },
      },
    },
  },
});
