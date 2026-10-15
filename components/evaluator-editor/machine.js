import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that edits one evaluator (6.4): the item the Evaluators tab's
// list-then-item shows under its Back bar when evaluator.selected arrives. It owns only
// UI state — the evaluator being edited as a draft, the book it is kept with, and
// whether typing is waiting to be saved — and points at four facts: it asks
// evaluators: list for every book's evaluators, because the Journal lists other books'
// marked ones and a pick there names the Journal, and follows evaluator.changed /
// evaluator.deleted after, asks books: list for which book is the Journal and follows
// book.changed / book.deleted, asks settings: read for the "Vim keys" preference (12)
// and follows settings.changed, and, with `subject`, asks subject: read and follows
// subject.changed (4.3, fourth rule), so the tab never keeps showing an evaluator of a
// book that is no longer on the stage while the list beside it has moved on. Its pin, as
// the note editor's and the chat's, sits on the item: pressing it emits pin.toggled, and
// it asks pins: read and follows pins.changed, so while the tab is pinned to a book it
// stays there with the list. Every edit leaves as the whole evaluator,
// evaluator.saved, at a throttle while typing and at once on blur (4.3, third rule). A
// removal leaves as removal.started; `evaluators` marks the item until notice-stack
// settles or undoes it, and the draft follows those marks, so the item disappears at
// once and comes back on Undo. Whenever the evaluator it shows changes, picked or opened
// by itself on another book, a reload or a pin, it says which with evaluator.opened, so
// the list marks that row; it learns nothing back. The ask, the id minting and the throttle arrive through
// input, so the machine is a pure definition importable in Node.

const blankQuestion = (id) => ({ id, kind: "yesno", text: "", yes: "", no: "", options: [], removing: false });
const blankOption = (id) => ({ id, name: "", description: "", removing: false });

const live = (items) => items.filter((x) => !x.removing);

// The draft as evaluator.saved carries it, with "Show in journal": no on/off, which evaluator-list owns as a
// gesture, and no marked item, which `evaluators` keeps in place by itself while its
// undo window runs.
export const wire = (d) => ({
  id: d.id,
  book: d.book,
  name: d.name,
  journal: d.journal === true,
  questions: live(d.questions).map((q) => ({
    id: q.id,
    kind: q.kind,
    text: q.text,
    yes: q.yes,
    no: q.no,
    options: live(q.options).map((o) => ({ id: o.id, name: o.name, description: o.description })),
  })),
});

// Nothing written anywhere in it: a New evaluator opened and left adds no row to the list.
export const isEmpty = (d) =>
  !d.name.trim() &&
  d.questions.every(
    (q) => !q.text.trim() && !q.yes.trim() && !q.no.trim() && q.options.every((o) => !o.name.trim() && !o.description.trim()),
  );

// Options are told apart by name, so two live options of one question named alike are
// worth a note while the user writes.
export const duplicateNames = (q) => {
  const names = live(q.options).map((o) => o.name.trim().toLowerCase()).filter(Boolean);
  return new Set(names).size < names.length;
};

const known = (context, id) => context.evaluators.some((r) => r.id === id);

// The empty rule holds for an evaluator the fact has never had; a kept evaluator the
// user clears is still saved, so clearing it is kept.
const savable = (context) => context.draft && !context.draft.removing && (known(context, context.draft.id) || !isEmpty(context.draft));

const copy = (r) =>
  structuredClone({ id: r.id, book: r.book, name: r.name, journal: r.journal === true, questions: r.questions, removing: r.removing });

const opened = (context, id, book) => {
  const found = context.evaluators.find((r) => r.id === id);
  return found ? copy(found) : { id, book, name: "", journal: false, questions: [blankQuestion(context.mint())], removing: false };
};

// While typing waits to be saved, a change from the fact brings only its removal marks,
// so it never overwrites what is on screen: an item whose removal settled is dropped, and
// an item this editor added and has not saved yet is kept.
export const merged = (draft, record) => ({
  ...draft,
  removing: record.removing,
  questions: draft.questions.flatMap((q) => {
    const r = record.questions.find((x) => x.id === q.id);
    if (!r) return q.removing ? [] : [q];
    return [
      {
        ...q,
        removing: r.removing,
        options: q.options.flatMap((o) => {
          const ro = r.options.find((x) => x.id === o.id);
          if (!ro) return o.removing ? [] : [o];
          return [{ ...o, removing: ro.removing }];
        }),
      },
    ];
  }),
});

