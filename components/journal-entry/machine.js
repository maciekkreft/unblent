import { setup, assign, emit, enqueueActions, fromPromise, fromCallback, spawnChild, stopChild } from "xstate";

// The view component where the user writes the journal (6.4). It owns only UI state —
// which day is shown, the text being typed as a draft, whether typing is waiting to be
// saved, whether the box has the keyboard, and a conflict the user has not settled — and
// points at three facts: it asks journal: read, settings: read and session: read for the
// starting picture and follows journal.changed, settings.changed and session.changed after
// (4.3, fourth rule); settings only for the "Vim keys" preference (12), session only for
// whether anyone is signed in, and books: read only to learn whether an opened book is the
// journal (written); notes: list and notes: read, following note.changed and note.deleted,
// only for which highlights the day's source links point at still exist and where they are. Writing leaves as day.saved, at a throttle while
// typing and at once on blur with `left` (4.3, third rule); whether a save lands is the
// journal's to decide, because the "today only" rule lives there. The ask, the id
// minting, the clock and the throttle arrive through input, so the machine is
// importable in Node.

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD, as the journal dates a day.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const calendar = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// A day's title, "Monday 12 October".
export const longDate = (day) =>
  calendar(day).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).replace(",", "");

// The wire form of a day's text is the note's (note-editor/machine.js, copied because
// components never import each other, 11.2): a line prefixed "# ", "## " or "### " is a
// Title, Heading or Subheading, an unprefixed line is Body. The document the user edits
// is marker-free, and parseBody/serialize are the one place the two forms meet.
const PREFIX = { title: "# ", heading: "## ", subheading: "### ", body: "" };

export function parseBody(md) {
  if (md === "") return { doc: "", levels: ["body"] };
  const doc = [];
  const levels = [];
  for (const line of md.split("\n")) {
    if (line.startsWith("### ")) { levels.push("subheading"); doc.push(line.slice(4)); }
    else if (line.startsWith("## ")) { levels.push("heading"); doc.push(line.slice(3)); }
    else if (line.startsWith("# ")) { levels.push("title"); doc.push(line.slice(2)); }
    else { levels.push("body"); doc.push(line); }
  }
  return { doc: doc.join("\n"), levels };
}

export function serialize(doc, levels) {
  if (doc === "") return "";
  // A blank line is a paragraph gap, always Body (architecture.md 10), so it never
  // carries a marker.
  return doc
    .split("\n")
    .map((text, i) => (text === "" ? "" : (PREFIX[levels[i]] ?? "") + text))
    .join("\n");
}

// The journal as `books` presents it (books' journalBook): chapter i is the i-th day
// of journal: read, oldest first, and one chapter past the last day is today's empty
// page when no day is open. So a chapter maps to its day's id, and the last chapter to
// the open day or to null, today's page. The followed chapter wins over the Days list's
// pick while it is set.
export const selectedOf = (context) =>
  context.chapter === null ? context.selected : (context.picture.days[context.chapter]?.id ?? null);

// The day the entry shows: the earlier day picked in the Days list, read only; else the
// open day; else a new page for today under a fresh id, which becomes a day at its
// first character.
export const shown = (picture, selected, fresh, now) => {
  const open = picture.days.find((d) => d.id === picture.open);
  const picked = selected && selected !== picture.open ? picture.days.find((d) => d.id === selected) : null;
  if (picked) return { day: picked, editable: false };
  if (open) return { day: open, editable: true };
  return { day: { id: fresh, day: dateOf(now), text: "", editedAt: now, version: 1, waiting: [], unanswered: [] }, editable: true };
};

// The next local midnight after `now`, when a new page's date changes.
const midnightAfter = (now) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

// A conflict on the shown day, or null. Either copy can be kept, on any day: the journal
// takes a kept copy as a save to the day the conflict named, also once it has closed.
export const conflictOn = (conflict, day) =>
  conflict && conflict.id === day.id ? { mine: conflict.mine.text, theirs: conflict.theirs.text, ...labels(conflict) } : null;

