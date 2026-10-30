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
const row = ({ id, title, subtitle, updatedAt, about, position }) => ({
  id,
  title: plain(title),
  subtitle: plain(subtitle),
  updatedAt,
  about: links({ about }),
  position,
});

// Fold one changed note into the rows: replace the row with its id if present, else
// add it, then re-sort. Only the fields a row shows (and its links) are kept (a
// note.changed carries the whole note, 4.3, third rule).
const upsert = (notes, changed) => sorted([...notes.filter((n) => n.id !== changed.id), row(changed)]);

// A note is about the subject when one of its links matches the subject's kind and id
// (D4: a follower compares kind + id, it never learns what kinds exist).
const isAbout = (note, subject) =>
  subject != null && links(note).some((l) => l.kind === subject.kind && l.id === subject.id);

// A highlight of the subject: a link to it that carries a place (12). The list hides
// highlight notes — they belong to the highlights editor, not the note list (Decision 2).
const isHighlight = (note, subject) =>
  subject != null && links(note).some((l) => l.kind === subject.kind && l.id === subject.id && l.place);

// The Highlights row (Decision 1, 5, 6), the Highlights note to the user (13): while following, with a subject on the stage, one fixed row standing for every highlight of the subject — null
// unless at least one note is a highlight of it. Its count and latest time come from the
// notes the list already holds (no new query), so it is pure like `shown` and `apart`.
// None without the `highlights` attribute, and none while `flags` reports the highlights
// feature hidden, or has not answered yet (`hidden` is null), the same as `flags` itself
// with no answer (3.1).
export const highlights = ({ notes, following, highlightsRow, subject, hidden }) => {
  if (!following || !highlightsRow || subject == null) return null;
  if (hidden === null || hidden?.includes("highlights")) return null;
  const hs = notes.filter((n) => isHighlight(n, subject));
  return hs.length ? { count: hs.length, updatedAt: Math.max(...hs.map((n) => n.updatedAt)) } : null;
};

// The rows to show (D6): while following, with a subject on the stage, only the notes
// about it; only when nothing on the stage is a subject (a null subject, or the attribute
// off) is there nothing to scope by, and every note shows. While the subject has an open
// chapter the user may narrow these further to that chapter (`chaptered`); this is the
// set under All chapters. The draft row is the view's, always on top of whichever set
// this returns.
// A note whose delete was handed to the corner notice is not shown while it waits there.
export const shown = ({ notes, following, subject, handed }) =>
  (following && subject != null
    ? notes.filter((n) => isAbout(n, subject) && !isHighlight(n, subject))
    : notes
  ).filter((n) => !handed?.has(n.id));

// A Journal chapter is a day, named by its date (13, Link); a book's never has that
// shape, so the date alone tells the Journal apart without the list learning about books.
const isDay = (chapter) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(chapter ?? "");

// The note's link to the subject, the one that says which of its chapters the note is in.
const linkTo = (note, subject) =>
  subject == null ? undefined : links(note).find((l) => l.kind === subject.kind && l.id === subject.id && !l.place);

// The chapter switch and its groups (plan step 3): only while following a subject that has
// an open chapter; null otherwise, and then the list is `shown` with no switch. `all` is
// the user's choice, This chapter by default. Under either choice the notes linked to no
// chapter come first, because they belong to every chapter, then the open chapter's
// (`here`) or every chapter's (`rest`); `more` counts the notes about the subject that stay
// out of sight in other chapters. The open note, if it is one of those, is listed apart
// instead (`apart`), and not counted.
export const chaptered = (context) => {
  const { following, subject, allChapters, open } = context;
  if (!following || !subject?.chapter) return null;
  const notes = shown(context);
  const chapter = (n) => linkTo(n, subject)?.chapter ?? null;
  const loose = notes.filter((n) => chapter(n) == null);
  const here = notes.filter((n) => chapter(n) === subject.chapter);
  const rest = notes.filter((n) => chapter(n) != null);
  const more = notes.filter((n) => chapter(n) != null && chapter(n) !== subject.chapter && n.id !== open).length;
  return { unit: isDay(subject.chapter) ? "day" : "chapter", all: Boolean(allChapters), loose, here, rest, more };
};

