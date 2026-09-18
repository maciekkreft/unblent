import { setup, assign, fromPromise, enqueueActions, emit } from "xstate";

// The view component for editing one note (3.1): owns only its own UI state — the
// draft, which state it is in, whether it is pinned — and points at `notes`, which
// owns the fact, and at `subject`, which owns what is on the stage. On start it asks
// notes: list and reopens a note, or takes a note by the load command or, when it
// carries `follows`, by note.selected from the list (both ask notes: read); it follows
// note.changed after (4.3), and emits note.saved at a short throttle while the user
// types, and on blur. With the `subject` attribute it follows the stage (12): it opens
// the newest note about the subject, re-follows when the subject changes, and a pin
// keeps the note in place — a pinned editor refuses note.selected and load with
// note.refused so the note on screen never changes by surprise. It announces the note
// it shows with note.opened whenever its id changes (6.4). Everything with a side
// effect — the queries, minting an id, focusing the input, the pin store — arrives
// through input, so this stays a pure definition importable in Node.

// Short enough that a view following note.changed stays live while the user types,
// long enough that it is not a save per keystroke (4.3, third rule): a coalescing
// throttle, not a debounce. A duration, not a length that places a box, so it is a
// plain constant rather than a token (7.4).
const THROTTLE_MS = 200;

// The note is one text and its title is the first line that says anything, as in
// Notes.app: a convention of this editor, not of the contract, which still carries
// title and body. body is the whole text, so a reader shows body alone.
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  // A level marker ("# "/"## "/"### ") from a rich member (note-editor-cm6) never
  // shows in a title, so a note round-trips between the plain and rich editors.
  return line ? line.replace(/^#{1,3} /, "").trim() : "";
}

// A note's links (12), always an array: an old cached note, or a read reply from
// before links existed, reads as none.
const links = (about) => (Array.isArray(about) ? about : []);

// A note is about the subject when one of its links matches the subject's kind and id
// (D4: a follower compares kind + id, it never learns what kinds exist).
const isAbout = (note, subject) =>
  subject != null && links(note.about).some((l) => l.kind === subject.kind && l.id === subject.id);

// Which note to open from a list reply (D7): the newest note about the subject (the
// reply is newest first), or — with no subject on the stage — the newest note overall
// (today's behaviour). Null when there is none, so the editor lands on the empty page.
const pickId = (notes, subject) => {
  const list = Array.isArray(notes) ? notes : [];
  if (subject == null) return list[0]?.id ?? null;
  return list.find((n) => isAbout(n, subject))?.id ?? null;
};

// Two subjects name the same thing when their kind and id match (title aside); both
// null is the same nothing. A title-only change keeps the note on screen (D7).
const sameThing = (a, b) => (a == null && b == null) || Boolean(a && b && a.kind === b.kind && a.id === b.id);

// Remember a subject's title so the About line can name a note's link this session
// (D7, D9): a small kind:id → title table, never a claim about kinds the editor
// understands.
const withTitle = (titles, subject) =>
  subject ? { ...titles, [`${subject.kind}:${subject.id}`]: subject.title } : titles;

const assignTyped = assign({ body: ({ event }) => event.body });

// A first keystroke into an editor holding no note mints its id (a ULID, the
// browser's own, 5) and starts editing it. The id changed, so the note it now shows
// is announced (note.opened), the same as a load or a reopen does on entering
// `loading`.
const mintAndType = {
  target: "editing.dirty",
  actions: enqueueActions(({ context, event, enqueue }) => {
    const id = context.mint();
    enqueue.assign({ id, body: event.body });
    enqueue.emit({ type: "note.opened", id });
  }),
};

// note.saved from the current draft. A new note (baseVersion null) written while
// following the stage carries one link to the subject (D7, D2): about is on it only
// then, so every other save leaves the note's links as they are.
const savedEvent = (context) => {
  const event = {
    type: "note.saved",
    id: context.id,
    title: titleOf(context.body),
    body: context.body,
    baseVersion: context.baseVersion,
  };
  if (context.subjecting && context.baseVersion === null) {
    event.about = context.subject ? [{ kind: context.subject.kind, id: context.subject.id }] : [];
  }
  return event;
};