const clock = (ms, seconds = false) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}` + (seconds ? `:${pad(d.getSeconds())}` : "");
};

// What each copy is called. Two records of one date (the journal sends the other copy's
// time of last edit) are told apart by when each was last written, with the date when
// the two differ and the seconds when both fall in one minute, so the two never read the
// same; a day saved on two devices by whose it is.
export function labels({ mine, theirs }) {
  if (!Number.isInteger(mine.editedAt)) return { twice: false, mineLabel: "Yours", theirsLabel: "The other device's" };
  const dated = dateOf(mine.editedAt) !== dateOf(theirs.editedAt);
  const seconds = Math.floor(mine.editedAt / 60000) === Math.floor(theirs.editedAt / 60000);
  const written = (ms) =>
    dated
      ? `Written on ${new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long" })} at ${clock(ms)}`
      : `Written at ${clock(ms, seconds)}`;
  return { twice: true, mineLabel: written(mine.editedAt), theirsLabel: written(theirs.editedAt) };
}

const EMPTY = { days: [], open: null };

// What the entry reads of the journal: its days and which one is open.
const picture = (event) => ({ days: event.days, open: event.open });

const isPicture = (r) => Array.isArray(r?.days);

// The draft follows the day the box edits. While typing waits to be saved, the same day
// keeps what is on screen; another day starts from what the journal holds. A fresh id
// that has become a day is replaced, so the next new page is a new day.
const settle = (context, next, dirty) => {
  const fresh = next.days.some((d) => d.id === context.fresh) ? context.mint() : context.fresh;
  const view = shown(next, selectedOf(context), fresh, context.now());
  const editable = view.editable ? view.day : null;
  const same = Boolean(editable) && context.draft?.id === editable.id;
  return {
    picture: next,
    fresh,
    draft: dirty && same ? context.draft : editable ? { id: editable.id, text: editable.text } : null,
    // The box is still being typed in until it is left, whatever the journal echoes.
    ...(same ? {} : { editing: false }),
  };
};

// A save the journal can use: an existing day's, or a new page with something written.
const savable = (context) =>
  Boolean(context.draft) && (context.picture.days.some((d) => d.id === context.draft.id) || context.draft.text !== "");

// The shown day's date, and whether it can still be written, leave as day.shown, once
// when the page has loaded and again only when either changes, so a view about one day
// (nested under the text) needs no copy of the rule above or of the journal's "today
// only" rule, which keeps yesterday open for an hour past its last edit. Every
// transition that can move them ends with this.
const announce = enqueueActions(({ context, enqueue }) => {
  const view = shown(context.picture, selectedOf(context), context.fresh, context.now());
  const { day } = view.day;
  if (day === context.shownDay && view.editable === context.shownWritable) return;
  enqueue.assign({ shownDay: day, shownWritable: view.editable });
  enqueue.emit({ type: "day.shown", day, writable: view.editable });
});

// Nobody acts at midnight, yet a new page then takes the new day's date. The second past
// it keeps the clock safely on the new day.
const atMidnight = enqueueActions(({ context, enqueue }) => {
  const now = context.now();
  enqueue.raise({ type: "_midnight" }, { id: "midnight", delay: midnightAfter(now) - now + 1000 });
});

const save = (left) =>
  enqueueActions(({ context, enqueue }) => {
    if (!savable(context)) return;
    const { id, text } = context.draft;
    enqueue.emit(left ? { type: "day.saved", id, text, left: true } : { type: "day.saved", id, text });
  });

// Typing after a choice makes it final: the journal no longer takes it back once the day
// has changed, so the Undo goes.
const edit = assign(({ context, event }) => ({ draft: { ...context.draft, text: event.text }, editing: true, kept: null }));

