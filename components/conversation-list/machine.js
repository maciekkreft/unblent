import { setup, assign, fromPromise, emit, enqueueActions } from "xstate";

// The view component that lists the chats and lets one be picked (6.4): it owns only UI
// state — the rows it is showing, which chat is open, a next-chat draft with no row yet,
// and the rows counting down to a delete — and points at `conversations`, which owns the
// fact. It asks conversations: list for the starting picture, conversations: open for the
// open chat, subject: read for what to scope by, and session: read for whether anyone is
// signed in, following conversation.changed /
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

// The order the user set (5): by the place `conversations` gives each chat, a key
// compared as plain text, id as the tiebreak, the same order conversations uses in its
// list reply, so a new message never moves a row. A row without a place (an event from
// before places) falls back to newest first, after the placed rows.
const order = (a, b) => {
  if (a.position != null && b.position != null) {
    if (a.position !== b.position) return a.position < b.position ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (a.position != null) return -1;
  if (b.position != null) return 1;
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
};
const sorted = (chats) => [...chats].sort(order);

// A chat's links (12), always an array: a heading from before links, or a malformed one,
// reads as none.
const links = (chat) => (Array.isArray(chat.about) ? chat.about : []);

// One row keeps only the fields the list shows, plus the links it scopes by. subtitle is
// the latest answer's first line, "" when there is none or the heading predates it.
const row = ({ id, title, subtitle, about, updatedAt, position }) => ({ id, title, subtitle: subtitle ?? "", about: links({ about }), updatedAt, position });

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
// A chat whose delete was handed to the corner notice is not shown while it waits there.
export const shown = ({ chats, following, subject, handed }) =>
  (following && subject != null ? chats.filter((c) => isAbout(c, subject)) : chats).filter((c) => !handed?.has(c.id));

// The open chat, when it is not among the shown chats (12): a pinned chat after the stage
// moved. Only while following a subject; otherwise the open chat is always shown. Its row
// is the same row as any other; the view sets it apart, as note-list does for a note.
export const apart = ({ chats, following, subject, open, handed }) => {
  if (!following || subject == null || open == null) return null;
  const chat = chats.find((c) => c.id === open);
  return chat && !isAbout(chat, subject) && !handed?.has(chat.id) ? chat : null;
};

// The book titles (12), as { id: title }, from books: list then book.changed and
// book.deleted; null while they cannot be read (no `books` on the page, or no answer).
export const titles = (reply) =>
  Array.isArray(reply?.books) ? Object.fromEntries(reply.books.map((b) => [b.id, b.title])) : null;

// The tag on the chat listed apart (12): where it was opened from, the title of the first
// book among its links ("From Journal"); "Not linked" when it links to no book; "Pinned"
// while the titles cannot be read, or the book is not among them.
export const source = (chat, books) => {
  const book = links(chat).find((l) => l.kind === "book");
  if (!book) return "Not linked";
  const title = books?.[book.id];
  return typeof title === "string" && title ? `From ${title}` : "Pinned";
};

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the chats.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// A Set with one id removed, as a new Set so assign sees a fresh value (XState keeps
// context immutable; the view re-renders on every snapshot regardless).
const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

// A chat row the user can cut or delete: a real chat, not already going.
const live = (context, id) =>
  context.chats.some((c) => c.id === id) && !context.discarding.has(id) && !context.handed.has(id);

// Start a row's undo window on the row (5): nothing is emitted until it runs out.
function startDiscard(enqueue, id) {
  enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(id) });
  enqueue.raise({ type: "_elapsed", id }, { delay: ({ context }) => context.undoMs, id: `undo:${id}` });
}

// The keyboard left the list while a row was cut or counting down (12, Vim keys): its
// delete goes to the corner notice, which keeps its Undo in sight and settles it there
// (conversations deletes on removal.settled). The row stays out of the list meanwhile.
function handOff(context, enqueue) {
  const ids = [...context.discarding, ...(context.cut ? [context.cut] : [])];
  if (!ids.length) return;
  for (const id of context.discarding) enqueue.cancel(`undo:${id}`);
  for (const id of ids) {
    const chat = context.chats.find((c) => c.id === id);
    if (chat) enqueue.emit({ type: "removal.started", kind: "conversation", id, name: chat.title ?? "" });
  }
  enqueue.assign({
    handed: ({ context }) => new Set([...context.handed, ...ids]),
    discarding: new Set(),
    cut: null,
  });
}