// The note the editor has open, when it is not among the shown notes (12): a pinned
// note after the stage moved, or one still open after unpinning, or, under This chapter,
// a note of another chapter, which the editor keeps open only while it is pinned or the
// keyboard is in it, or after the user picked it. Only while following a subject; otherwise the open note is
// always in the shown set, so there is nothing apart. Its row is the same row as any other; the
// view sets it apart. Computed from context, so no handler decides it: note.opened,
// subject.changed, note.changed and note.deleted keep the inputs current.
export const apart = (context) => {
  const { notes, following, subject, open, handed, allChapters } = context;
  if (!following || subject == null || open == null) return null;
  const note = notes.find((n) => n.id === open);
  if (!note || isHighlight(note, subject) || handed?.has(note.id)) return null;
  if (!isAbout(note, subject)) return note;
  const other = linkTo(note, subject)?.chapter;
  return subject.chapter && !allChapters && other != null && other !== subject.chapter ? note : null;
};

// Where a note placed at a row of the list (p, P, o, O; 12) goes in the whole order the
// user set: right below or above that row, next to it in every list that shows both, even
// while a subject or a chapter hides the notes between it and its neighbour on screen.
// `ids` are the note rows as shown; from a fixed row (New note, Highlights, a note listed
// apart) the note goes above the first shown note. The note being moved is never its own
// neighbour.
export const placement = ({ notes, cut }, ids, current, below) => {
  const all = notes.filter((n) => n.id !== cut).map((n) => n.id);
  const shownIds = ids.filter((id) => id !== cut);
  let at = shownIds.indexOf(current);
  if (at < 0) {
    if (!shownIds.length) return { after: null, before: all[0] ?? null };
    [at, below] = [0, false];
  }
  const i = all.indexOf(shownIds[at]);
  return below ? { after: all[i], before: all[i + 1] ?? null } : { after: all[i - 1] ?? null, before: all[i] };
};

// A Set with one id removed, as a new Set so assign sees a fresh value (XState keeps
// context immutable; the view re-renders on every snapshot regardless).
const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

// The book titles (12), as { id: title }, from books: list then book.changed and
// book.deleted; null while they cannot be read (no `books` on the page, or no answer).
export const titles = (reply) =>
  Array.isArray(reply?.books) ? Object.fromEntries(reply.books.map((b) => [b.id, b.title])) : null;

// The tag on the note listed apart (12): where it was opened from — its chapter of the
// subject when that is what hides it ("From Chapter Two"), else the title of the first
// book among its links ("From Journal"); "Not linked" when it links to no book; "Pinned"
// while the titles cannot be read, or the book is not among them.
export const source = (note, books, subject) => {
  const chapter = linkTo(note, subject)?.chapterTitle;
  if (chapter) return `From ${chapter}`;
  const book = links(note).find((l) => l.kind === "book");
  if (!book) return "Not linked";
  const title = books?.[book.id];
  return typeof title === "string" && title ? `From ${title}` : "Pinned";
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

// A note row the user can cut or delete: a real note, shown, not already going.
const live = (context, id) =>
  context.notes.some((n) => n.id === id) && !context.discarding.has(id) && !context.handed.has(id);

// Start a row's undo window on the row (5): nothing is emitted until it runs out.
function startDiscard(enqueue, id) {
  enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(id) });
  enqueue.raise({ type: "_elapsed", id }, { delay: ({ context }) => context.undoMs, id: `undo:${id}` });
}

// The keyboard left the list while a row was cut or counting down (12, Vim keys): its
// delete goes to the corner notice, which keeps its Undo in sight and settles it there
// (notes deletes on removal.settled). The row stays out of the list meanwhile.
function handOff(context, enqueue) {
  const ids = [...context.discarding, ...(context.cut ? [context.cut] : [])];
  if (!ids.length) return;
  for (const id of context.discarding) enqueue.cancel(`undo:${id}`);
  for (const id of ids) {
    const note = context.notes.find((n) => n.id === id);
    if (note) enqueue.emit({ type: "removal.started", kind: "note", id, name: note.title ?? "" });
  }
  enqueue.assign({
    handed: ({ context }) => new Set([...context.handed, ...ids]),
    discarding: new Set(),
    cut: null,
  });
}