// A choice can be taken back in one step for the undo window (12, forgiveness): the
// conflict as the page showed it is held, and Undo leaves as conflict.reopened, after
// which the journal tells the conflict again.
const keep = (side) =>
  enqueueActions(({ context, enqueue }) => {
    const { id, mine, theirs } = context.conflict;
    enqueue.emit({ type: "day.saved", id, text: side === "mine" ? mine.text : theirs.text });
    enqueue.assign({ kept: { id, mine: mine.text, theirs: theirs.text } });
    enqueue.cancel("kept");
    enqueue.raise({ type: "_keptElapsed" }, { id: "kept", delay: context.undoMs });
  });

const follow = (dirty) => [assign(({ context, event }) => settle(context, picture(event), dirty)), announce];

// What a pick asks the entry to show: a day from the Days list, or a chapter of the
// journal book (null is today's page).
const pickOf = (event) => (event.type === "day.selected" ? { selected: event.id, chapter: null } : { selected: null, chapter: event.chapter });

// Another day picked: what is being typed is saved first, then the entry follows.
const select = (dirty) => ({
  target: "clean",
  actions: [
    ...(dirty ? [save(false)] : []),
    assign(({ context, event }) => {
      const pick = pickOf(event);
      return { ...settle({ ...context, ...pick }, context.picture, false), ...pick };
    }),
    announce,
  ],
});

// A book opened or a chapter picked in the contents: followed only for a book whose
// books: read reply says it is written, the journal. Whether a book is written is
// cached by id and kept current by book.changed and book.deleted (4.3, fourth rule); an
// unknown book is asked about once, and the answer applies to the latest pick, if that
// pick is still in this book. book.opened shows today's page, the last chapter.
const followBook = enqueueActions(({ context, event, enqueue, self }) => {
  if (event.id == null) return;
  const want = { id: event.id, chapter: event.type === "chapter.selected" ? event.chapter : null };
  enqueue.assign({ want });
  const known = context.written[event.id];
  if (known === true) enqueue.raise({ type: "_show", chapter: want.chapter });
  if (known !== undefined || context.asking.includes(event.id)) return;
  const { id } = want;
  enqueue.assign({ asking: [...context.asking, id] });
  Promise.resolve(context.ask("books", "read", { id }))
    .then((r) => self.send({ type: "_book", id, written: r?.book?.written === true, known: Boolean(r?.book) }))
    .catch(() => self.send({ type: "_book", id, written: false, known: false }));
});

// The journal's book id, as books reported it: the book being followed when it is the
// journal, else any book books said is written. Null while no book has been seen as the
// journal, as on a page without books.
export const journalId = (context) =>
  context.want && context.written[context.want.id] === true
    ? context.want.id
    : (Object.keys(context.written).find((id) => context.written[id] === true) ?? null);

// :q in the editor (the editor kit's quit, Vim keys on) closes the journal's book.
const quit = enqueueActions(({ context, enqueue }) => {
  const id = journalId(context);
  if (id) enqueue.emit({ type: "book.closed", id });
});

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the journal.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the page shows of the account (14, signed out): "wait" until session answers, so
// neither the day nor the sign-in line flashes; "sign-in" signed out, since the days kept
// in this browser are the account's; "show" otherwise. A try page (8) shows the journal to
// a visitor who is not yet a guest.
// Where following a source link goes (note-editor/machine.js, copied because components
// never import each other, 11.2): the book and the passage the highlight's link to its
// book carries, from a notes: read reply. Null when the highlight is gone (a tombstone
// reads not-found) or the note marks no passage, so nothing opens.
export function passageOf(reply, id) {
  const about = Array.isArray(reply?.note?.about) ? reply.note.about : [];
  const link = about.find((l) => l.kind === "book" && l.place);
  return link ? { book: link.id, id, place: link.place } : null;
}

// Whether the highlight a source link names is gone, so its tag is drawn grey: a note
// notes no longer lists, once it has answered, or one a follow found gone. While notes has
// not answered (a page without it), only a follow can tell.
export const linkMissing = ({ notes, removed }) => (id) => removed.includes(id) || (notes !== null && !notes.includes(id));

const without = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : list);

