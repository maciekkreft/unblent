import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component where the user writes the journal (6.4). It owns only UI state —
// which day is shown, the text being typed as a draft, whether typing is waiting to be
// saved, whether the box has the keyboard, and a conflict the user has not settled — and
// points at two facts: it asks journal: read and settings: read for the starting picture
// and follows journal.changed and settings.changed after (4.3, fourth rule); settings
// only for the "Vim keys" preference (12), and books: read only to learn whether an
// opened book is the journal (written). Writing leaves as day.saved, at a throttle while
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
  return doc
    .split("\n")
    .map((text, i) => (PREFIX[levels[i]] ?? "") + text)
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

// A conflict on the shown day, or null. Keeping one's own copy saves it over the other,
// which the journal accepts only while the day is open; a closed day keeps the other.
export const conflictOn = (conflict, day, editable) =>
  conflict && conflict.id === day.id ? { mine: conflict.mine.text, theirs: conflict.theirs.text, keepable: editable } : null;

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

const edit = assign(({ context, event }) => ({ draft: { ...context.draft, text: event.text }, editing: true }));

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

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
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
      "typing and when the box loses focus. When a day was saved on two devices at once, the " +
      "entry shows both copies and the user keeps one. It announces which day it shows and whether " +
      "it can still be written, when the page has loaded and whenever either changes, also at " +
      "midnight on today's empty page and when yesterday's hour of writing past midnight runs " +
      "out, and it holds a view a page nests in it under the day's text, which scrolls with " +
      "the text and follows the announced day.",
    kind: "view",
    emits: ["day.saved", "day.shown"],
    attributes: ["height"],
    asks: ["journal: read", "settings: read", "books: read"],
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
    // The "Vim keys" device preference (12), owned by `settings`: off until it says
    // otherwise, and off on a page without it (the ask replies no-answerer).
    vimKeys: false,
  }),
  // Each fact's starting picture is asked on its own, so an event that follows one
  // reply is never overwritten by that reply arriving with the other.
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
  },
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
        // A conflict is settled in one step. Keeping one's own copy saves it over the
        // other while the day is open; keeping the other's saves nothing, because the
        // journal already holds it.
        _keepMine: {
          guard: ({ context }) => Boolean(context.conflict) && context.picture.open === context.conflict.id,
          target: ".clean",
          actions: [
            assign(({ context }) => ({ draft: { id: context.conflict.id, text: context.conflict.mine.text }, conflict: null, editing: false })),
            save(false),
          ],
        },
        _keepTheirs: { actions: assign({ conflict: null }) },
        _midnight: { actions: [announce, atMidnight] },
      },
    },
    failed: {},
  },
  // The facts' news (4.3, fourth rule). Each read is superseded by its fact's event (4.2),
  // so none arrives before the starting picture it updates.
  on: {
    "journal.changed": { actions: assign(({ event }) => ({ picture: picture(event) })) },
    "journal.conflicted": { actions: assign(({ event }) => ({ conflict: { id: event.id, mine: event.mine, theirs: event.theirs } })) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "day.selected": { actions: assign(({ event }) => ({ selected: event.id, chapter: null })) },
    _show: { actions: assign(({ event }) => ({ selected: null, chapter: event.chapter })) },
    "book.opened": { actions: followBook },
    "chapter.selected": { actions: followBook },
    _book: {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ asking: context.asking.filter((x) => x !== event.id) });
        if (event.known) enqueue.assign({ written: { ...context.written, [event.id]: event.written } });
        if (event.written && context.want?.id === event.id) enqueue.raise({ type: "_show", chapter: context.want.chapter });
      }),
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
