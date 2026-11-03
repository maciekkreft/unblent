import { setup, assign, fromPromise, emit, enqueueActions } from "xstate";

// The view component that lists the chats and lets one be picked (6.4): it owns only UI
// state — the rows it is showing, which chat is open, a next-chat draft with no row yet,
// and the last chat deleted with Vim's dd — and points at `conversations`, which owns the
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
// chat shows. While the subject has an open chapter the user may narrow these further to
// that chapter (`chaptered`); this is the set under All chapters. The draft row is the
// view's, always on top of whichever set this returns.
export const shown = ({ chats, following, subject }) =>
  following && subject != null ? chats.filter((c) => isAbout(c, subject)) : chats;

// A Journal chapter is a day, named by its date (13, Link); a book's never has that
// shape, so the date alone tells the Journal apart without the list learning about books.
const isDay = (chapter) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(chapter ?? "");

// The chat's link to the subject, the one that says which of its chapters the chat is in.
const linkTo = (chat, subject) =>
  subject == null ? undefined : links(chat).find((l) => l.kind === subject.kind && l.id === subject.id);

// The chapter switch and its groups, as note-list has them: only while following a
// subject that has an open chapter; null otherwise, and then the list is `shown` with no
// switch. `all` is the user's choice, This chapter by default. This chapter is the open
// chapter's chats alone (`here`), so it reads as that chapter; All chapters is the whole
// book, so the chats linked to no chapter come first there (`loose`), then every
// chapter's (`rest`).
export const chaptered = (context) => {
  const { following, subject, allChapters } = context;
  if (!following || !subject?.chapter) return null;
  const chats = shown(context);
  const chapter = (c) => linkTo(c, subject)?.chapter ?? null;
  const loose = allChapters ? chats.filter((c) => chapter(c) == null) : [];
  const here = chats.filter((c) => chapter(c) === subject.chapter);
  const rest = chats.filter((c) => chapter(c) != null);
  return { unit: isDay(subject.chapter) ? "day" : "chapter", all: Boolean(allChapters), loose, here, rest };
};