// Vim keys on a journal day (12, "Vim keys"): j in normal mode on the text's last line
// moves the keyboard down onto the views nested under the text, and k on a nested view's
// first row, which that view leaves unused, moves it back up. `vim` is the Vim plugin's
// state of the editor; a count, an operator or a half-typed command keeps the key Vim's.
const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
export function textEdge(e, vim, line, { last }) {
  if (!vim || vim.insertMode || vim.visualMode || !plain(e)) return null;
  const s = vim.inputState;
  if (s && (s.operator || s.keyBuffer?.length || s.prefixRepeat?.length || s.motionRepeat?.length)) return null;
  return e.key === "j" && line >= last ? "down" : null;
}

// The first and the last line a cursor can stand on, by the lines' lengths in order: a
// blank line is a gap the cursor steps over (the editor kit, 10), so blank lines at either
// end do not count, unless the cursor stands on one.
export function edges(lengths, cursor) {
  let first = 1;
  let last = lengths.length;
  while (first < cursor && lengths[first - 1] === 0) first += 1;
  while (last > cursor && lengths[last - 1] === 0) last -= 1;
  return { first, last };
}

// A j or k a nested view let bubble out unused: the next or the previous stop in the
// order shown, the text being the stop above the first nested view.
export const nestedStep = (e, vimKeys) => (vimKeys && plain(e) ? { j: "down", k: "up" }[e.key] ?? null : null);

