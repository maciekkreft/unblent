import { setup, assign, fromPromise, emit, enqueueActions } from "xstate";

// The view component that lists the notes and lets one be picked (6.4): it owns only
// UI state — the rows it is showing, which one the editor has open, and a draft id
// with no row yet — and points at `notes`, which owns the fact. It asks notes: list
// for the starting picture and follows note.changed / note.deleted after (4.3,
// fourth rule); it never decides which row is open, it learns that from note.opened,
// so the highlighted row is always the note the editor is showing. The ask and mint
// arrive through input, so this stays a pure definition importable in Node.
//
// The next note the user would write is always the first row (the blank page on top
// of the pad, as in Notes.app), so `draft` is always a minted id with no row yet.
// Picking it opens a blank editor under that id; when the user types, note.changed
// brings the real row and a fresh draft is minted above it. The list never creates a
// note — a fact learns of creation from a gesture (4.3, fifth rule) — it only holds
// the name a note will take. It asks session: read and follows session.changed only for
// whether anyone is signed in.

// The order the user set (5): by the place `notes` gives each note, a key compared as
// plain text, id as the tiebreak, the same order notes uses in its list reply, so an
// edit never moves a row. A row without a place (an event from before places) falls
// back to newest first, after the placed rows.
const order = (a, b) => {
  if (a.position != null && b.position != null) {
    if (a.position !== b.position) return a.position < b.position ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (a.position != null) return -1;
  if (b.position != null) return 1;
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
};
const sorted = (notes) => [...notes].sort(order);

// A note's links (12), always an array: an old cached note, or an event from before
// links existed, reads as none.
const links = (note) => (Array.isArray(note.about) ? note.about : []);

// A source link in a note's text, `[label](note:<id>)`, with `[`, `]` and `\` in the
// label escaped by `\`. The editor draws it as a tag; a one-line preview has no room for
// a tag, so the list shows the label alone, as the reader would read it.
const SOURCE_LINK = /\[((?:[^\[\]\\\n]|\\[^\n])*)\]\(note:[0-9A-HJKMNP-TV-Z]{26}\)/g;
export const plain = (text) =>
  typeof text === "string" ? text.replace(SOURCE_LINK, (_, label) => label.replace(/\\(.)/g, "$1")) : text;

// One row keeps only the fields the list shows, plus the links it filters by.
const row = ({ id, title, subtitle, updatedAt, about, position, noteType }) => ({
  id,
  title: plain(title),
  subtitle: plain(subtitle),
  updatedAt,
  about: links({ about }),
  position,
  ...(noteType ? { noteType } : {}),
});

// The Slip-Box (13): one fixed note, the top of the tree, opened from the shelf. It is the
// stage's, never a row, so it is never listed and never deleted here.
export const SLIPBOX = "00000000000000000000000SBX";
const listed = (note) => note.id !== SLIPBOX;

// Whether the Slip-Box feature shows (3.1): not until `flags` answers, and not on a page
// without `flags`, since the feature is not released until the admin releases it.
const slipBoxShown = (hidden) => Array.isArray(hidden) && !hidden.includes("slip-box");

// The type a row names at the start of its second line (13), while Slip-Box shows; a note
// without one is fleeting. Null while Slip-Box is hidden, so the row is as before.
const TYPE_NAMES = { fleeting: "Fleeting", literature: "Literature", permanent: "Permanent" };
export const typeLabelOf = (hidden, r) => (slipBoxShown(hidden) ? TYPE_NAMES[r.noteType] ?? TYPE_NAMES.fleeting : null);

// Fold one changed note into the rows: replace the row with its id if present, else
// add it, then re-sort. Only the fields a row shows (and its links) are kept (a
// note.changed carries the whole note, 4.3, third rule).
const upsert = (notes, changed) =>
  listed(changed) ? sorted([...notes.filter((n) => n.id !== changed.id), row(changed)]) : notes;

// A note is about the subject when one of its links matches the subject's kind and id
// (D4: a follower compares kind + id, it never learns what kinds exist).
const isAbout = (note, subject) =>
  subject != null && links(note).some((l) => l.kind === subject.kind && l.id === subject.id);

// A highlight of the subject: a link to it that carries a place (12). The list hides
// highlight notes: the user sees a highlight in the book reader, never as a note (13).
const isHighlight = (note, subject) =>
  subject != null && links(note).some((l) => l.kind === subject.kind && l.id === subject.id && l.place);

// The rows to show (D6): while following, with a subject on the stage, only the notes
// about it; only when nothing on the stage is a subject (a null subject, or the attribute
// off) is there nothing to scope by, and every note shows. While the subject has an open
// chapter the user may narrow these further to that chapter (`chaptered`); this is the
// set under All chapters. The draft row is the view's, always on top of whichever set
// this returns.
export const shown = ({ notes, following, subject }) =>
  following && subject != null ? notes.filter((n) => isAbout(n, subject) && !isHighlight(n, subject)) : notes;

// A Journal chapter is a day, named by its date (13, Link); a book's never has that
// shape, so the date alone tells the Journal apart without the list learning about books.
const isDay = (chapter) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(chapter ?? "");

// The note's link to the subject, the one that says which of its chapters the note is in.
const linkTo = (note, subject) =>
  subject == null ? undefined : links(note).find((l) => l.kind === subject.kind && l.id === subject.id && !l.place);

// The chapter switch and its groups (plan step 3): only while following a subject that has
// an open chapter; null otherwise, and then the list is `shown` with no switch. `all` is
// the user's choice, This chapter by default. This chapter is the open chapter's notes
// alone (`here`), so it reads as that chapter; All chapters is the whole book, so the notes
// linked to no chapter come first there (`loose`), then every chapter's (`rest`).
export const chaptered = (context) => {
  const { following, subject, allChapters } = context;
  if (!following || !subject?.chapter) return null;
  const notes = shown(context);
  const chapter = (n) => linkTo(n, subject)?.chapter ?? null;
  const loose = allChapters ? notes.filter((n) => chapter(n) == null) : [];
  const here = notes.filter((n) => chapter(n) === subject.chapter);
  const rest = notes.filter((n) => chapter(n) != null);
  return { unit: isDay(subject.chapter) ? "day" : "chapter", all: Boolean(allChapters), loose, here, rest };
};

// Where a note placed at a row of the list (p, P, o, O; 12) goes in the whole order the
// user set: right below or above that row, next to it in every list that shows both, even
// while a subject or a chapter hides the notes between it and its neighbour on screen.
// `ids` are the note rows as shown; from the New note row the note goes
// above the first shown note.
export const placement = ({ notes }, ids, current, below) => {
  const all = notes.map((n) => n.id);
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
// counts as signed in, so a page that cannot tell never hides the notes.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the list shows of the account (14, signed out): "wait" until session answers, so
// neither the rows nor the sign-in line flashes; "sign-in" signed out, since the notes
// kept in this browser are the account's; "show" otherwise. A try page (8) shows its
// visitor the list.
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

// A gesture on a row counts only while the rows are shown.
const shows = ({ context }) => showing(context) === "show";

// A note with notes under it: one of the rows links to it as its parent.
const hasChildren = (context, id) => context.notes.some((n) => links(n).some((l) => l.kind === "note" && l.id === id));

// A note row the user can delete: a real note, shown, with no notes under it, so a delete
// never leaves a note without the place it was put in.
export const deletable = (context, id) => context.notes.some((n) => n.id === id) && !hasChildren(context, id);

// The link a note brought back with p or P takes (12): while Slip-Box shows and the list
// is about a thing the deleted note was not about, that thing, with its open chapter, as
// a new note there would be linked; otherwise none, and the note keeps its links.
export const pasteLink = ({ following, subject, hidden, deletedAbout }) => {
  if (!following || subject == null || !slipBoxShown(hidden)) return undefined;
  if ((deletedAbout ?? []).some((l) => l.kind === subject.kind && l.id === subject.id)) return undefined;
  const chapter = subject.chapter ? { chapter: subject.chapter, chapterTitle: subject.chapterTitle } : {};
  return { kind: subject.kind, id: subject.id, ...chapter };
};

export const machine = setup({
  actors: {
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // The notes starting picture (4.3): note.changed / note.deleted are held for this
    // ask until its reply lands, so a change that races the start is applied after it.
    load: fromPromise(({ input }) => input.ask("notes", "list", {})),
    // The subject starting picture, asked as its own concern (3.5) so its reply — the
    // picture at read time — never overwrites a subject.changed that arrived first while
    // the notes list was still loading. On a reload the notes pull is slow and the book
    // on the stage comes back on its own after; batching the subject into the notes
    // reply would let that slow reply re-apply the read's stale null over the book.
    // subject.changed is held for this ask until its reply lands (subject: read
    // supersededBy), so it is applied after the starting picture, in order.
    readSubject: fromPromise(({ input }) =>
      input.following ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null })),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // Which features are hidden (3.1); flags.changed is held until the reply lands.
    flags: fromPromise(({ input }) => input.ask("flags", "read", {})),
  },
}).createMachine({
  id: "note-list",
  meta: {
    description:
      "Lists the notes in the order the user set, kept on the account and the same on every " +
      "device, with New note always the first row; a new note goes to the top and editing a " +
      "note does not move it. The user can open, move or delete a note; a delete happens at " +
      "once and shows the short notice with Undo, and Undo and Redo take back a delete or a " +
      "move (section 12). With Vim keys on, never while typing in a field: dd deletes the row " +
      "at once, with the same notice, and the keyboard moves to the next row; the list keeps " +
      "the last note it deleted in memory, and p brings it back below the row the cursor is " +
      "on and P above, one step that Undo deletes again; while the Slip-Box feature shows, p or P " +
      "in a list about another thing than the deleted note brings it back under that thing, " +
      "in place of its link of the same kind. p and P do nothing once that note " +
      "is back by another way (an Undo, another device) or after signing out. u is the " +
      "global Undo. A note with notes under it cannot be deleted: its trash is greyed out " +
      "with the tooltip \"Move or delete the notes under it first\", and dd and a swipe do nothing " +
      "on it. While the Slip-Box feature shows, each row's second line starts with the note's type, " +
      "Fleeting, Literature or Permanent (Fleeting for a note without one). The Slip-Box note is never listed. While a note is the subject (a note in front on " +
      "the stage), the list shows the notes under it, with no chapter switch, and New note writes " +
      "one under it. o makes a new note " +
      "below the cursor row and O above it, opened in the editor. The New note row stays " +
      "put: dd does nothing there. A moved or new note goes right below or above the " +
      "row it was placed at, also in the whole order, so notes hidden by the subject or the " +
      "chapter stay where they were. With `subject` it lists only the " +
      "notes about the subject, never a note apart from them, also while the editor keeps open a " +
      "note that is not about it; it learns which note is open from the editor. While the subject has an open chapter (a book's " +
      "chapter, or the Journal's day), a switch above the list reads \"This chapter\" and " +
      "\"All chapters\" (\"This day\" and \"All days\" in the Journal). It starts on This " +
      "chapter and the choice is kept in this browser. The switch is two equal halves across " +
      "the list in one rectangular box, and the top row of its keyboard path: k or the up " +
      "arrow on the first row reaches it, h and l or the left and right arrows change it, and " +
      "j or the down arrow goes back to the first row. This chapter lists only the open " +
      "chapter's notes (in the Journal, the open day's). All chapters lists every note about " +
      "the book: first the notes linked to no chapter, then a line, then every chapter's " +
      "notes; the line shows only with notes on both sides of it. A note row linked to a chapter names the " +
      "chapter's title before its second line; a note linked to the whole book shows nothing " +
      "extra. Highlights are never listed as notes: the book reader shows them. Signed out " +
      "it shows only \"Sign in to see your notes.\": no New note and no notes. The notes stay kept in " +
      "this browser and come back when the user signs in, without a reload. On a try page a visitor not " +
      "yet signed in still sees the list.",
    kind: "view",
    emits: ["note.selected", "note.discarded", "note.moved"],
    // The subject attribute (D5): off is exactly today's behaviour — no subject ask,
    // no filtering, every note shown. On, the list shows only the notes about the
    // subject on the stage, with the chapter switch while the subject has an open chapter.
    attributes: ["subject"],
    asks: ["notes: list", "subject: read", "settings: read", "session: read", "flags: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    mint: input.mint,
    // Whether the page set the `subject` attribute (D5); it arrives through input so
    // the machine stays importable in Node.
    following: Boolean(input.following),
    // The chapter switch (plan step 3): true on All chapters. UI state the view keeps in
    // localStorage (3.1) and hands back through input, so the choice follows the device.
    allChapters: Boolean(input.allChapters),
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    notes: [],
    // The note the editor is showing, learned from note.opened, never set on a
    // gesture: the list does not decide what is open.
    open: null,
    // The last note deleted with Vim's dd (12), which p or P brings back; null when none.
    // Like Vim's register it is UI state, kept in memory only.
    deleted: null,
    // The links the note dd deleted had, so p or P can tell whether this list is about
    // another thing (pasteLink).
    deletedAbout: [],
    // The features `flags` reports hidden (3.1); null until it answers.
    hidden: null,
    // A new note made with o or O (12): where it goes once the user writes in it, as
    // { id, after, before }, the draft's id; null when none.
    placing: null,
    // The next note's id, always present: the first row, blank until the user types
    // and note.changed brings its real row, whereupon a fresh one is minted.
    draft: input.mint(),
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
  }),
  // The subject read runs for the machine's whole life (3.5), so the notes-load
  // transition (loading → ready) never cancels it: its reply lands on its own and sets
  // the subject, and the notes reply never writes the subject, so a slow notes reply
  // cannot re-apply the read's stale null over a subject.changed that arrived first.
  invoke: [
    {
      src: "readSubject",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: { actions: assign({ subject: ({ event }) => event.output.subject ?? null }) },
      onError: { actions: [] },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
    {
      src: "flags",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ hidden: ({ event }) => (Array.isArray(event.output?.hidden) ? event.output.hidden : null) }) },
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
            guard: ({ event }) => Array.isArray(event.output.notes),
            target: "ready",
            actions: assign({ notes: ({ event }) => sorted(event.output.notes.filter(listed).map(row)) }),
          },
          // notes could not answer (offline, no answerer): an honest empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {},
    failed: {},
  },
  on: {
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // Who is signed in now (4.3). Signing out hides the rows and keeps them, and forgets
    // the note dd deleted, which p could no longer bring back to this account.
    "session.changed": [
      { guard: ({ event }) => event.userId != null, actions: assign({ signedIn: true }) },
      { actions: assign({ signedIn: false, deleted: null }) },
    ],
    // The fact's news (4.3, fourth rule), followed in any state so a change that
    // races the starting query is not lost. A change for the draft's id means the
    // draft became a real note, so a fresh next-note id is minted above it.
    // A note made with o or O becomes real on its first change, and is moved then to
    // the place it was opened at (a new note otherwise sorts first). The note dd deleted
    // coming back (an Undo, another device) is no longer one p can bring back.
    "note.changed": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          notes: ({ context }) => upsert(context.notes, event),
          draft: ({ context }) => (context.draft === event.id ? context.mint() : context.draft),
          deleted: ({ context }) => (context.deleted === event.id ? null : context.deleted),
        });
        const p = context.placing;
        if (p && p.id === event.id && !context.notes.some((n) => n.id === event.id)) {
          enqueue.assign({ placing: null });
          if (p.after != null || p.before != null) enqueue.emit({ type: "note.moved", id: p.id, after: p.after, before: p.before });
        }
      }),
    },
    // The fact confirms a note is gone (this device's own delete, another device's, or
    // an Undo, 4.3 fourth rule): drop the row and unhighlight it if it was open.
    "note.deleted": {
      actions: assign({
        notes: ({ context, event }) => context.notes.filter((n) => n.id !== event.id),
        open: ({ context, event }) => (context.open === event.id ? null : context.open),
      }),
    },
    // The stage moved (4.3): the subject changed, so a different set of notes is about
    // it. Held for us until the starting subject: read reply lands, so it is never lost
    // and never applied before the picture it supersedes. Ignored when not following,
    // where it changes nothing shown.
    "subject.changed": {
      actions: assign({ subject: ({ event }) => event.subject }),
    },
    // The trash on a row, or a swipe past its threshold: the note is deleted at once,
    // one step with the short notice and its Undo (12, Undo).
    _discard: {
      guard: ({ context, event }) => shows({ context }) && deletable(context, event.id),
      actions: emit(({ event }) => ({ type: "note.discarded", id: event.id })),
    },
    // Vim's dd on a note row (12): the same delete, and the list remembers the note so p
    // or P can bring it back. A second dd replaces it, as Vim's register holds one.
    _dd: {
      guard: ({ context, event }) => shows({ context }) && deletable(context, event.id),
      actions: [
        assign({
          deleted: ({ event }) => event.id,
          deletedAbout: ({ context, event }) => context.notes.find((n) => n.id === event.id)?.about ?? [],
        }),
        emit(({ event }) => ({ type: "note.discarded", id: event.id })),
      ],
    },
    // p or P: the deleted note comes back between these neighbours; `notes` restores it
    // there as one step, under the thing this list is about when it is another (pasteLink).
    _paste: {
      guard: ({ context }) => shows({ context }) && context.deleted != null,
      actions: enqueueActions(({ context, event, enqueue }) => {
        const about = pasteLink(context);
        enqueue.assign({ deleted: null, deletedAbout: [] });
        enqueue.emit({ type: "note.moved", id: context.deleted, after: event.after ?? null, before: event.before ?? null, ...(about ? { about } : {}) });
      }),
    },
    // o or O (12): a new note, opened in the editor like New note, that goes between
    // these neighbours once the user writes in it.
    _place: {
      guard: shows,
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ placing: { id: context.draft, after: event.after ?? null, before: event.before ?? null } });
        enqueue.emit({ type: "note.selected", id: context.draft });
      }),
    },
    // The editor announced the note it now shows (6.4): that row reads as the open note.
    // The draft is untouched — the next-note row stands whatever else is open, and its
    // id is only a name, so opening it again lands the editor in blank all the same.
    "note.opened": { actions: assign({ open: ({ event }) => event.id }) },
    // The chapter switch, or Show all: which notes the list shows; nothing is emitted.
    _chapters: { actions: assign({ allChapters: ({ event }) => Boolean(event.all) }) },
    // The user picked a row (7.2, internal gesture): announce it, but only for a note
    // that exists or the next-note draft, never a stale id. `open` is not set here;
    // it follows the editor's note.opened, the same for the draft as any other row.
    _pick: {
      guard: ({ context, event }) =>
        shows({ context }) && (context.notes.some((n) => n.id === event.id) || context.draft === event.id),
      actions: [
        assign({ placing: null }),
        emit(({ event }) => ({ type: "note.selected", id: event.id })),
      ],
    },
  },
});