// Where a chat placed at a row of the list (p, P, o, O; 12) goes in the whole order the
// user set: right below or above that row, next to it in every list that shows both, even
// while a subject or a chapter hides the chats between it and its neighbour on screen.
// `ids` are the chat rows as shown; from the fixed New chat row the chat goes above the
// first shown chat.
export const placement = ({ chats }, ids, current, below) => {
  const all = chats.map((c) => c.id);
  const shownIds = ids;
  let at = shownIds.indexOf(current);
  if (at < 0) {
    if (!shownIds.length) return { after: null, before: all[0] ?? null };
    [at, below] = [0, false];
  }
  const i = all.indexOf(shownIds[at]);
  return below ? { after: all[i], before: all[i + 1] ?? null } : { after: all[i - 1] ?? null, before: all[i] };
};

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the chats.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// A chat row the user can delete: a real chat.
const live = (context, id) => context.chats.some((c) => c.id === id);

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
      "A delete happens at once and shows the short notice with Undo, and Undo and Redo take " +
      "back a delete, a move or a rename (section 12). " +
      "With Vim keys on, never while typing in a field: dd deletes the row at once, with the " +
      "same notice, and the keyboard moves to the next row; the list keeps the last chat it " +
      "deleted in memory, and p brings it back below the row the cursor is on and P above, " +
      "one step that Undo deletes again. p and P do nothing once that chat is back by another " +
      "way (an Undo, another device) or after signing out. u is the global Undo. " +
      "o starts a new chat below the cursor row " +
      "and O above it; it takes that place once its first message is sent. New chat stays " +
      "put: dd does nothing there. cc on a chat row edits its title in place: Enter or " +
      "leaving the field saves, Escape cancels, and an empty title gives back the first line " +
      "of the chat's first message; New chat is not renamed. A moved or new chat goes right below or above the row it was placed at, also " +
      "in the whole order, so chats hidden by the subject or the chapter stay where they were. " +
      "While a subject is on the stage only the chats " +
      "about it are listed, never a chat apart from them, also while the open chat is not about " +
      "it; with no subject every chat is listed. While the subject has an open chapter (a book's chapter, or the " +
      "Journal's day), a switch above the list reads \"This chapter\" and \"All chapters\" " +
      "(\"This day\" and \"All days\" in the Journal). It starts on This chapter and the " +
      "choice is kept in this browser. The switch is two equal halves across the list in one " +
      "rectangular box, and the top row of its keyboard path: k or the up arrow on the first " +
      "row reaches it, h and l or the left and right arrows change it, and j or the down arrow " +
      "goes back to the first row. This chapter lists only the open chapter's chats (in the " +
      "Journal, the open day's). All chapters lists every chat about the book: first the " +
      "chats linked to no chapter, then a line, then every chapter's chats; the line shows " +
      "only with chats on both sides of it. A chat row linked to a chapter names the chapter's title " +
      "before its second line; a chat linked to the whole book shows nothing extra. It learns which chat is open from " +
      "`conversations` and never decides it. Signed out it shows no rows, not even New chat, " +
      "only \"Sign in to chat.\", and signing in brings the account's chats back without a " +
      "reload; \"Chats need a connection.\" is only for a signed-in account whose chats cannot " +
      "be reached.",
    kind: "view",
    emits: ["conversation.selected", "conversation.discarded", "conversation.moved", "conversation.renamed"],
    // The subject attribute (12): off is every chat shown, no subject ask; on, only the
    // chats about the subject on the stage, and the chapter switch while the subject has
    // an open chapter.
    attributes: ["subject"],
    asks: ["conversations: list", "conversations: open", "subject: read", "settings: read", "session: read"],
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
    // The chapter switch: true on All chapters. UI state the view keeps in localStorage
    // (3.1) and hands back through input, so the choice follows the device.
    allChapters: Boolean(input.allChapters),
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    chats: [],
    // Which chat is open, learned from conversations: open then conversation.opened; never
    // set on a gesture (the list does not decide what is open).
    open: null,
    // The last chat deleted with Vim's dd (12), which p or P brings back; null when none.
    // Like Vim's register it is UI state, kept in memory only.
    deleted: null,
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
    // a moment later, so the chats the list started with were not this account's, nor the
    // chat dd deleted, which p could no longer bring back to it.
    "session.changed": {
      target: ".resyncing",
      actions: assign({ signedIn: ({ event }) => event.userId != null, deleted: null, placing: null }),
    },
    // The fact's news (4.3, fourth rule), followed in any state so a change that races the
    // starting query is not lost. A change for the draft's id means the draft became a
    // real chat, so a fresh next-chat id is minted above it.
    // A chat started with o or O becomes real on its first change, and is moved then to
    // the place it was started at (a new chat otherwise goes first). The chat dd deleted
    // coming back (an Undo, another device) is no longer one p can bring back.
    "conversation.changed": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          chats: ({ context }) => upsert(context.chats, event),
          draft: ({ context }) => (context.draft === event.id ? context.mint() : context.draft),
          deleted: ({ context }) => (context.deleted === event.id ? null : context.deleted),
        });
        const p = context.placing;
        if (p && p.id === event.id && !context.chats.some((c) => c.id === event.id)) {
          enqueue.assign({ placing: null });
          if (p.after != null || p.before != null)
            enqueue.emit({ type: "conversation.moved", id: p.id, after: p.after, before: p.before });
        }
      }),
    },
    // The fact confirms a chat is gone (this device's own delete, another device's, or an
    // Undo, 4.3 fourth rule): drop the row and unhighlight it if it was open.
    "conversation.deleted": {
      actions: assign({
        chats: ({ context, event }) => context.chats.filter((c) => c.id !== event.id),
        open: ({ context, event }) => (context.open === event.id ? null : context.open),
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
    // The chapter switch, or Show all: which chats the list shows; nothing is emitted.
    _chapters: { actions: assign({ allChapters: ({ event }) => Boolean(event.all) }) },
    // The trash on a row, or a swipe past its threshold: the chat is deleted at once, one
    // step with the short notice and its Undo (12, Undo).
    _discard: {
      guard: ({ context, event }) => live(context, event.id),
      actions: emit(({ event }) => ({ type: "conversation.discarded", id: event.id })),
    },
    // Vim's dd on a chat row (12): the same delete, and the list remembers the chat so p
    // or P can bring it back. A second dd replaces it, as Vim's register holds one.
    _dd: {
      guard: ({ context, event }) => live(context, event.id),
      actions: [
        assign({ deleted: ({ event }) => event.id }),
        emit(({ event }) => ({ type: "conversation.discarded", id: event.id })),
      ],
    },
    // p or P: the deleted chat comes back between these neighbours; `conversations`
    // restores it there as one step.
    _paste: {
      guard: ({ context }) => context.deleted != null,
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ deleted: null });
        enqueue.emit({ type: "conversation.moved", id: context.deleted, after: event.after ?? null, before: event.before ?? null });
      }),
    },
    // o or O (12): a new chat, opened like New chat, that goes between these neighbours
    // once its first message is sent.
    _place: {
      actions: enqueueActions(({ context, event, enqueue }) => {
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
        return Boolean(chat) && live(context, event.id) && event.title.trim() !== chat.title;
      },
      actions: enqueueActions(({ event, enqueue }) => {
        const title = event.title.trim();
        if (title) enqueue.assign({ chats: ({ context }) => context.chats.map((c) => (c.id === event.id ? { ...c, title } : c)) });
        enqueue.emit({ type: "conversation.renamed", id: event.id, title });
      }),
    },
    // The user picked a row (7.2, internal gesture): announce it, but only for a chat that
    // exists or the next-chat draft, never a stale id. `open` is not set here; it follows
    // conversation.opened, the same for the draft as any other row.
    _pick: {
      guard: ({ context, event }) =>
        context.chats.some((c) => c.id === event.id) || context.draft === event.id,
      actions: [
        assign({ placing: null }),
        emit(({ event }) => ({ type: "conversation.selected", id: event.id })),
      ],
    },
  },
});