// Is there an unsaved change to send? A note with an id whose text differs from what
// notes last acknowledged (loaded, adopted, or our own last save).
const dirty = (context) =>
  context.id != null && (context.sent == null ? context.body !== "" : context.body !== context.sent.body);

export const machine = setup({
  actors: {
    // The starting picture (4.3): every note, and — only while following the stage —
    // the current subject. subject.changed that races the read is held for us until the
    // reply lands (subject: read supersededBy), so a change is applied after it, in order.
    start: fromPromise(async ({ input }) => {
      const [list, subject] = await Promise.all([
        input.ask("notes", "list", {}),
        input.subjecting ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null }),
      ]);
      return { notes: list?.notes ?? [], subject: subject?.subject ?? null };
    }),
    list: fromPromise(({ input }) => input.ask("notes", "list", {})),
    read: fromPromise(({ input }) => input.ask("notes", "read", { id: input.id })),
  },
  guards: {
    // The text is what notes already holds (what we last sent, loaded, or adopted),
    // so a pause here is not a change: no note.saved, no new version. The title is
    // derived from the text, so equal text is equal title.
    unchanged: ({ context }) => context.sent != null && context.sent.body === context.body,
    // A remembered pin (D10): a note to reopen and start pinned, skipping the subject
    // choice.
    hasPin: ({ context }) => context.restoreId != null,
  },
  actions: {
    save: enqueueActions(({ context, enqueue }) => {
      // What was sent, so the echo of this save (a note.changed carrying it back)
      // is told apart from a real change from elsewhere, and a later pause that
      // ends on the same text saves nothing.
      enqueue.assign({ sent: { body: context.body } });
      enqueue.emit(savedEvent(context));
    }),
    // Save only if there is something to send: used before following a subject change,
    // where the draft may already be clean.
    saveIfDirty: enqueueActions(({ context, enqueue }) => {
      if (!dirty(context)) return;
      enqueue.assign({ sent: { body: context.body } });
      enqueue.emit(savedEvent(context));
    }),
    // A pinned editor was asked to change its note (D7): it does not, it says so
    // (note.refused, id = the note asked for) and flashes the pin for --duration-undo.
    // A repeat restarts the window.
    refuse: enqueueActions(({ event, enqueue }) => {
      enqueue.emit({ type: "note.refused", id: event.id, reason: "pinned" });
      enqueue.cancel("flash");
      enqueue.assign({ flashing: true });
      enqueue.raise({ type: "_unflash" }, { delay: ({ context }) => context.flashMs, id: "flash" });
    }),
  },
}).createMachine({
  id: "note-editor",
  meta: {
    kind: "view",
    // The default member of the note-editor role (7.3): interchangeable with
    // note-editor-cm6, which shares this contract exactly.
    role: "note-editor",
    emits: ["note.saved", "note.opened", "note.refused"],
    attributes: ["height", "follows", "subject"],
    asks: ["notes: list", "notes: read", "subject: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    focus: input.focus,
    // Present: this editor loads whatever the list selects (6.4). Absent: it ignores
    // note.selected, so a future page with several editors leaves it off and a
    // container tells one editor to load by command instead.
    follows: input.follows,
    // The `subject` attribute (D5): present means follow the stage — open the note about
    // it, re-follow on a change, and offer the pin. Off is exactly today's behaviour.
    subjecting: Boolean(input.subjecting),
    // The pin store (D10): the remembered pinned note id, read and written through input
    // so the machine stays importable in Node.
    remember: input.remember,
    restoreId: input.subjecting ? input.recall?.() ?? null : null,
    // How long the pin flashes on a refusal (--duration-undo, read in the view and passed
    // in so the machine stays importable in Node, like undoMs in note-list).
    flashMs: input.flashMs,
    id: null,
    body: "",
    baseVersion: null,
    sent: null,
    // The open note's links, for the About line (D7): [] until a note with links loads.
    about: [],
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    // Titles of subjects seen this session, so the About line can name a link (D7, D9).
    titles: {},
    // Whether the note on screen is pinned (D7): UI state, remembered across reloads.
    pinned: false,
    // Whether a pin restore is in flight, so a successful load starts pinned and a
    // not-found one forgets the pin (D10).
    restoring: false,
    // Whether the pin is flashing a refusal right now (drives the danger border).
    flashing: false,
    // The notes fetched at start, kept so a forgotten pin can choose from the same
    // picture without a second query.
    startNotes: [],
  }),
  initial: "starting",
  on: {
    // A command addressing this instance (4.4). A pinned editor refuses it (D7); the
    // note asked for rides in note.refused. Otherwise it lands like a load always has.
    load: [
      { guard: ({ context }) => context.pinned, actions: "refuse" },
      {
        target: ".loading",
        actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null, about: [] }),
      },
    ],
    // The list's gesture (4.3, fifth rule), taken only when this editor follows the
    // selection. A pinned editor refuses it (D7). An unfollowing editor leaves it to the
    // bus to record as ignored.
    "note.selected": [
      { guard: ({ context }) => context.follows && context.pinned, actions: "refuse" },
      {
        guard: ({ context }) => context.follows,
        target: ".loading",
        actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null, about: [] }),
      },
    ],
    focus: { actions: ({ context }) => context.focus() },
    // The user pinned or unpinned (D7): remember the pinned note's id, or forget it.
    // Guarded so the button does nothing while the editor holds no note.
    _togglePin: {
      guard: ({ context }) => context.subjecting && context.id != null,
      actions: [
        assign({ pinned: ({ context }) => !context.pinned }),
        ({ context }) => context.remember?.(context.pinned ? context.id : null),
      ],
    },
    _unflash: { actions: assign({ flashing: false }) },
    // The stage moved (4.3): a different subject is on it. Held for us until the starting
    // subject: read reply lands (subject: read supersededBy), so it is never lost and
    // never applied before the picture it supersedes. Ignored when not following.
    "subject.changed": [
      {
        // Pinned, or the same thing with a new title only: take the subject and its
        // title but keep the note on screen (D7).
        guard: ({ context, event }) => context.subjecting && (context.pinned || sameThing(context.subject, event.subject)),
        actions: assign({
          subject: ({ event }) => event.subject,
          titles: ({ context, event }) => withTitle(context.titles, event.subject),
        }),
      },
      {
        // A different thing on the stage, not pinned: save a dirty draft (its links are
        // the old subject's, still in context here), take the new subject, and re-follow.
        guard: ({ context }) => context.subjecting,
        target: ".refollowing",
        actions: [
          "saveIfDirty",
          assign({
            subject: ({ event }) => event.subject,
            titles: ({ context, event }) => withTitle(context.titles, event.subject),
            id: null,
            body: "",
            baseVersion: null,
            sent: null,
            about: [],
          }),
        ],
      },
    ],
    // The fact's news that the open note is gone (4.3, fourth rule): fall back to the
    // empty page, where a keystroke starts a fresh note, and drop the pin — there is
    // nothing to keep. A deletion of another note is left to the bus to record as ignored.
    "note.deleted": {
      guard: ({ context, event }) => event.id === context.id,
      target: ".empty",
      actions: [
        assign({ id: null, body: "", baseVersion: null, sent: null, about: [], pinned: false }),
        ({ context }) => context.remember?.(null),
      ],
    },
    // The fact's news (4.3, fourth rule). Guarded so a change for another id is left
    // to the bus to record as ignored.
    "note.changed": [
      {
        // The echo of this editor's own save: bump baseVersion, take the links notes
        // now holds, and stay in the current state so a keystroke made since is not lost.
        guard: ({ context, event }) =>
          event.id === context.id && context.sent != null && event.body === context.sent.body,
        actions: assign({ baseVersion: ({ event }) => event.version, about: ({ event }) => links(event.about) }),
      },
      {
        // A newer change from elsewhere: adopt it (the user's decision, 12), even
        // over a dirty draft. A first note.changed (baseVersion null) counts.
        guard: ({ context, event }) =>
          event.id === context.id && (context.baseVersion === null || event.version > context.baseVersion),
        target: ".editing.clean",
        actions: assign({
          body: ({ event }) => event.body,
          baseVersion: ({ event }) => event.version,
          sent: ({ event }) => ({ body: event.body }),
          about: ({ event }) => links(event.about),
        }),
      },
    ],
  },
  states: {
    // The starting picture (4.3, fourth rule): every note and the current subject, so a
    // reload continues where the user left off. A keystroke meanwhile is the user's
    // answer instead, and leaving the state drops the query's reply.
    starting: {
      invoke: {
        src: "start",
        input: ({ context }) => ({ ask: context.ask, subjecting: context.subjecting }),
        onDone: {
          target: "choosing",
          actions: assign({
            startNotes: ({ event }) => event.output.notes,
            subject: ({ event }) => event.output.subject,
            titles: ({ context, event }) => withTitle(context.titles, event.output.subject),
          }),
        },
        onError: { target: "choosing", actions: assign({ startNotes: [] }) },
      },
      on: { _typed: mintAndType },
    },
    // The start replies are in: a remembered pin reopens its note (D10), else the newest
    // note about the subject, else the empty page. A synchronous choice, so a keystroke
    // never lands here.
    choosing: {
      always: [
        {
          guard: "hasPin",
          target: "loading",
          actions: assign({ id: ({ context }) => context.restoreId, restoring: true }),
        },
        {
          guard: ({ context }) => pickId(context.startNotes, context.subject) != null,
          target: "loading",
          actions: assign({ id: ({ context }) => pickId(context.startNotes, context.subject) }),
        },
        { target: "empty" },
      ],
    },
    // No note yet: typing starts one.
    empty: {
      on: { _typed: mintAndType },
    },
    // A load command, a follow of the list's selection, the start, or a re-follow asked
    // notes for the note; the reply decides where we land. Entering here the id has just
    // changed, so the note now shown is announced once (note.opened).
    loading: {
      entry: emit(({ context }) => ({ type: "note.opened", id: context.id })),
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.id }),
        onDone: [
          {
            guard: ({ event }) => "note" in event.output,
            target: "editing.clean",
            actions: assign({
              body: ({ event }) => event.output.note.body,
              baseVersion: ({ event }) => event.output.note.version,
              sent: ({ event }) => ({ body: event.output.note.body }),
              about: ({ event }) => links(event.output.note.about),
              // A pin restore that found its note starts pinned (D10).
              pinned: ({ context }) => context.restoring || context.pinned,
              restoring: false,
            }),
          },
          {
            // A remembered pin whose note is gone (D10): forget it and choose from the
            // start picture as an unpinned editor would.
            guard: ({ context, event }) => context.restoring && event.output.error === "not-found",
            target: "choosing",
            actions: [
              assign({ restoreId: null, restoring: false, id: null }),
              ({ context }) => context.remember?.(null),
            ],
          },
          { guard: ({ event }) => event.output.error === "not-found", target: "blank" },
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    // The subject changed under a following, unpinned editor (D7): fetch the notes
    // afresh and open the newest about the new subject, else the empty page. A keystroke
    // here is the user's answer, the same as at start.
    refollowing: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ context, event }) => pickId(event.output.notes, context.subject) != null,
            target: "loading",
            actions: assign({ id: ({ context, event }) => pickId(event.output.notes, context.subject) }),
          },
          { target: "empty" },
        ],
        onError: "empty",
      },
      on: { _typed: mintAndType },
    },
    editing: {
      initial: "clean",
      states: {
        clean: {
          on: { _typed: { target: "dirty", actions: assignTyped } },
        },
        dirty: {
          on: {
            // Targetless so the `after` window is not restarted: keystrokes made
            // within it join the one save at its end rather than pushing it back,
            // which is what makes this a throttle, not a debounce (4.3, third rule).
            _typed: { actions: assignTyped },
            _blurred: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
          after: {
            [THROTTLE_MS]: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
        },
      },
    },
    // notes holds no note with this id: the id is a name for a note not yet written
    // — a fresh one the list minted with its +, or a stale one — and typing here
    // creates it. A null base under an id notes does not hold upserts as version 1
    // (notes.applySave), so nothing here differs from an editor that just minted.
    blank: {
      on: { _typed: { target: "editing.dirty", actions: assignTyped } },
    },
    failed: {},
  },
});
