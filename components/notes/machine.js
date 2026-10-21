import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the notes (3.1), replicated (5): local-first, the
// single place a note lives in the browser, syncing to the per-user server when
// signed in. Anonymous, it mints versions locally and announces at once, the
// anonymous behaviour that keeps every no-server feature working. Signed
// in, an edit is cached pending and queued in the outbox; a sync drains the outbox
// and pulls what changed, so work continues across devices. Who is signed in comes
// from `session` (one query on start, session.changed after, 4.3). Everything with
// a side effect — the store, the clock, the network, the ask — arrives through
// input, so this stays a pure definition importable in Node.

// The note is one text whose title is its first non-empty line and whose subtitle is
// the second (note-editor/machine.js titleOf, the Notes.app convention). The subtitle
// travels on every note.changed and in the list reply so a row shows two lines without
// ever holding the body (4.3, third rule); it is derived, never stored, and capped so a
// long paragraph on line two does not ride in every event.
const subtitleOf = (body) => {
  const [, second = ""] = body.split("\n").filter((l) => l.trim() !== "");
  // Strip a level marker ("# "/"## "/"### ") a rich member writes, so a row's second
  // line reads cleanly whichever editor saved it (note-editor/machine.js titleOf).
  return second.replace(/^#{1,3} /, "").trim().slice(0, 120);
};

// A note's place in the list is a fractional index (5, an item's place is last write
// wins): a string that sorts by plain code-unit comparison, so a note moved between two
// others takes a key between theirs and no other note changes. The digits are in ASCII
// order, and a key never ends in the smallest digit, so there is always room before it.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
export const isPosition = (value) => typeof value === "string" && value.length <= 200 && KEY.test(value);

// The key between a and b (a < b); "" stands for before everything, null for after.
function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

// A key strictly between `after` and `before`, either null for the list's end. Out of
// order neighbours (a move computed against a list that changed meanwhile) place the
// note just after `after`.
export function between(after, before) {
  const a = isPosition(after) ? after : "";
  const b = isPosition(before) && before > a ? before : null;
  return midpoint(a, b);
}

// A note from before places existed has no key, and keeps today's order, newest first:
// its key is read from when it last changed, "z" and eight digits counting down from the
// largest time, then its id, so it sorts after every key `between` makes for a new note
// and among its kind by time, newest first, then by id. It is the same on every device,
// because the time and id come from the server. The key is written down the first time
// the note is edited or moved, so an edit never moves it.
const LATEST = 62 ** 8 - 1;
function countdown(at) {
  let n = Math.max(0, LATEST - Math.floor(at));
  let text = "";
  for (let i = 0; i < 8; i += 1) {
    text = DIGITS[n % 62] + text;
    n = Math.floor(n / 62);
  }
  return text;
}
export const positionOf = (record) =>
  isPosition(record.position) ? record.position : `z${countdown(record.updatedAt ?? 0)}${record.id}V`;

// List order: by key, then by id where two keys are equal.
export const byPosition = (a, b) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// A new note sorts first (5): a key before every note's.
function firstPosition(context) {
  let min = null;
  for (const record of context.notes.values()) {
    if (!visible(record)) continue;
    const p = positionOf(record);
    if (min === null || p < min) min = p;
  }
  return between(null, min);
}

// An outbox row with text (a save or a delete), as against a row that only moves a note.
const hasText = (row) => row != null && "title" in row;

// about is the note's links (12), [] when none (D2); a note cached before links
// existed has no about field, so every derivation defaults it.
const listRow = (record) => ({
  id: record.id,
  title: record.title,
  subtitle: subtitleOf(record.body),
  updatedAt: record.updatedAt,
  about: record.about ?? [],
  position: positionOf(record),
});

// The one place a note.changed is built, so its subtitle is derived once (5 emit sites).
const changed = (record, pending) => ({
  type: "note.changed",
  ...record,
  subtitle: subtitleOf(record.body),
  about: record.about ?? [],
  position: positionOf(record),
  pending,
});

// A read or open reply carries the note without its place: their schemas do not name it.
const withoutPosition = ({ position, ...rest }) => rest;

// A tombstone is a real record kept for the pull (5), but it is not a note anyone
// reads or lists, and its `deleted` flag must never ride note.changed or a read reply
// (both additionalProperties:false). So the queries exclude it and note.changed is
// never built from it (applyDiscard and applySync below emit note.deleted instead).
const visible = (record) => record && !record.deleted;

function replyList(context, reply) {
  const notes = [...context.notes.values()]
    .filter(visible)
    .map(listRow)
    .sort(byPosition);
  reply({ notes });
}

function replyRead(context, id, reply) {
  const stored = context.notes.get(id);
  // pending reports the record has a local change the server has not acknowledged (5).
  reply(visible(stored) ? { note: { ...withoutPosition(stored), about: stored.about ?? [], pending: context.outbox.has(id) } } : { error: "not-found" });
}

// The link a highlight of `about` carries: the one naming it with a place (12).
const placeOf = (record, about) =>
  (record.about ?? []).find((l) => l.kind === about.kind && l.id === about.id && l.place)?.place;

const fullNote = (context, record) => ({ ...withoutPosition(record), about: record.about ?? [], pending: context.outbox.has(record.id) });

// The open note (12, "Which note is open"): the Highlights of the subject while they are
// in front of the Notes pair, which the user sees as one note (13), each highlight in
// reading order; otherwise the note the editor holds. A new note nothing was written in
// has no record yet, so it is answered as nothing open.
function replyOpen(context, reply) {
  const { front, subject, editorId } = context.open;
  if (front === "highlights" && subject) {
    const notes = [...context.notes.values()]
      .filter((r) => visible(r) && placeOf(r, subject))
      .sort((a, b) => {
        const pa = placeOf(a, subject), pb = placeOf(b, subject);
        return pa.chapter - pb.chapter || pa.start.block - pb.start.block || pa.start.offset - pb.start.offset;
      })
      .map((r) => fullNote(context, r));
    return reply({ highlights: { about: subject, notes } });
  }
  const stored = front === "note" && editorId ? context.notes.get(editorId) : null;
  reply({ note: visible(stored) ? fullNote(context, stored) : null });
}

// The user's gesture (4.3, fifth rule). Anonymous: local minting, announced with
// pending false (there is no server to wait for). Signed in: the held version is
// kept, the change is cached and queued in the outbox (coalesced by id, keeping the
// base the first unsynced edit was on), announced pending, and a sync is asked for.
function applySave(context, event, enqueue) {
  const { id, title, body, baseVersion } = event;
  const current = context.notes.get(id);

  // A delete always wins (5): once a note is a tombstone, a late save for it is
  // dropped rather than reviving it. The server refuses the same edit with a 409.
  if (current && current.deleted) return;

  // D2 (12): about present replaces the note's links, absent leaves them, a new note
  // gets []. So a save that omits about (every save but a new note's) is a no-op when
  // its text is unchanged, and a save that carries about is always a change.
  const about = event.about !== undefined ? event.about : current ? current.about ?? [] : [];
  // A new note takes a place before every note; a note without one keeps the place it
  // shows in now, written down, so the edit does not move it (5).
  const unplaced = !current || !isPosition(current.position);
  const position = current ? positionOf(current) : firstPosition(context);

  if (context.userId == null) {
    if (current && baseVersion !== current.version) {
      enqueue.emit({
        type: "note.conflicted",
        id,
        mine: { title, body, baseVersion },
        theirs: { title: current.title, body: current.body, version: current.version, updatedAt: current.updatedAt },
      });
      return;
    }
    if (current && title === current.title && body === current.body && event.about === undefined) return;
    const version = current ? current.version + 1 : baseVersion === null ? 1 : baseVersion + 1;
    const record = { id, title, body, version, updatedAt: context.now(), about, position };
    context.notes.set(id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit(changed(record, false));
    return;
  }

  // Signed in: nothing pending and the same text is not a change (5, idempotent).
  if (current && title === current.title && body === current.body && !context.outbox.has(id) && event.about === undefined) return;
  const version = current ? current.version : 1;
  const record = { id, title, body, version, updatedAt: context.now(), about, position };
  context.notes.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const existing = context.outbox.get(id);
  // A row that only moved the note keeps no base; the edit is based on the held version.
  const row = { id, title, body, about, baseVersion: hasText(existing) ? existing.baseVersion : current ? current.version : null };
  // The place rides the write only when this device set it (5: last write wins), so an
  // edit never carries a stale place over a move made on another device.
  if (unplaced || existing?.position !== undefined) row.position = position;
  context.outbox.set(id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit(changed(record, true));
  enqueue.raise({ type: "_drain" });
}

// The user let a note's undo window run out (note-list emits note.discarded, 4.3
// fifth rule): mark it a tombstone and announce it gone. A delete is a write like any
// other (5) — anonymous it mints the next version locally; signed in it is cached,
// queued in the outbox as a delete (baseVersion pinned like an edit), and synced. It
// keeps the note's title and body, so the tombstone still holds what was deleted. It
// never rides note.changed; the news is note.deleted, which every view already knows.
function applyDiscard(context, event, enqueue) {
  const { id } = event;
  const current = context.notes.get(id);
  if (!current || current.deleted) return;

  if (context.userId == null) {
    const record = { ...current, deleted: true, version: current.version + 1, updatedAt: context.now() };
    context.notes.set(id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit({ type: "note.deleted", id });
    return;
  }

  const record = { ...current, deleted: true, updatedAt: context.now() };
  context.notes.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const existing = context.outbox.get(id);
  const row = {
    id,
    title: current.title,
    body: current.body,
    baseVersion: existing ? existing.baseVersion : current.version,
    deleted: true,
  };
  context.outbox.set(id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit({ type: "note.deleted", id });
  enqueue.raise({ type: "_drain" });
}

// The user moved a note in the list (note-list emits note.moved, 4.3 fifth rule): it
// takes a key between its new neighbours'. A place is last write wins (5): it bumps no
// version, so it never conflicts with an edit and the editor's base stays true; signed
// in it rides the outbox like an edit, alone or on the row of an edit not yet sent.
function applyMove(context, event, enqueue) {
  const current = context.notes.get(event.id);
  if (!visible(current)) return;
  const neighbour = (id) => {
    const record = id ? context.notes.get(id) : null;
    return visible(record) && id !== event.id ? positionOf(record) : null;
  };
  const position = between(neighbour(event.after), neighbour(event.before));
  if (position === current.position) return;
  const record = { ...current, position };
  context.notes.set(event.id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  if (context.userId == null) {
    enqueue.emit(changed(record, false));
    return;
  }
  const existing = context.outbox.get(event.id);
  const row = existing ? { ...existing, position } : { id: event.id, position };
  context.outbox.set(event.id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit(changed(record, true));
  enqueue.raise({ type: "_drain" });
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "read?") replyRead(context, message.payload.id, message.reply);
  else if (message.type === "open?") replyOpen(context, message.reply);
  else if (message.type === "note.saved") applySave(context, message, enqueue);
  else if (message.type === "note.discarded") applyDiscard(context, message, enqueue);
  else if (message.type === "note.moved") applyMove(context, message, enqueue);
  else if (message.type === "removal.settled") applyDiscard(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

// The pause in typing the network waits for (4.3, third rule; 5): a save restarts
// this window, so a run of saves drains once as one coalesced PUT after the typing
// stops, never one PUT per throttled keystroke. A tab-focus, a sign-in or a tab
// going hidden does not wait for it; they sync at once.
const SYNC_IDLE_MS = 2000;

// The browser changed account while this fact was not on the page (12): a copy kept for
// another account, with nothing of it left to upload, is emptied before it is read, so
// none of it is shown to the account now signed in or uploaded as its own.
// The copy is marked with the account it now follows, so the next account change finds it.
async function claim(store, ask) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, outbox] = await Promise.all([store.metaGet("userId"), store.outboxAll()]);
  if (kept && kept !== userId && outbox.length === 0) await store.empty();
  if (kept !== userId) await store.metaPut("userId", userId).catch(() => {});
}

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    // A pull is always worth the round trip; a bare drain only when the outbox holds something.
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0 || context.leaving,
    // The browser is changing account (12): empty the local copy once nothing is left
    // to upload.
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store, ask } = input;
      await claim(store, ask);
      const [notes, outbox, cursor, userId] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      return { notes, outbox, cursor: cursor ?? 0, userId: userId ?? null };
    }),
    // Who is signed in, for the starting picture (4.3). Missing (no ask on the page,
    // or in a Node test) is treated as anonymous, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // Empties the local copy in one transaction, outbox and cache together (12).
    empty: fromPromise(({ input }) => input.store.empty()),
    // One sync: drain the outbox in id order, then pull what changed since the
    // cursor. It returns a summary the machine applies; it never emits (only the
    // machine does, 4.3). A network error stops it with what it had; 401 reports the
    // session is gone. The store deletes happen here so a drained row is durably gone.
    sync: fromPromise(async ({ input }) => {
      const { api, store, rows, cursor, pull } = input;
      const acks = [];
      const conflicts = [];
      for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        let result;
        try {
          result = await api.put(row);
        } catch {
          return { acks, conflicts, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, conflicts, authFailed: true };
        if (result.conflict) {
          conflicts.push({ id: row.id, mine: row, theirs: result.note });
          await store.outboxDelete(row.id).catch(() => {});
        } else if (result.missing) {
          // A move for a note the server never had: nothing to place.
          acks.push({ id: row.id, missing: true });
          await store.outboxDelete(row.id).catch(() => {});
        } else {
          acks.push(result);
          await store.outboxDelete(row.id).catch(() => {});
        }
      }
      // A save-triggered drain must not pull: nothing this device needs changed on
      // the server, and a pull per pause in typing would be a poll (5). A pull runs
      // only when a load, a tab-focus or a sign-in asked for it.
      if (!pull) return { acks, conflicts };
      let pulled;
      try {
        pulled = await api.pull(cursor);
      } catch {
        return { acks, conflicts, networkError: true };
      }
      if (pulled.error === "unauthorized") return { acks, conflicts, authFailed: true };
      return { acks, conflicts, pulled: pulled.notes, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "notes",
  meta: {
    description:
      "Owns the notes: each note's text, its links, and which note is open. It works offline " +
      "and syncs to the account when signed in (section 5); while signed out it numbers " +
      "versions itself, and signing in uploads every note with its history. A note's `about` " +
      "names what it is about, none, one or many: a save without `about` keeps the links, a " +
      "save with it replaces them, and a link to a book that carries a place and a quote makes " +
      "the note a highlight. The open note is the one in front in the Notes pair, the note in " +
      "the editor or the subject's Highlights, kept in memory on this device; `notes: open` " +
      "answers with it in full, or with the Highlights in reading order, and is offered to the " +
      "chat as \"Reading the open note\". A deleted note is kept as a tombstone with its title " +
      "and body, so it can still be shown or restored. Each note has a place in the list, the " +
      "same on every device: a new note goes first, an edit never moves a note, and a move " +
      "from the list puts it between its new neighbours. A place is last write wins: it " +
      "changes no version, so a move never conflicts with an edit. A note from before places " +
      "keeps the order it had, newest first, until it is edited or moved. A delete handed to " +
      "the corner notice happens when that notice's undo window ends.",
    kind: "fact",
    shape: "replicated",
    emits: ["note.changed", "note.deleted", "note.conflicted"],
    owns: "the notes",
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    notes: new Map(),
    outbox: new Map(),
    store: input.store,
    now: input.now,
    api: input.api,
    ask: input.ask,
    userId: null,
    cursor: 0,
    queued: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    // Which note is open (12): what is in front of the Notes pair, the editor's note, and
    // the subject whose Highlights those are. Memory only, on this device.
    open: { front: "note", editorId: null, subject: null },
    // The "owed" flags for a trigger that arrives mid-sync: resync means drain
    // again, pull whether that next sync must also pull.
    resync: false,
    pull: false,
  }),
  initial: "loading",
  // The gestures and news that say which note is open (12), followed in every state so
  // one that lands while the store loads is not lost; only the answer waits for it.
  on: {
    // While loading, only whether the browser is leaving is kept (12); the rest of the
    // news is read from session once the store is loaded.
    "session.changed": { actions: assign({ leaving: ({ event }) => event.leaving === true }) },
    "note.opened": { actions: assign({ open: ({ context, event }) => ({ ...context.open, editorId: event.id }) }) },
    "note.selected": { actions: assign({ open: ({ context }) => ({ ...context.open, front: "note" }) }) },
    "highlights.selected": {
      actions: assign({ open: ({ context, event }) => ({ ...context.open, front: "highlights", subject: event.about }) }),
    },
    "subject.changed": {
      actions: assign({
        open: ({ context, event }) => ({
          ...context.open,
          subject: event.subject ? { kind: event.subject.kind, id: event.subject.id } : null,
        }),
      }),
    },
  },
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask }),
        onDone: {
          target: "checkingSession",
          actions: assign({
            notes: ({ event }) => new Map(event.output.notes.map((row) => [row.id, row])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) {
              if (message.type === "list?") message.reply({ notes: [] });
              else if (message.type === "read?") message.reply({ error: "not-found" });
              else if (message.type === "open?") message.reply({ note: null });
            }
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "open?": { actions: queue },
        "note.saved": { actions: queue },
        "note.discarded": { actions: queue },
        "note.moved": { actions: queue },
        "removal.settled": { guard: ({ event }) => event.kind === "note", actions: queue },
      },
    },
    // The store is loaded; confirm who is signed in before flushing, so an early
    // gesture is applied with the right anonymous-or-signed-in rule.
    checkingSession: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready.idle",
          actions: enqueueActions(({ context, event, enqueue }) => {
            const userId = event.output?.userId ?? null;
            enqueue.assign({ userId });
            for (const message of context.queued) flush(context, message, enqueue);
            enqueue.assign({ queued: [] });
            if (userId) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
        onError: {
          target: "ready.idle",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) flush(context, message, enqueue);
            enqueue.assign({ queued: [] });
            if (context.userId) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "open?": { actions: queue },
        "note.saved": { actions: queue },
        "note.discarded": { actions: queue },
        "note.moved": { actions: queue },
        "removal.settled": { guard: ({ event }) => event.kind === "note", actions: queue },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload.id, event.reply) },
        "open?": { actions: ({ context, event }) => replyOpen(context, event.reply) },
        "note.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        "note.discarded": { actions: enqueueActions(({ context, event, enqueue }) => applyDiscard(context, event, enqueue)) },
        "note.moved": { actions: enqueueActions(({ context, event, enqueue }) => applyMove(context, event, enqueue)) },
        // A delete the list handed to the corner notice when the keyboard left it: the
        // notice's undo window ran out, so the note goes, as on note.discarded.
        "removal.settled": {
          guard: ({ event }) => event.kind === "note",
          actions: enqueueActions(({ context, event, enqueue }) => applyDiscard(context, event, enqueue)),
        },
        // The fact's own news about who is signed in (4.3, fourth rule). A different
        // user resets the pull cursor (the cache is kept, to be pushed up); signing
        // in enqueues the cache so anonymous work becomes the account's, then syncs.
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            // The browser is changing account (12): upload what is left, then empty the local
            // copy. Any other news ends it, and syncing goes on as before.
            if (event.leaving) {
              enqueue.assign({ leaving: true });
              enqueue.raise({ type: "_leave" });
              return;
            }
            if (context.leaving) enqueue.assign({ leaving: false });
            const userId = event.userId;
            if (userId === context.userId) return;
            enqueue.assign({ userId });
            enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
            if (userId) {
              enqueue.assign({ cursor: 0 });
              enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
              for (const note of context.notes.values()) {
                if (!context.outbox.has(note.id)) {
                  // A tombstone uploads as a delete, so an anonymous deletion becomes
                  // the account's too (5).
                  const row = { id: note.id, title: note.title, body: note.body, baseVersion: note.version, about: note.about ?? [] };
                  if (note.deleted) row.deleted = true;
                  if (isPosition(note.position)) row.position = note.position;
                  context.outbox.set(note.id, row);
                  enqueue(() => context.store.outboxPut(row).catch(() => {}));
                }
              }
              enqueue.raise({ type: "_sync", pull: true });
            }
          }),
        },
      },
      states: {
        // Leaving (12): what is left is uploaded at once, then the local copy is emptied.
        emptying: {
          invoke: {
            src: "empty",
            input: ({ context }) => ({ store: context.store }),
            onDone: { target: "left" },
            onError: { target: "left" },
          },
        },
        // Emptied; a change made meanwhile is uploaded and emptied again. When the
        // change of account is called off, syncing goes on as before.
        left: {
          always: { guard: ({ context }) => !context.leaving, target: "idle" },
          on: {
            _drain: { guard: "syncable", target: "syncing" },
            _sync: { guard: "syncable", target: "syncing" },
            _leave: { guard: "syncable", target: "syncing" },
          },
        },
        idle: {
          always: { guard: "leftover", target: "emptying" },
          on: {
            _leave: { guard: "syncable", target: "syncing" },
            // A save opens the idle window; a focus, sign-in or hidden tab syncs at once.
            _drain: { guard: "syncable", target: "debouncing" },
            _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
          },
        },
        // The idle window (4.3, 5): a _drain reenters this state, so its exit cancels
        // the after timer and its entry re-arms it, which restarts the window; the
        // drain waits until typing has paused for the whole window. A focus, sign-in
        // or hidden tab (_sync) does not wait. Signed out mid-window, the fallback
        // returns to idle rather than sync with no user.
        debouncing: {
          on: {
            _drain: { target: "debouncing", reenter: true },
            _leave: { guard: "syncable", target: "syncing" },
            _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
          },
          after: {
            [SYNC_IDLE_MS]: [{ guard: "syncable", target: "syncing" }, { target: "idle" }],
          },
        },
        syncing: {
          entry: assign({ resync: false, pull: false }),
          invoke: {
            src: "sync",
            // pull comes from the triggering event, not context: the entry assign
            // above runs before the input resolves and would otherwise wipe it.
            input: ({ context, event }) => ({
              api: context.api,
              store: context.store,
              rows: [...context.outbox.values()],
              cursor: context.cursor,
              pull: Boolean(event.pull) && !context.leaving,
            }),
            onDone: {
              target: "idle",
              actions: [
                enqueueActions(({ context, event, enqueue }) => applySync(context, event.output, enqueue)),
                // A trigger that arrived mid-sync is owed a follow-up, unless the
                // session went away or the network failed (retry waits for the next
                // trigger). A focus mid-sync (resync) syncs at once carrying its pull;
                // a save mid-sync (a leftover row) waits out the idle window.
                enqueueActions(({ context, event, enqueue }) => {
                  const { authFailed, networkError } = event.output;
                  if (authFailed || networkError) return;
                  if (context.resync) enqueue.raise({ type: "_sync", pull: context.pull });
                  else if (context.outbox.size > 0) enqueue.raise({ type: "_drain" });
                }),
              ],
            },
            onError: { target: "idle" },
          },
          on: {
            _leave: { actions: assign({ resync: true }) },
            _sync: { actions: assign({ resync: true, pull: ({ context, event }) => context.pull || Boolean(event.pull) }) },
          },
        },
      },
    },
    failed: {
      on: {
        "list?": { actions: ({ event }) => event.reply({ notes: [] }) },
        "read?": { actions: ({ event }) => event.reply({ error: "not-found" }) },
        "open?": { actions: ({ event }) => event.reply({ note: null }) },
      },
    },
  },
});