// The evaluators after one change from the fact.
const changedList = (context, event) => {
  if (event.type === "evaluator.deleted") return context.evaluators.filter((r) => r.id !== event.id);
  const rest = context.evaluators.filter((r) => r.id !== event.evaluator.id);
  return [...rest, event.evaluator].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

// The draft after a change from the fact. An evaluator the fact no longer has, though
// it had it, was deleted (here and settled, or elsewhere): the editor says so.
const followed = (context, evaluators, keepTyping) => {
  const { draft } = context;
  const record = evaluators.find((r) => r.id === draft.id);
  if (!record) return known(context, draft.id) || draft.removing ? { ...draft, removing: true } : draft;
  return keepTyping && !draft.removing ? merged(draft, record) : copy(record);
};

const follow = (keepTyping) => ({
  actions: assign(({ context, event }) => {
    const evaluators = changedList(context, event);
    return { draft: followed(context, evaluators, keepTyping), evaluators };
  }),
});

const save = enqueueActions(({ context, enqueue }) => {
  if (savable(context)) enqueue.emit({ type: "evaluator.saved", ...wire(context.draft) });
});

const patchQuestion = (draft, id, patch) => ({
  ...draft,
  questions: draft.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)),
});

const patchOption = (draft, question, id, patch) => ({
  ...draft,
  questions: draft.questions.map((q) =>
    q.id === question ? { ...q, options: q.options.map((o) => (o.id === id ? { ...o, ...patch } : o)) } : q,
  ),
});

// Pick one with no options to pick starts with two empty ones; switching keeps the yes /
// no wording and the options alike, so switching back loses nothing.
const kinded = (draft, id, kind, mint) =>
  patchQuestion(draft, id, {
    kind,
    ...(kind === "pick" && !live(draft.questions.find((q) => q.id === id).options).length
      ? { options: [...draft.questions.find((q) => q.id === id).options, blankOption(mint()), blankOption(mint())] }
      : {}),
  });

const liveQuestion = (context, id) => context.draft.questions.find((q) => q.id === id && !q.removing);
const liveOption = (context, question, id) => liveQuestion(context, question)?.options.find((o) => o.id === id && !o.removing);

// The typing gestures, the same in clean and dirty; only the target differs.
const edits = (target) => ({
  _edit: { target, actions: assign(({ context, event }) => ({ draft: { ...context.draft, ...event.patch } })) },
  _editQuestion: {
    guard: ({ context, event }) => !!liveQuestion(context, event.id),
    target,
    actions: assign(({ context, event }) => ({ draft: patchQuestion(context.draft, event.id, event.patch) })),
  },
  _kind: {
    guard: ({ context, event }) => (event.kind === "yesno" || event.kind === "pick") && liveQuestion(context, event.id)?.kind !== event.kind,
    target,
    actions: assign(({ context, event }) => ({ draft: kinded(context.draft, event.id, event.kind, context.mint) })),
  },
  _editOption: {
    guard: ({ context, event }) => !!liveOption(context, event.question, event.id),
    target,
    actions: assign(({ context, event }) => ({ draft: patchOption(context.draft, event.question, event.id, event.patch) })),
  },
  _journal: {
    guard: ({ event }) => typeof event.on === "boolean",
    target,
    actions: assign(({ context, event }) => ({ draft: { ...context.draft, journal: event.on } })),
  },
  _addQuestion: {
    target,
    actions: assign(({ context }) => ({
      draft: { ...context.draft, questions: [...context.draft.questions, blankQuestion(context.mint())] },
    })),
  },
  _addOption: {
    guard: ({ context, event }) => !!liveQuestion(context, event.question),
    target,
    actions: assign(({ context, event }) => ({
      draft: {
        ...context.draft,
        questions: context.draft.questions.map((q) =>
          q.id === event.question ? { ...q, options: [...q.options, blankOption(context.mint())] } : q,
        ),
      },
    })),
  },
});

// A removal first saves the draft as it stands, so `evaluators` holds the item it is
// about to mark; then the item is marked here too and the gesture leaves. In an
// evaluator that was never saved there is nothing to mark and nothing written to lose,
// so the item just goes.
const removal = (kind, find, flagged, dropped) => ({
  guard: ({ context, event }) => !!find(context, event),
  target: ".clean",
  actions: enqueueActions(({ context, event, enqueue }) => {
    if (!savable(context)) {
      enqueue.assign(() => ({ draft: dropped(context.draft, event) }));
      return;
    }
    enqueue.emit({ type: "evaluator.saved", ...wire(context.draft) });
    enqueue.assign(() => ({ draft: flagged(context.draft, event) }));
    const item = find(context, event);
    enqueue.emit({ type: "removal.started", kind, id: item.id, name: kind === "question" ? "" : item.name.trim() });
  }),
});

