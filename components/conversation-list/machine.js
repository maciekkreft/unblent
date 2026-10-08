import { setup, assign, fromPromise, emit, enqueueActions } from "xstate";

// The view component that lists the chats and lets one be picked (6.4): it owns only UI
// state — the rows it is showing, which chat is open, a next-chat draft with no row yet,
// and the rows counting down to a delete — and points at `conversations`, which owns the
// fact. It asks conversations: list for the starting picture, conversations: open for the
// open chat, and subject: read for what to scope by, following conversation.changed /
// conversation.deleted / conversation.opened / subject.changed after (4.3, fourth rule),
// and asks again after session.changed, when the chats become another account's.
// It never decides which chat is open; it learns that from conversations. The ask and
// mint arrive through input, so this stays a pure definition importable in Node.
//
// The next chat the user would start is always the first row ("New chat" on top of the
// list), so `draft` is always a minted id with no row yet. Picking it opens an empty new
// chat under that id; when the user sends a message, conversation.changed brings the real
// row and a fresh draft is minted above it. The list never creates a chat — a fact learns
// of creation from a gesture (4.3, fifth rule) — it only holds the name a new chat will
// take.

// Newest first: updatedAt descending, id as the tiebreak, the same order conversations
// uses in its list reply, so a row keeps its place across a re-sort.
const order = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
const sorted = (chats) => [...chats].sort(order);

// A chat's links (12), always an array: a heading from before links, or a malformed one,
// reads as none.
const links = (chat) => (Array.isArray(chat.about) ? chat.about : []);

// One row keeps only the fields the list shows, plus the links it scopes by. subtitle is
// the latest answer's first line, "" when there is none or the heading predates it.
const row = ({ id, title, subtitle, about, updatedAt }) => ({ id, title, subtitle: subtitle ?? "", about: links({ about }), updatedAt });

// Fold one changed chat into the rows: replace the row with its id if present, else add
// it, then re-sort. A conversation.changed carries the whole conversation (4.3, third
// rule); only the fields a row shows are kept.
const upsert = (chats, changed) => sorted([...chats.filter((c) => c.id !== changed.id), row(changed)]);

// A chat is about the subject when one of its links matches the subject's kind and id
// (a follower compares kind + id, it never learns what kinds exist).
const isAbout = (chat, subject) =>
  subject != null && links(chat).some((l) => l.kind === subject.kind && l.id === subject.id);

// The rows to show (12): while following, with a subject on the stage, only the chats
// about it — a chat about a book belongs to that book. Only when nothing on the stage is a
// subject (a null subject, or the attribute off) is there nothing to scope by, and every
// chat shows. The draft row is the view's, always on top of whichever set this returns.
export const shown = ({ chats, following, subject }) =>
  following && subject != null ? chats.filter((c) => isAbout(c, subject)) : chats;