export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // Which notes exist, for the day's source links; note.changed and note.deleted are held
    // for this ask until its reply lands.
    notes: fromPromise(({ input }) => input.ask("notes", "list", {})),
    // Following a source link asks notes for the highlight beside whatever the entry is
    // doing, so the draft is untouched; the reply comes back as _followed.
    follow: fromCallback(({ input, sendBack }) => {
      Promise.resolve(input.ask("notes", "read", { id: input.id })).then(
        (reply) => sendBack({ type: "_followed", id: input.id, reply }),
        () => sendBack({ type: "_followed", id: input.id, reply: null }),
      );
    }),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "journal-entry",
  meta: {
    description:
      "The journal's page: the day picked in the Days list or in the journal book's contents, " +
      "or the day that can still be edited, or an empty page for today. It follows the open book " +
      "only while that book is the journal: opening the journal, or its last chapter, shows " +
      "today's page, and an earlier chapter shows that day; other books are ignored. The day's " +
      "text is shown once, in one editor, read only on an earlier day, with Vim when the Vim " +
      "keys setting is on. Each line is Title, Heading, Subheading or Body, like a note: the four " +
      "buttons under the text set the level of the lines the cursor spans, show the cursor " +
      "line's level, and name the Vim keys \\1, \\2, \\3 and \\0 while Vim is on; an earlier " +
      "day shows its levels but offers no buttons. The text is saved a short time into " +
      "typing and when the box loses focus. When a day was saved on two devices at once, or the " +
      "journal holds two records of the shown date, the entry shows both copies, also on an " +
      "earlier day, labelled Yours and The other device's, or for two records of a date by when " +
      "each was last written (Written at 09:14, with the date when the two differ and the seconds when both fall in one minute), and the user keeps one; for a few seconds after, Undo, with a bar " +
      "showing the time left, brings both copies back. It announces which day it shows and whether " +
      "it can still be written, when the page has loaded and whenever either changes, also at " +
      "midnight on today's empty page and when yesterday's hour of writing past midnight runs " +
      "out, and it holds a view a page nests in it under the day's text, which scrolls with " +
      "the text and follows the announced day. With Vim keys on, typing :q or :quit in the " +
      "editor, on any day, closes the journal's book. With Vim keys on, p pastes text or a link copied in the reader with Vim keys, paragraphs kept. A source link to a highlight, pasted " +
      "from the reader's Copy link (or with p after the reader's y while Vim keys is on), is " +
      "drawn as one tag, the link icon and the start of the quote, that the cursor steps over " +
      "and Backspace or x removes whole, while the day's saved text keeps the link as it was " +
      "pasted; a click on it, or Enter on it in Vim's normal mode, opens the book at the " +
      "passage, also on an earlier day, and a tag whose highlight is gone turns grey and " +
      "struck through and opens nothing. Signed out it shows no day, no level " +
      "buttons and nothing nested under the text, only \"Sign in to write in your journal.\"; " +
      "the days stay kept in this browser and come back when the user signs in, without a " +
      "reload. On a try page a visitor not yet signed in still writes." +
      " A web address, bare or written as [label](https://…), is drawn as an underlined link in " +
      "the accent color, a markdown link showing only its label except on the line being " +
      "edited; a click on it, or gx with Vim keys on, opens it in a new browser tab, on an " +
      "earlier day too. With Vim keys on, j in normal mode on the text's last line moves the " +
      "keyboard down onto the views nested under the text, in the order they are shown, and " +
      "j or k on one of them that it does not use itself (j on its last row, k on its first) " +
      "moves to the next one or back up, the text being the stop above the first; the keyboard " +
      "comes back to the start of the text's last line. On an earlier day, whose text takes no " +
      "keyboard, the keyboard lands on the first nested view instead.",
    kind: "view",
    emits: ["day.saved", "day.shown", "book.closed", "passage.selected", "conflict.reopened"],
    attributes: ["height"],
    asks: ["journal: read", "settings: read", "books: read", "session: read", "notes: list", "notes: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    now: input.now,
    throttleMs: input.throttleMs ?? 200,
    picture: EMPTY,
    // The id a new page for today is saved under, once something is written on it.
    fresh: input.mint(),
    // The day picked in the Days list; null follows the open day.
    selected: null,
    // The journal book's chapter being followed (selectedOf); null follows the Days list.
    chapter: null,
    // Whether each book seen is written (the journal), by id, from books.
    written: {},
    // The latest book pick, {id, chapter}, and the books being asked about.
    want: null,
    asking: [],
    // The date, and whether it could be written, last announced as day.shown; null until
    // the page has loaded.
    shownDay: null,
    shownWritable: null,
    draft: null,
    editing: false,
    conflict: null,
    // The conflict just settled, while Keep this copy can be taken back: its day's id and
    // the two copies' texts; null once the undo window ends.
    kept: null,
    undoMs: input.undoMs ?? 3000,
    // The "Vim keys" device preference (12), owned by `settings`: off until it says
    // otherwise, and off on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
    // The ids of every note notes lists, for the source links' tags; null until it answers.
    notes: null,
    // Source links a follow found gone (UI state): their tags are drawn grey.
    removed: [],
    // Puts text or a source link copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
  }),
  // Each fact's starting picture is asked on its own, so an event that follows one
  // reply is never overwritten by that reply arriving with the other.
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
    {
      src: "notes",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ event }) => Array.isArray(event.output?.notes),
        actions: assign({ notes: ({ event }) => event.output.notes.map((n) => n.id) }),
      },
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
            guard: ({ event }) => isPicture(event.output),
            target: "ready",
            actions: [assign(({ context, event }) => settle(context, picture(event.output), false)), announce],
          },
          // The journal could not answer: an honest failure rather than an empty page.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      entry: atMidnight,
      initial: "clean",
      states: {
        clean: {
          on: {
            _edit: { guard: ({ context }) => Boolean(context.draft), target: "dirty", actions: edit },
            _blur: { guard: ({ context }) => context.editing, actions: [save(true), assign({ editing: false })] },
            "journal.changed": { actions: follow(false) },
            "day.selected": select(false),
            _show: select(false),
          },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        dirty: {
          on: {
            _edit: { actions: edit },
            _blur: { target: "clean", actions: [save(true), assign({ editing: false })] },
            "journal.changed": { actions: follow(true) },
            "day.selected": select(true),
            _show: select(true),
          },
          after: { throttle: { target: "clean", actions: save(false) } },
        },
      },
      on: {
        // A conflict is settled in one step: the kept copy leaves as a save of its exact
        // text to the day the conflict named, which tells the journal which copy stays
        // (journal's kept). Keeping the copy the journal holds changes no text, yet still
        // lets the journal delete the other record when the two were two records of one date.
        _keepMine: {
          guard: ({ context }) => Boolean(context.conflict),
          target: ".clean",
          actions: [
            keep("mine"),
            assign(({ context }) => ({
              ...(context.picture.open === context.conflict.id ? { draft: { id: context.conflict.id, text: context.conflict.mine.text } } : {}),
              conflict: null,
              editing: false,
            })),
          ],
        },
        _keepTheirs: {
          guard: ({ context }) => Boolean(context.conflict),
          actions: [keep("theirs"), assign({ conflict: null })],
        },
        _undoKeep: {
          guard: ({ context }) => Boolean(context.kept),
          actions: enqueueActions(({ context, enqueue }) => {
            enqueue.cancel("kept");
            enqueue.emit({ type: "conflict.reopened", ...context.kept });
            enqueue.assign({ kept: null });
          }),
        },
        _keptElapsed: { actions: assign({ kept: null }) },
        _midnight: { actions: [announce, atMidnight] },
      },
    },
    failed: {},
  },
  // The facts' news (4.3, fourth rule). Each read is superseded by its fact's event (4.2),
  // so none arrives before the starting picture it updates.
  on: {
    "journal.changed": { actions: assign(({ event }) => ({ picture: picture(event) })) },
    "journal.conflicted": {
      actions: assign(({ context, event }) => ({
        conflict: { id: event.id, mine: event.mine, theirs: event.theirs },
        kept: context.kept?.id === event.id ? null : context.kept,
      })),
    },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null }) },
    "day.selected": { actions: assign(({ event }) => ({ selected: event.id, chapter: null })) },
    _show: { actions: assign(({ event }) => ({ selected: null, chapter: event.chapter })) },
    _quit: { actions: quit },
    "book.opened": { actions: followBook },
    "chapter.selected": { actions: followBook },
    _book: {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ asking: context.asking.filter((x) => x !== event.id) });
        if (event.known) enqueue.assign({ written: { ...context.written, [event.id]: event.written } });
        if (event.written && context.want?.id === event.id) enqueue.raise({ type: "_show", chapter: context.want.chapter });
      }),
    },
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, blocks a blank line apart as paragraphs are.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    // A click on a source link, or Enter on it in Vim's normal mode, on any day: ask notes
    // for the highlight. A second follow replaces one still waiting.
    _follow: {
      actions: [
        stopChild("follow"),
        spawnChild("follow", { id: "follow", input: ({ context, event }) => ({ ask: context.ask, id: event.id }) }),
      ],
    },
    // The highlight's reply: the book opens at the passage (passage.selected), or the
    // highlight is gone and its tag turns grey.
    _followed: [
      {
        guard: ({ event }) => passageOf(event.reply, event.id) != null,
        actions: [
          assign({ removed: ({ context, event }) => without(context.removed, event.id) }),
          emit(({ event }) => ({ type: "passage.selected", ...passageOf(event.reply, event.id) })),
        ],
      },
      {
        guard: ({ event }) => event.reply?.error === "not-found",
        actions: assign({ removed: ({ context, event }) => [...without(context.removed, event.id), event.id] }),
      },
    ],
    // notes' news (4.3, fourth rule): a note made, changed or brought back exists; a
    // deleted one does not.
    "note.changed": {
      actions: assign(({ context, event }) => ({
        notes: context.notes === null || context.notes.includes(event.id) ? context.notes : [...context.notes, event.id],
        removed: without(context.removed, event.id),
      })),
    },
    "note.deleted": {
      actions: assign(({ context, event }) => ({
        notes: context.notes === null ? null : without(context.notes, event.id),
        removed: context.notes === null ? [...without(context.removed, event.id), event.id] : context.removed,
      })),
    },
    "book.changed": { actions: assign(({ context, event }) => ({ written: { ...context.written, [event.id]: event.written === true } })) },
    "book.deleted": {
      actions: assign(({ context, event }) => {
        const { [event.id]: _gone, ...written } = context.written;
        return { written };
      }),
    },
  },
});