// A book's most recently edited evaluator, as the note editor opens the newest note: only
// one kept with that book, so in the Journal one marked Show in journal never counts. One
// with no updatedAt (kept from before it was recorded) is the oldest; equal times fall to
// the later id, which is the later made.
export const newest = (evaluators, book) =>
  evaluators
    .filter((r) => r.book === book && !r.removing)
    .reduce((best, r) => {
      if (!best) return r;
      const a = r.updatedAt ?? "";
      const b = best.updatedAt ?? "";
      return a > b || (a === b && r.id > best.id) ? r : best;
    }, null);

const isPick = (event) => typeof event.id === "string" && typeof event.book === "string";

// An evaluator is kept with a book, so only a subject that is a book has evaluators.
const bookOf = (subject) => (subject?.kind === "book" ? subject.id : null);

// The book the evaluator open or being fetched was picked in; null while none is. In
// the Journal that is the Journal, whichever book the evaluator is kept with.
const shownBook = (context) => context.want?.book ?? (context.draft ? context.book : null);

// A new subject or pin (with `subject`): `next` gives both. The evaluator open is left
// only for another book while the tab is not pinned. What was typed is saved first, as
// when moving to another evaluator, and the new book opens on its most recently edited
// evaluator, or a New evaluator when it has none (`latest`). A subject with no book leaves it: subject: read
// answers null until its own asks land, and acting on that would close the evaluator a
// reload has just reopened. Unpinning follows the stage at once, as the list does.
const followSubject = (next, extra = []) => [
  {
    guard: ({ context, event }) => {
      const { subject, pin } = next({ context, event });
      const book = bookOf(subject);
      return context.following && pin == null && book != null && shownBook(context) != null && book !== shownBook(context);
    },
    target: ".fetching",
    actions: [
      ...extra,
      save,
      assign(({ context, event }) => ({
        ...next({ context, event }),
        want: { id: context.mint(), book: bookOf(next({ context, event }).subject), latest: true },
        draft: null,
      })),
      ({ context }) => context.remember({ id: context.want.id, book: context.want.book }),
    ],
  },
  { actions: [...extra, assign(({ context, event }) => next({ context, event }))] },
];

// The list marks the row the editor shows, and the editor opens evaluators by itself, so
// it says so each time the id shown changes. Not while fetching: the list keeps its mark
// until the next evaluator is on screen.
const announce = enqueueActions(({ context, enqueue }) => {
  const id = context.draft?.id ?? null;
  if (id === context.announced) return;
  enqueue.assign({ announced: id });
  enqueue.emit({ type: "evaluator.opened", id });
});

const pinned = (context) => context.pin != null && context.pin === shownBook(context);