// Apply a sync's summary: adopt acknowledged and pulled records, surface conflicts,
// advance the cursor, and drop the session on a 401. Kept out of the machine body
// so the state chart stays readable.
function applySync(context, output, enqueue) {
  const { acks = [], conflicts = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    if (ack.missing) {
      context.outbox.delete(ack.id);
      continue;
    }
    const row = context.outbox.get(ack.id);
    const isDelete = Boolean((row && row.deleted) || ack.deleted);
    // The row is fully drained when the server holds what it acknowledged; a newer
    // edit during the sync leaves a newer row, so it stays pending and the outbox base
    // advances. A delete has no newer edit (a tombstone refuses further saves), so a
    // matching ack always drains it — its text differs from the server's, so it is the
    // deleted flag, not the body, that decides.
    const placed = row && (row.position === undefined || row.position === ack.position);
    const drained = row && placed && (isDelete ? Boolean(ack.deleted) : !hasText(row) || (row.title === ack.title && row.body === ack.body));
    if (drained) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
    } else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    const held = context.notes.get(ack.id);
    // Keep the latest local text (a mid-sync edit), take the server's version.
    const record = {
      id: ack.id,
      title: held ? held.title : ack.title,
      body: held ? held.body : ack.body,
      version: ack.version,
      updatedAt: ack.updatedAt,
      about: held ? held.about ?? [] : ack.about ?? [],
    };
    const position = held && isPosition(held.position) ? held.position : ack.position;
    if (isPosition(position)) record.position = position;
    // A tombstone stays a tombstone and never rides note.changed; the list already
    // dropped it on the note.deleted that the discard emitted.
    if (isDelete) record.deleted = true;
    context.notes.set(ack.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    if (!isDelete) enqueue.emit(changed(record, !drained));
  }

  for (const conflict of conflicts) {
    context.outbox.delete(conflict.id);
    enqueue(() => context.store.outboxDelete(conflict.id).catch(() => {}));
    const theirs = conflict.theirs;
    const wasVisible = visible(context.notes.get(conflict.id));
    const record = { id: conflict.id, title: theirs.title, body: theirs.body, version: theirs.version, updatedAt: theirs.updatedAt, about: theirs.about ?? [] };
    if (theirs.deleted) record.deleted = true;
    // The place was saved even though the text was refused (5: a place never conflicts).
    if (isPosition(theirs.position)) record.position = theirs.position;
    context.notes.set(conflict.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    // The edit was rejected either way, so a view is owed the conflict (the lost edit
    // is worth a future notice, even for a delete). theirs is built field by field, so
    // a deleted flag never rides note.conflicted.
    enqueue.emit({
      type: "note.conflicted",
      id: conflict.id,
      mine: { title: conflict.mine.title, body: conflict.mine.body, baseVersion: conflict.mine.baseVersion },
      theirs: { title: theirs.title, body: theirs.body, version: theirs.version, updatedAt: theirs.updatedAt },
    });
    // A delete won, so the note is gone (note.deleted), not changed; otherwise the
    // server's copy is the new note.
    if (theirs.deleted) {
      if (wasVisible) enqueue.emit({ type: "note.deleted", id: conflict.id });
    } else {
      enqueue.emit(changed(record, false));
    }
  }

  for (const note of pulled) {
    const current = context.notes.get(note.id);
    // A place this device moved and has not sent yet is the latest write (5).
    const moving = context.outbox.get(note.id)?.position !== undefined;
    if (current && note.version <= current.version) {
      // A move made elsewhere changes no version, so it is taken on its own.
      if (visible(current) && !note.deleted && !moving && isPosition(note.position) && note.position !== current.position) {
        const record = { ...current, position: note.position };
        context.notes.set(note.id, record);
        enqueue(() => context.store.put(record).catch(() => {}));
        enqueue.emit(changed(record, context.outbox.has(note.id)));
      }
      continue;
    }
    // A delete always wins (5): a live copy from the server never resurrects a local
    // tombstone, even at a higher version (the server refuses such a revival anyway).
    if (current && current.deleted && !note.deleted) continue;
    const record = { id: note.id, title: note.title, body: note.body, version: note.version, updatedAt: note.updatedAt, about: note.about ?? [] };
    const position = moving ? current?.position : isPosition(note.position) ? note.position : current?.position;
    if (isPosition(position)) record.position = position;
    if (note.deleted) {
      record.deleted = true;
      context.notes.set(note.id, record);
      enqueue(() => context.store.put(record).catch(() => {}));
      // Tell views only when a note they were showing has gone; a tombstone pulled for
      // a note this device never had is stored silently.
      if (visible(current)) enqueue.emit({ type: "note.deleted", id: note.id });
      continue;
    }
    context.notes.set(note.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit(changed(record, context.outbox.has(note.id)));
  }

  if (newCursor !== undefined) {
    enqueue.assign({ cursor: newCursor });
    enqueue(() => context.store.metaPut("cursor", newCursor).catch(() => {}));
  }
  if (authFailed) {
    enqueue.assign({ userId: null });
    enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
  }
}