// Where a pasted row shows until conversations announces its real place: a key just
// after the row above it, or before the row below it, by plain comparison. Only for
// this list's order; conversations computes the place it keeps.
const provisional = (chats, after, before) => {
  const above = chats.find((c) => c.id === after)?.position;
  const below = chats.find((c) => c.id === before)?.position;
  if (above != null) return above + "\u0000";
  if (below != null) return "";
  return null;
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
    // Who is signed in (3.4), so the list can ask to sign in instead of offering chats it
    // cannot keep. session.changed is held for this ask until its reply lands.
    readSession: fromPromise(({ input }) => input.ask("session", "read", {})),
    // The book titles for the row listed apart, only while following, where that row can
    // be shown; book.changed and book.deleted are held for this ask until its reply lands.
    readBooks: fromPromise(({ input }) =>
      input.following ? input.ask("books", "list", {}) : Promise.resolve({})),
    readSubject: fromPromise(({ input }) =>
      input.following ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null })),
  },
}).createMachine({
  id: "conversation-list",
  meta: {
    description:
      "Lists the chats in the order the user set, kept on the account and the same on every " +
      "device, and lets the user open one, start a new one, or delete one. The first row is " +
      "always New chat; a new chat goes to the top and a new message does not move a chat. " +
      "With Vim keys on, never while typing in a field: dd cuts the row, greyed and marked Cut " +
      "with no countdown, and the keyboard stays in the list; p places it below the row the " +
      "cursor is on and P above; u on the cut row puts it back. While a row is cut, Escape " +
      "does not leave the list but deletes the row with its undo countdown, and u on a row " +
      "counting down takes the delete back. If the keyboard leaves the list while a row is cut " +
      "or counting down (a row opened, another panel, a click elsewhere), the delete moves to " +
      "the dark notice in the corner with its Undo. o starts a new chat below the cursor row " +
      "and O above it; it takes that place once its first message is sent. New chat stays " +
      "put: dd does nothing there. cc on a chat row edits its title in place: Enter or " +
      "leaving the field saves, Escape cancels, and an empty title gives back the first line " +
      "of the chat's first message; New chat, a cut row and a row counting down are not " +
      "renamed. With a subject a move places the chat between its " +
      "neighbours as the filtered list shows them. While a subject is on the stage only the chats " +
      "about it are listed; with no subject every chat is listed. The open chat, when it is not " +
      "about the subject, such as a pinned chat, is listed apart at the top so the open row is " +
      "never missing. That row's tag says where the chat is from: \"From \" and the title of the " +
      "first book it is about, such as \"From ACT made simple\", following a rename at once; " +
      "\"Not linked\" when it is about no book; \"Pinned\" while the book titles cannot be " +
      "read. Deleting waits out the undo " +
      "window, so it can be taken back in one step. It learns which chat is open from " +
      "`conversations` and never decides it. Signed out it shows no rows, not even New chat, " +
      "only \"Sign in to chat.\", and signing in brings the account's chats back without a " +
      "reload; \"Chats need a connection.\" is only for a signed-in account whose chats cannot " +
      "be reached.",
    kind: "view",
    emits: ["conversation.selected", "conversation.discarded", "conversation.moved", "conversation.renamed", "removal.started"],
    // The subject attribute (12): off is every chat shown, no subject ask; on, only the
    // chats about the subject on the stage.
    attributes: ["subject"],
    asks: ["conversations: list", "conversations: open", "subject: read", "settings: read", "session: read", "books: list"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // Whether someone is signed in (3.4): null until session answers, so the view shows
    // neither the chats nor the sign-in line before it knows which is true.
    signedIn: null,
    mint: input.mint,
    // Whether the page set the `subject` attribute (12); through input so the machine
    // stays importable in Node.
    following: Boolean(input.following),
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    // The book titles, { id: title }, for the tag on the row listed apart; null until
    // books answers, and while it cannot.
    books: null,
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
    // The row cut with Vim's dd (12), waiting for p or P to place it, u to put it back,
    // or Escape to delete it; null when none. Greyed in place, no timer.
    cut: null,
    // The rows whose delete waits in the corner notice (handOff), hidden until it ends.
    handed: new Set(),
    // A new chat started with o or O (12): where it goes once its first message is sent,
    // as { id, after, before }, the draft's id; null when none.
    placing: null,
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
      src: "readBooks",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: { actions: assign({ books: ({ event }) => titles(event.output) }) },
      onError: { actions: [] },
    },
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
      src: "readSession",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
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
    "session.changed": {
      target: ".resyncing",
      actions: assign({ signedIn: ({ event }) => event.userId != null, cut: null, placing: null }),
    },
    // The fact's news (4.3, fourth rule), followed in any state so a change that races the
    // starting query is not lost. A change for the draft's id means the draft became a
    // real chat, so a fresh next-chat id is minted above it.
    // A chat started with o or O becomes real on its first change, and is moved then to
    // the place it was started at (a new chat otherwise goes first).
    "conversation.changed": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          chats: ({ context }) => upsert(context.chats, event),
          draft: ({ context }) => (context.draft === event.id ? context.mint() : context.draft),
        });
        const p = context.placing;
        if (p && p.id === event.id && !context.chats.some((c) => c.id === event.id)) {
          enqueue.assign({ placing: null });
          if (p.after != null || p.before != null)
            enqueue.emit({ type: "conversation.moved", id: p.id, after: p.after, before: p.before });
        }
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
          handed: ({ context }) => without(context.handed, event.id),
          cut: ({ context }) => (context.cut === event.id ? null : context.cut),
        });
        if (context.discarding.has(event.id)) enqueue.cancel(`undo:${event.id}`);
      }),
    },
    // conversations announced which chat is open (12): highlight that row. Held for the
    // open read until it lands, so an open that races the start is applied after it.
    "conversation.opened": {
      actions: assign({ open: ({ event }) => event.id ?? null }),
    },
    // A book renamed or gone (4.3): the tag on the row listed apart follows at once. Only
    // once the titles were read, so a partial map never stands in for them.
    "book.changed": {
      guard: ({ context }) => context.books != null,
      actions: assign({ books: ({ context, event }) => ({ ...context.books, [event.id]: event.title }) }),
    },
    "book.deleted": {
      guard: ({ context }) => context.books != null,
      actions: assign({
        books: ({ context, event }) => {
          const { [event.id]: _, ...rest } = context.books;
          return rest;
        },
      }),
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
      guard: ({ context, event }) => live(context, event.id) && context.cut !== event.id,
      actions: enqueueActions(({ event, enqueue }) => startDiscard(enqueue, event.id)),
    },
    // Vim's dd on a chat row (12): the row is cut, greyed in place with no timer, while
    // the keyboard stays in the list. A row already cut is deleted with its countdown,
    // as Vim's register holds only the latest cut.
    _cut: {
      guard: ({ context, event }) => live(context, event.id) && context.cut !== event.id,
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (context.cut) startDiscard(enqueue, context.cut);
        enqueue.assign({ cut: event.id });
      }),
    },
    // p or P: the cut chat goes between these neighbours, and is no longer cut. The row
    // shows there at once; conversations' announcement of its place follows.
    _paste: {
      guard: ({ context }) => context.cut != null,
      actions: enqueueActions(({ context, event, enqueue }) => {
        const id = context.cut;
        const after = event.after ?? null;
        const before = event.before ?? null;
        enqueue.assign({ cut: null });
        if (after === id || before === id) return;
        const position = provisional(context.chats, after, before);
        if (position != null)
          enqueue.assign({ chats: ({ context }) => sorted(context.chats.map((c) => (c.id === id ? { ...c, position } : c))) });
        enqueue.emit({ type: "conversation.moved", id, after, before });
      }),
    },
    // u on the cut row: it stays where it was.
    _uncut: { guard: ({ context }) => context.cut != null, actions: assign({ cut: null }) },
    // Escape while a row is cut: the cut becomes the ordinary delete, its countdown on the row.
    _escape: {
      guard: ({ context }) => context.cut != null,
      actions: enqueueActions(({ context, enqueue }) => {
        startDiscard(enqueue, context.cut);
        enqueue.assign({ cut: null });
      }),
    },
    // The keyboard left the list (the view tells): see handOff.
    _left: { actions: enqueueActions(({ context, enqueue }) => handOff(context, enqueue)) },
    // Undo in the corner notice: the row comes back where it was.
    "removal.undone": {
      guard: ({ context, event }) => event.kind === "conversation" && context.handed.has(event.id),
      actions: assign({ handed: ({ context, event }) => without(context.handed, event.id) }),
    },
    // o or O (12): a new chat, opened like New chat, that goes between these neighbours
    // once its first message is sent.
    _place: {
      actions: enqueueActions(({ context, event, enqueue }) => {
        handOff(context, enqueue);
        enqueue.assign({ placing: { id: context.draft, after: event.after ?? null, before: event.before ?? null } });
        enqueue.emit({ type: "conversation.selected", id: context.draft });
      }),
    },
    // The user edited a chat's title in place (cc, 12): announce the trimmed text as
    // conversation.renamed, which conversations keeps and announces back. Unchanged text
    // emits nothing, so a blur that changed nothing is silent; an empty string is a real
    // change (it gives back the first line of the first message), so it is announced. A
    // typed title shows at once; an empty one waits for conversations, which knows the
    // first message.
    _rename: {
      guard: ({ context, event }) => {
        const chat = context.chats.find((c) => c.id === event.id);
        return Boolean(chat) && live(context, event.id) && context.cut !== event.id && event.title.trim() !== chat.title;
      },
      actions: enqueueActions(({ event, enqueue }) => {
        const title = event.title.trim();
        if (title) enqueue.assign({ chats: ({ context }) => context.chats.map((c) => (c.id === event.id ? { ...c, title } : c)) });
        enqueue.emit({ type: "conversation.renamed", id: event.id, title });
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
    // Opening a row while another is cut or counting down hands that delete to the
    // corner notice, so it never goes out of sight (12).
    _pick: {
      guard: ({ context, event }) =>
        !context.discarding.has(event.id) &&
        context.cut !== event.id &&
        (context.chats.some((c) => c.id === event.id) || context.draft === event.id),
      actions: [
        enqueueActions(({ context, enqueue }) => handOff(context, enqueue)),
        assign({ placing: null }),
        emit(({ event }) => ({ type: "conversation.selected", id: event.id })),
      ],
    },
  },
});