// A book's title from books' list or its news, for the About line.
const titled = (books) => Object.fromEntries((Array.isArray(books) ? books : []).map((b) => [b.id, b.title]));

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("evaluators", "list", {})),
    // Which book is the Journal, where "Show in journal" says nothing and is not offered;
    // a page without books gets no-answerer and offers it everywhere.
    books: fromPromise(({ input }) => input.ask("books", "list", {})),
    // The "Vim keys" device preference (12); on a page without a settings fact the ask
    // replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // The starting picture: the pin, then the subject. pins.changed and subject.changed are
    // each held for this ask until their reply lands (supersededBy), so they are applied
    // after, in order.
    readSubject: fromPromise(async ({ input }) => {
      if (!input.following) return { subject: null, pin: null };
      const pins = await input.ask("pins", "read", {});
      const subject = await input.ask("subject", "read", {});
      return { subject: subject?.subject ?? null, pin: typeof pins?.evaluators === "string" ? pins.evaluators : null };
    }),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "evaluator-editor",
  meta: {
    description:
      "Edits one evaluator, the item of the Evaluators tab: its name and its questions. Under " +
      "the name, Show in journal lists an evaluator of any book but the Journal in the " +
      "Journal's Evaluators as well; one opened from the Journal stays open while the " +
      "Journal does. Each " +
      "question is Yes / no, with optional words for what yes and no mean, or Pick one, with " +
      "options that each have a name and an optional description. Every edit is saved as the " +
      "whole evaluator a short time into typing and when a field loses focus, and a new " +
      "evaluator with nothing written in it is never saved. Removing a question or an option, " +
      "and deleting the evaluator, wait out the undo window, with Undo in a notice. The " +
      "evaluator open before a reload opens again while it is still kept. With `subject` it " +
      "follows the book open on the stage, as the list beside it does: when another book " +
      "comes on, what was typed is saved and that book's most recently edited evaluator opens, " +
      "or a New evaluator when it has none; in the Journal only the Journal's own count, not " +
      "those marked Show in journal; while the " +
      "pin at the top right is on it stays on its book, and so does the list beside it; " +
      "unpinning brings the stage's book back at once. The line beside the pin names the book, " +
      "and the pin is kept by `pins`, so it survives a reload. The question, what yes " +
      "and no mean and each option's description are text boxes that grow with what is written " +
      "and take Vim's keys when Vim keys is on; the name and the option names are one-line fields. " +
      "A press on a button or a choice keeps the keyboard there, and the editor's focus comes " +
      "back to the field last used, never jumping to the name. Whichever evaluator it opens, " +
      "picked or opened by itself, the list beside it marks.",
    kind: "view",
    emits: ["evaluator.saved", "removal.started", "pin.toggled", "evaluator.opened"],
    attributes: ["subject"],
    asks: ["evaluators: list", "settings: read", "subject: read", "books: list", "pins: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    following: Boolean(input.following),
    // The book the open evaluator was picked in, and every book's evaluators.
    book: null,
    evaluators: [],
    // The Journal's book id, once books has said.
    journal: null,
    // The subject on the stage, and the book `pins` holds for this tab; pinsObserved says
    // pins.changed came before the start reply, which is then the older picture.
    subject: null,
    pin: null,
    pinsObserved: false,
    // Each book's title by id, for the About line.
    titles: {},
    draft: null,
    // The id last told to the list with evaluator.opened.
    announced: null,
    // The pick being fetched: { id, book }, and `restore` for the evaluator open before a
    // reload, kept on this device (3.1) because list-then-item keeps its item shown; it
    // is reopened only while that evaluator still exists.
    want: isPick(input.open ?? {}) ? { id: input.open.id, book: input.open.book, restore: true } : null,
    remember: input.remember ?? (() => {}),
    vimKeys: false,
  }),
  // Beside the states, so the preference and the subject arrive whatever the editor is
  // doing; a settings.changed or subject.changed that races its ask is held until the
  // reply lands (supersededBy).
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "books",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        actions: assign({
          journal: ({ event }) => (Array.isArray(event.output?.books) ? (event.output.books.find((b) => b?.written === true)?.id ?? null) : null),
          titles: ({ context, event }) => ({ ...titled(event.output?.books), ...context.titles }),
        }),
      },
      onError: { actions: [] },
    },
    {
      src: "readSubject",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: followSubject(({ context, event }) => ({
        subject: event.output?.subject ?? null,
        pin: context.pinsObserved ? context.pin : (event.output?.pin ?? null),
      })),
      onError: { actions: [] },
    },
  ],
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "subject.changed": followSubject(({ context, event }) => ({ subject: event.subject ?? null, pin: context.pin })),
    "pins.changed": followSubject(({ context, event }) => ({ subject: context.subject, pin: event.evaluators ?? null, pinsObserved: true })),
    // The user pressed the pin: the gesture goes to `pins` (4.3, fifth rule), and the
    // editor acts on it at once; pins.changed then confirms it. Nothing to pin while no
    // evaluator is open.
    _togglePin: [
      { guard: ({ context }) => !context.following || shownBook(context) == null, actions: [] },
      ...followSubject(
        ({ context }) => ({ subject: context.subject, pin: pinned(context) ? null : shownBook(context) }),
        [emit(({ context }) => ({ type: "pin.toggled", what: "evaluators", id: pinned(context) ? null : shownBook(context) }))],
      ),
    ],
    "book.changed": [
      {
        guard: ({ event }) => event.written === true,
        actions: assign({ journal: ({ event }) => event.id, titles: ({ context, event }) => ({ ...context.titles, [event.id]: event.title }) }),
      },
      { actions: assign({ titles: ({ context, event }) => ({ ...context.titles, [event.id]: event.title }) }) },
    ],
    // Followed because it supersedes books: list (4.3, fourth rule); books never deletes
    // the Journal, so this only matters if that ever changes.
    "book.deleted": {
      guard: ({ context, event }) => event.id === context.journal,
      actions: assign({ journal: null }),
    },
  },
  initial: "starting",
  states: {
    starting: {
      always: [{ guard: ({ context }) => context.want != null, target: "fetching" }, { target: "ready" }],
    },
    // The book of the pick is asked for; a change the fact makes meanwhile is held for
    // this ask and arrives once the reply has landed (4.2).
    fetching: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, book: context.want.book }),
        onDone: [
          {
            guard: ({ context, event }) =>
              Array.isArray(event.output?.evaluators) &&
              (!context.want.restore || event.output.evaluators.some((r) => r.id === context.want.id && !r.removing)),
            target: "ready.editing",
            actions: [
              enqueueActions(({ context, event, enqueue }) => {
                const { want } = context;
                const next = { ...context, book: want.book, evaluators: event.output.evaluators };
                const id = want.latest ? (newest(next.evaluators, want.book)?.id ?? want.id) : want.id;
                enqueue.assign({ book: want.book, evaluators: next.evaluators, draft: opened(next, id, want.book), want: null });
                if (id !== want.id) enqueue(() => context.remember({ id, book: want.book }));
              }),
              announce,
            ],
          },
          {
            guard: ({ event }) => Array.isArray(event.output?.evaluators),
            target: "ready",
            actions: [assign(({ context, event }) => ({ book: context.want.book, evaluators: event.output.evaluators, want: null })), announce],
          },
          // The fact could not answer: an honest failure rather than an empty editor.
          { target: "failed" },
        ],
        onError: "failed",
      },
      on: {
        "evaluator.selected": {
          guard: ({ event }) => isPick(event),
          target: "fetching",
          reenter: true,
          actions: [
            assign(({ event }) => ({ want: { id: event.id, book: event.book } })),
            ({ context, event }) => context.remember({ id: event.id, book: event.book }),
          ],
        },
      },
    },
    ready: {
      initial: "choosing",
      states: {
        choosing: {},
        editing: {
          initial: "clean",
          states: {
            clean: {
              on: {
                ...edits("dirty"),
                "evaluator.changed": follow(false),
                "evaluator.deleted": follow(false),
              },
            },
            // Typing within the window joins the one save at its end: a throttle, not a
            // debounce, so the targetless edits below never restart the timer.
            dirty: {
              on: {
                ...edits(undefined),
                _blur: { target: "clean", actions: save },
                "evaluator.changed": follow(true),
                "evaluator.deleted": follow(true),
              },
              after: { throttle: { target: "clean", actions: save } },
            },
          },
          on: {
            _removeQuestion: removal(
              "question",
              (context, event) => liveQuestion(context, event.id),
              (d, event) => patchQuestion(d, event.id, { removing: true }),
              (d, event) => ({ ...d, questions: d.questions.filter((q) => q.id !== event.id) }),
            ),
            _removeOption: removal(
              "option",
              (context, event) => liveOption(context, event.question, event.id),
              (d, event) => patchOption(d, event.question, event.id, { removing: true }),
              (d, event) => ({
                ...d,
                questions: d.questions.map((q) => (q.id === event.question ? { ...q, options: q.options.filter((o) => o.id !== event.id) } : q)),
              }),
            ),
            // Only an evaluator the fact holds can be deleted; a New evaluator with nothing
            // in it offers no Delete, because leaving it already keeps nothing.
            _delete: {
              guard: ({ context }) => !context.draft.removing && known(context, context.draft.id),
              target: ".clean",
              actions: [
                save,
                assign(({ context }) => ({ draft: { ...context.draft, removing: true } })),
                emit(({ context }) => ({ type: "removal.started", kind: "evaluator", id: context.draft.id, name: context.draft.name.trim() })),
              ],
            },
          },
        },
      },
      on: {
        "evaluator.changed": { actions: assign(({ context, event }) => ({ evaluators: changedList(context, event) })) },
        "evaluator.deleted": { actions: assign(({ context, event }) => ({ evaluators: changedList(context, event) })) },
        // Moving to another evaluator settles the one being left: its draft is saved now,
        // so nothing typed is lost by moving on. Another book's evaluator is fetched first.
        "evaluator.selected": [
          {
            guard: ({ context, event }) => isPick(event) && event.book === context.book,
            target: ".editing",
            reenter: true,
            actions: [
              save,
              assign(({ context, event }) => ({ draft: opened(context, event.id, event.book) })),
              announce,
              ({ context, event }) => context.remember({ id: event.id, book: event.book }),
            ],
          },
          {
            guard: ({ event }) => isPick(event),
            target: "fetching",
            actions: [
              save,
              assign(({ event }) => ({ want: { id: event.id, book: event.book }, draft: null })),
              ({ context, event }) => context.remember({ id: event.id, book: event.book }),
            ],
          },
        ],
      },
    },
    failed: {},
  },
});