// A Set with one id removed, as a new Set so assign sees a fresh value (XState keeps
// context immutable; the view re-renders on every snapshot regardless).
const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export const machine = setup({
  actors: {
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // The chats starting picture (4.3): conversation.changed / conversation.deleted are
    // held for this ask until its reply lands, so a change that races the start is applied
    // after it.
    load: fromPromise(({ input }) => input.ask("conversations", "list", {})),
    // Which chat is open (a fact owned by conversations, 12): conversation.opened /
    // conversation.deleted are held for this ask until its reply lands, so an open that
    // races the start is applied after it, in order.
    readOpen: fromPromise(({ input }) => input.ask("conversations", "open", {})),
    // The subject starting picture, asked as its own concern (3.5) so its reply — the
    // picture at read time — never overwrites a subject.changed that arrived first while
    // the chats list was still loading. subject.changed is held for this ask until its
    // reply lands, so it is applied after the starting picture, in order.
    // The picture again after who is signed in changed: conversations reloads the chats
    // for the new account (or clears them), and announces no per-chat news for that, so
    // the list asks again, as book-shelf re-asks books. Both at once, so neither reply
    // cancels the other.
    reload: fromPromise(async ({ input }) => {
      const [list, open] = await Promise.all([
        input.ask("conversations", "list", {}),
        input.ask("conversations", "open", {}),
      ]);
      return { list, open };
    }),
    readSubject: fromPromise(({ input }) =>
      input.following ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null })),
  },
}).createMachine({
  id: "conversation-list",
  meta: {
    description:
      "Lists the chats, newest first, and lets the user open one, start a new one, or delete " +
      "one. The first row is always New chat. While a subject is on the stage only the chats " +
      "about it are listed; with no subject every chat is listed. Deleting waits out the undo " +
      "window, so it can be taken back in one step. It learns which chat is open from " +
      "`conversations` and never decides it.",
    kind: "view",
    emits: ["conversation.selected", "conversation.discarded"],
    // The subject attribute (12): off is every chat shown, no subject ask; on, only the
    // chats about the subject on the stage.
    attributes: ["subject"],
    asks: ["conversations: list", "conversations: open", "subject: read", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    mint: input.mint,
    // Whether the page set the `subject` attribute (12); through input so the machine
    // stays importable in Node.
    following: Boolean(input.following),
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    // How long a discarded row can be brought back (the --duration-undo token, read in
    // the view and passed in so the machine stays importable in Node). The delete is not a
    // fact until this window ends (delayed delete): stop it and nothing was emitted.
    undoMs: input.undoMs,
    chats: [],
    // Which chat is open, learned from conversations: open then conversation.opened; never
    // set on a gesture (the list does not decide what is open).
    open: null,
    // The ids counting down to a discard, each with its own cancelable timer (below). A
    // row here shows struck through with an Undo where its trash was.
    discarding: new Set(),
    // The next chat's id, always present: the "New chat" row, blank until the user sends
    // the first message and conversation.changed brings its real row, whereupon a fresh
    // one is minted.
    draft: input.mint(),
  }),
  // The subject read and the open read run for the machine's whole life (3.5), so the
  // chats-load transition (loading → ready) never cancels them: their replies land on
  // their own and set the subject and the open chat, and the chats reply writes neither,
  // so a slow chats reply cannot re-apply a stale value over an event that arrived first.
  invoke: [
    {
      src: "readSubject",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: { actions: assign({ subject: ({ event }) => event.output.subject ?? null }) },
      onError: { actions: [] },
    },
    {
      src: "readOpen",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ open: ({ event }) => event.output.id ?? null }) },
      onError: { actions: [] },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
  ],
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output.conversations),
            target: "ready",
            actions: assign({ chats: ({ event }) => sorted(event.output.conversations.map(row)) }),
          },
          // conversations could not answer (offline, no answerer, unavailable): the list
          // says it needs a connection, because a chat cannot be made offline (5).
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {},
    failed: {},
    // Waits one turn of the event loop before asking, so session.changed has reached
    // conversations first, whatever the delivery order: it is then re-reading the
    // account and answers the asks with the new picture, not the one it is leaving.
    resyncing: { after: { 0: "reloading" } },
    reloading: {
      invoke: {
        src: "reload",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output.list.conversations),
            target: "ready",
            actions: assign({
              chats: ({ event }) => sorted(event.output.list.conversations.map(row)),
              open: ({ event }) => event.output.open.id ?? null,
            }),
          },
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
  },
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // Someone signed in or out (4.3): a first visit loads signed out and learns who it is
    // a moment later, so the chats the list started with were not this account's.
    "session.changed": { target: ".resyncing" },
    // The fact's news (4.3, fourth rule), followed in any state so a change that races the
    // starting query is not lost. A change for the draft's id means the draft became a
    // real chat, so a fresh next-chat id is minted above it.
    "conversation.changed": {
      actions: assign({
        chats: ({ context, event }) => upsert(context.chats, event),
        draft: ({ context, event }) => (context.draft === event.id ? context.mint() : context.draft),
      }),
    },
    // The fact confirms a chat is gone (this device's own discard on elapse, or another
    // device's, 4.3 fourth rule): drop the row, unhighlight it if it was open, and clear
    // any countdown still standing for it.
    "conversation.deleted": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          chats: ({ context }) => context.chats.filter((c) => c.id !== event.id),
          open: ({ context }) => (context.open === event.id ? null : context.open),
          discarding: ({ context }) => without(context.discarding, event.id),
        });
        if (context.discarding.has(event.id)) enqueue.cancel(`undo:${event.id}`);
      }),
    },
    // conversations announced which chat is open (12): highlight that row. Held for the
    // open read until it lands, so an open that races the start is applied after it.
    "conversation.opened": {
      actions: assign({ open: ({ event }) => event.id ?? null }),
    },
    // The stage moved (4.3): the subject changed, so a different set of chats is about it.
    // Held for us until the starting subject: read reply lands. Ignored when not
    // following, where it changes nothing shown.
    "subject.changed": {
      actions: assign({ subject: ({ event }) => event.subject }),
    },
    // The trash on a row, or a swipe past its threshold (5): begin the undo window.
    // Nothing is emitted yet; only its elapse makes the delete a fact.
    _discard: {
      guard: ({ context, event }) => context.chats.some((c) => c.id === event.id) && !context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(event.id) });
        enqueue.raise({ type: "_elapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `undo:${event.id}` });
      }),
    },
    // Undo, or a click anywhere on a counting-down row: cancel the window, emit nothing.
    _undo: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.cancel(`undo:${event.id}`);
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
      }),
    },
    // The window ran out (the timer above): now the delete is a fact
    // (conversation.discarded), which conversations turns into a tombstone (5) and the
    // conversation.deleted that removes the row.
    _elapsed: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
        enqueue.emit({ type: "conversation.discarded", id: event.id });
      }),
    },
    // The user picked a row (7.2, internal gesture): announce it, but only for a chat that
    // exists or the next-chat draft, never a stale id. `open` is not set here; it follows
    // conversation.opened, the same for the draft as any other row.
    _pick: {
      guard: ({ context, event }) =>
        !context.discarding.has(event.id) &&
        (context.chats.some((c) => c.id === event.id) || context.draft === event.id),
      actions: emit(({ event }) => ({ type: "conversation.selected", id: event.id })),
    },
  },
});