export const machine = setup({
  actors: {
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // The notes starting picture (4.3): note.changed / note.deleted are held for this
    // ask until its reply lands, so a change that races the start is applied after it.
    load: fromPromise(({ input }) => input.ask("notes", "list", {})),
    // The book titles for the row listed apart, only while following, where that row can
    // be shown; book.changed and book.deleted are held for this ask until its reply lands.
    readBooks: fromPromise(({ input }) =>
      input.following ? input.ask("books", "list", {}) : Promise.resolve({})),
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
    // Which features are hidden, for the Highlights row, which only a following list has;
    // flags.changed is held for this ask until its reply lands.
    flags: fromPromise(({ input }) =>
      input.following && input.highlightsRow ? input.ask("flags", "read", {}) : Promise.resolve({ hidden: [] })),
  },
}).createMachine({
  id: "note-list",
  meta: {
    description:
      "Lists the notes in the order the user set, kept on the account and the same on every " +
      "device, with New note always the first row; a new note goes to the top and editing a " +
      "note does not move it. The user can open or delete a note; deleting waits out the undo " +
      "window on the row. With Vim keys on, never while typing in a field: dd cuts the row, " +
      "greyed and marked Cut with no countdown, and the keyboard stays in the list; p places " +
      "it below the row the cursor is on and P above; u on the cut row puts it back. While a " +
      "row is cut, Escape does not leave the list but deletes the row with its undo countdown, " +
      "and u on a row counting down takes the delete back. If the keyboard leaves the list " +
      "while a row is cut or counting down (a row opened, another panel, a click elsewhere), " +
      "the delete moves to the dark notice in the corner with its Undo. o makes a new note " +
      "below the cursor row and O above it, opened in the editor. The New note and Highlights " +
      "rows stay put: dd does nothing there. A moved or new note goes right below or above the " +
      "row it was placed at, also in the whole order, so notes hidden by the subject or the " +
      "chapter stay where they were. With `subject` it lists only the " +
      "notes about the subject, and a note open in the editor that is not about it, such as a " +
      "pinned note, is listed apart at the top so the open row is never missing; it learns " +
      "which note is open from the editor. While the subject has an open chapter (a book's " +
      "chapter, or the Journal's day), a switch above the list reads \"This chapter\" and " +
      "\"All chapters\" (\"This day\" and \"All days\" in the Journal). It starts on This " +
      "chapter and the choice is kept in this browser. This chapter shows first the notes about " +
      "the book linked to no chapter, under \"Not linked to a chapter\" when there are any, " +
      "then, under the open chapter's title, its notes or \"No notes in this chapter yet.\" " +
      "(\"on this day\" in the Journal), then \"N more in other chapters\" with Show all, " +
      "which switches to All chapters; an open note of another chapter is listed apart. All " +
      "chapters lists every note about the book. A note row linked to a chapter names the " +
      "chapter's title before its second line; a note linked to the whole book shows nothing " +
      "extra. That apart row's tag says where the note is from: \"From \" and its chapter's " +
      "title when it is in another chapter of the book, else \"From \" " +
      "and the title of the first book it is linked to, such as \"From Journal\", following a " +
      "rename at once; \"Not linked\" when it is linked to no book; \"Pinned\" while the book " +
      "titles cannot be read. While the subject has at least one highlight, a " +
      "fixed Highlights row under New note shows how many there are and the time of the latest, " +
      "and picking it shows the highlights editor in the note editor's place, under the same " +
      "Back bar. The Highlights row has no record of its own, so it cannot be deleted. Whether " +
      "the Highlights are the open row is kept in this browser across a reload, as the panel " +
      "keeps showing them, so the row stays marked and the keyboard comes back to it. " +
      "Highlights are never listed as separate notes. The Highlights row shows only on a page " +
      "that gives the list the `highlights` attribute, so the Mac page, which leaves it off, " +
      "lists no Highlights row while the book still shows its highlights. There is no Highlights row while " +
      "`flags` reports the highlights feature hidden, or until it answers; a page without " +
      "`flags` hides nothing. Signed out it shows only \"Sign in to " +
      "see your notes.\": no New note, no Highlights row and no notes. The notes stay kept in " +
      "this browser and come back when the user signs in, without a reload; a delete still " +
      "in its undo window when the user signs out is taken back. On a try page a visitor not " +
      "yet signed in still sees the list.",
    kind: "view",
    emits: ["note.selected", "note.discarded", "highlights.selected", "note.moved", "removal.started"],
    // The subject attribute (D5): off is exactly today's behaviour — no subject ask,
    // no filtering, every note shown. On, the list shows only the notes about the
    // subject on the stage, with the Highlights row above them while the subject has
    // a highlight, and the chapter switch while the subject has an open chapter.
    // The highlights attribute: on, the Highlights row is offered while following; off,
    // highlights are still kept out of the list but nothing stands for them.
    attributes: ["subject", "highlights"],
    asks: ["notes: list", "subject: read", "settings: read", "session: read", "books: list", "flags: read"],
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
    // Whether the page set the `highlights` attribute: the Highlights row is offered.
    highlightsRow: Boolean(input.highlightsRow),
    // Whether the Highlights row is the picked one (Decision 7). UI state: set when it is
    // picked, cleared by any note.selected, the gesture that puts a note in the panel in
    // their place. The view keeps it in localStorage (3.1) and hands it back through
    // input, because the panel keeps showing the Highlights across a reload and the
    // keyboard must come back to their row, not to the note the editor still holds.
    highlightsOpen: Boolean(input.highlightsOpen),
    // The chapter switch (plan step 3): true on All chapters. UI state the view keeps in
    // localStorage (3.1) and hands back through input, so the choice follows the device.
    allChapters: Boolean(input.allChapters),
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    // The book titles, { id: title }, for the tag on the row listed apart; null until
    // books answers, and while it cannot.
    books: null,
    // How long a discarded row can be brought back (the --duration-undo token, read
    // in the view and passed in so the machine stays importable in Node). The delete
    // is not a fact until this window ends (delayed delete): stop it and nothing was
    // emitted, so a fact is never "deleted" while a row still offers Undo.
    undoMs: input.undoMs,
    notes: [],
    // The note the editor is showing, learned from note.opened, never set on a
    // gesture: the list does not decide what is open.
    open: null,
    // The ids counting down to a discard, each with its own cancelable timer (below).
    // A row here shows struck through with an Undo where its trash was.
    discarding: new Set(),
    // The row cut with Vim's dd (12), waiting for p or P to place it, u to put it back,
    // or Escape to delete it; null when none. Greyed in place, no timer.
    cut: null,
    // The rows whose delete waits in the corner notice (handOff), hidden until it ends.
    handed: new Set(),
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
    // The features `flags` reports hidden, for the Highlights row (8); null until it answers.
    hidden: null,
  }),
  // The subject read runs for the machine's whole life (3.5), so the notes-load
  // transition (loading → ready) never cancels it: its reply lands on its own and sets
  // the subject, and the notes reply never writes the subject, so a slow notes reply
  // cannot re-apply the read's stale null over a subject.changed that arrived first.
  invoke: [
    {
      src: "flags",
      input: ({ context }) => ({ ask: context.ask, following: context.following, highlightsRow: context.highlightsRow }),
      onDone: { actions: assign({ hidden: ({ event }) => (Array.isArray(event.output?.hidden) ? event.output.hidden : []) }) },
      onError: { actions: assign({ hidden: [] }) },
    },
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
            actions: assign({ notes: ({ event }) => sorted(event.output.notes.map(row)) }),
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
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    // Who is signed in now (4.3). Signing out hides the rows and keeps them; a delete the
    // user can no longer see is taken back, so nothing goes without its Undo.
    "session.changed": [
      { guard: ({ event }) => event.userId != null, actions: assign({ signedIn: true }) },
      {
        actions: enqueueActions(({ context, enqueue }) => {
          for (const id of context.discarding) enqueue.cancel(`undo:${id}`);
          enqueue.assign({ signedIn: false, discarding: new Set(), cut: null });
        }),
      },
    ],
    // The fact's news (4.3, fourth rule), followed in any state so a change that
    // races the starting query is not lost. A change for the draft's id means the
    // draft became a real note, so a fresh next-note id is minted above it.
    // A note made with o or O becomes real on its first change, and is moved then to
    // the place it was opened at (a new note otherwise sorts first).
    "note.changed": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          notes: ({ context }) => upsert(context.notes, event),
          draft: ({ context }) => (context.draft === event.id ? context.mint() : context.draft),
        });
        const p = context.placing;
        if (p && p.id === event.id && !context.notes.some((n) => n.id === event.id)) {
          enqueue.assign({ placing: null });
          if (p.after != null || p.before != null) enqueue.emit({ type: "note.moved", id: p.id, after: p.after, before: p.before });
        }
      }),
    },
    // The fact confirms a note is gone (this device's own discard on elapse, or
    // another device's, 4.3 fourth rule): drop the row, unhighlight it if it was open,
    // and clear any countdown still standing for it.
    "note.deleted": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          notes: ({ context }) => context.notes.filter((n) => n.id !== event.id),
          open: ({ context }) => (context.open === event.id ? null : context.open),
          discarding: ({ context }) => without(context.discarding, event.id),
          handed: ({ context }) => without(context.handed, event.id),
          cut: ({ context }) => (context.cut === event.id ? null : context.cut),
        });
        if (context.discarding.has(event.id)) enqueue.cancel(`undo:${event.id}`);
      }),
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
    // The stage moved (4.3): the subject changed, so a different set of notes is about
    // it. Held for us until the starting subject: read reply lands, so it is never lost
    // and never applied before the picture it supersedes. Ignored when not following,
    // where it changes nothing shown.
    "subject.changed": {
      actions: assign({ subject: ({ event }) => event.subject }),
    },
    // The trash on a row, or a swipe past its threshold (5): begin the undo window.
    // Nothing is emitted yet; only its elapse makes the delete a fact.
    _discard: {
      guard: ({ context, event }) => shows({ context }) && live(context, event.id) && context.cut !== event.id,
      actions: enqueueActions(({ event, enqueue }) => startDiscard(enqueue, event.id)),
    },
    // Vim's dd on a note row (12): the row is cut, greyed in place with no timer, while
    // the keyboard stays in the list. A row already cut is deleted with its countdown,
    // as Vim's register holds only the latest cut.
    _cut: {
      guard: ({ context, event }) => shows({ context }) && live(context, event.id) && context.cut !== event.id,
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (context.cut) startDiscard(enqueue, context.cut);
        enqueue.assign({ cut: event.id });
      }),
    },
    // p or P: the cut note goes between these neighbours, and is no longer cut.
    _paste: {
      guard: ({ context }) => context.cut != null,
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ cut: null });
        if (event.after !== context.cut && event.before !== context.cut)
          enqueue.emit({ type: "note.moved", id: context.cut, after: event.after ?? null, before: event.before ?? null });
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
      guard: ({ context, event }) => event.kind === "note" && context.handed.has(event.id),
      actions: assign({ handed: ({ context, event }) => without(context.handed, event.id) }),
    },
    // o or O (12): a new note, opened in the editor like New note, that goes between
    // these neighbours once the user writes in it.
    _place: {
      guard: shows,
      actions: enqueueActions(({ context, event, enqueue }) => {
        handOff(context, enqueue);
        enqueue.assign({
          highlightsOpen: false,
          placing: { id: context.draft, after: event.after ?? null, before: event.before ?? null },
        });
        enqueue.emit({ type: "note.selected", id: context.draft });
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
    // The window ran out (the timer above): now the delete is a fact (note.discarded),
    // which notes turns into a tombstone and the note.deleted that removes the row.
    _elapsed: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
        enqueue.emit({ type: "note.discarded", id: event.id });
      }),
    },
    // The editor announced the note it now shows (6.4): that row reads as the open note.
    // The draft is untouched — the next-note row stands whatever else is open, and its
    // id is only a name, so opening it again lands the editor in blank all the same. It
    // does not clear the Highlights row's mark (Decision 7): after a reload the editor
    // announces the note it holds while the panel still shows the Highlights.
    "note.opened": { actions: assign({ open: ({ event }) => event.id }) },
    // A note put in the panel, from this list or anywhere else: the Highlights give way.
    "note.selected": { actions: assign({ highlightsOpen: false }) },
    // The chapter switch, or Show all: which notes the list shows; nothing is emitted.
    _chapters: { actions: assign({ allChapters: ({ event }) => Boolean(event.all) }) },
    // The user picked a row (7.2, internal gesture): announce it, but only for a note
    // that exists or the next-note draft, never a stale id. `open` is not set here;
    // it follows the editor's note.opened, the same for the draft as any other row.
    // Picking a note clears the Highlights row's picked mark (Decision 7).
    // Opening a row while another is cut or counting down hands that delete to the
    // corner notice, so it never goes out of sight (12).
    _pick: {
      guard: ({ context, event }) =>
        shows({ context }) &&
        !context.discarding.has(event.id) &&
        context.cut !== event.id &&
        (context.notes.some((n) => n.id === event.id) || context.draft === event.id),
      actions: [
        enqueueActions(({ context, enqueue }) => handOff(context, enqueue)),
        assign({ highlightsOpen: false, placing: null }),
        emit(({ event }) => ({ type: "note.selected", id: event.id })),
      ],
    },
    // The user picked the Highlights row (7.2, internal gesture; Decision 2, 7): announce
    // the gesture the container consumes to show the highlights document, and mark the row
    // as the picked one. Guarded on the row actually being shown, so a stale pick is inert.
    _pickHighlights: {
      guard: ({ context }) => shows({ context }) && highlights(context) != null,
      actions: [
        enqueueActions(({ context, enqueue }) => handOff(context, enqueue)),
        assign({ highlightsOpen: true }),
        emit(({ context }) => ({
          type: "highlights.selected",
          about: { kind: context.subject.kind, id: context.subject.id },
        })),
      ],
    },
  },
});
