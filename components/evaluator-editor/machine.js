import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that edits one evaluator (6.4): the item the Evaluators tab's
// list-then-item shows under its Back bar when evaluator.selected arrives. It owns only
// UI state — the evaluator being edited as a draft, the book it is kept with, and
// whether typing is waiting to be saved — and points at two facts: it asks
// evaluators: list for the book evaluator.selected names and follows evaluator.changed /
// evaluator.deleted after, and asks settings: read for the "Vim keys" preference (12)
// and follows settings.changed (4.3, fourth rule). Every edit leaves as the whole evaluator,
// evaluator.saved, at a throttle while typing and at once on blur (4.3, third rule). A
// removal leaves as removal.started; `evaluators` marks the item until notice-stack
// settles or undoes it, and the draft follows those marks, so the item disappears at
// once and comes back on Undo. The ask, the id minting and the throttle arrive through
// input, so the machine is a pure definition importable in Node.

const blankQuestion = (id) => ({ id, kind: "yesno", text: "", yes: "", no: "", options: [], removing: false });
const blankOption = (id) => ({ id, name: "", description: "", removing: false });

const live = (items) => items.filter((x) => !x.removing);

// The draft as evaluator.saved carries it: no on/off, which evaluator-list owns as a
// gesture, and no marked item, which `evaluators` keeps in place by itself while its
// undo window runs.
export const wire = (d) => ({
  id: d.id,
  book: d.book,
  name: d.name,
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

const copy = (r) => structuredClone({ id: r.id, book: r.book, name: r.name, questions: r.questions, removing: r.removing });

const opened = (context, id, book) => {
  const found = context.evaluators.find((r) => r.id === id);
  return found ? copy(found) : { id, book, name: "", questions: [blankQuestion(context.mint())], removing: false };
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

// The book's evaluators after one change from the fact; another book's change leaves
// them as they are.
const changedList = (context, event) => {
  if (event.type === "evaluator.deleted") return context.evaluators.filter((r) => r.id !== event.id);
  if (event.evaluator.book !== context.book) return context.evaluators;
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

const isPick = (event) => typeof event.id === "string" && typeof event.book === "string";

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("evaluators", "list", { book: input.book })),
    // The "Vim keys" device preference (12); on a page without a settings fact the ask
    // replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "evaluator-editor",
  meta: {
    description:
      "Edits one evaluator, the item of the Evaluators tab: its name and its questions. Each " +
      "question is Yes / no, with optional words for what yes and no mean, or Pick one, with " +
      "options that each have a name and an optional description. Every edit is saved as the " +
      "whole evaluator a short time into typing and when a field loses focus, and a new " +
      "evaluator with nothing written in it is never saved. Removing a question or an option, " +
      "and deleting the evaluator, wait out the undo window, with Undo in a notice. The " +
      "evaluator open before a reload opens again while it is still kept. The question, what yes " +
      "and no mean and each option's description are text boxes that grow with what is written " +
      "and take Vim's keys when Vim keys is on; the name and the option names are one-line fields. " +
      "A press on a button or a choice keeps the keyboard there, and the editor's focus comes " +
      "back to the field last used, never jumping to the name.",
    kind: "view",
    emits: ["evaluator.saved", "removal.started"],
    attributes: [],
    asks: ["evaluators: list", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    // The book whose evaluators are held, and those evaluators.
    book: null,
    evaluators: [],
    draft: null,
    // The pick being fetched: { id, book }, and `restore` for the evaluator open before a
    // reload, kept on this device (3.1) because list-then-item keeps its item shown; it
    // is reopened only while that evaluator still exists.
    want: isPick(input.open ?? {}) ? { id: input.open.id, book: input.open.book, restore: true } : null,
    remember: input.remember ?? (() => {}),
    vimKeys: false,
  }),
  // Beside the states, so the preference arrives whatever the editor is doing; a
  // settings.changed that races it is held until the reply lands (settings: read
  // supersededBy).
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    onError: { actions: [] },
  },
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
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
            actions: assign(({ context, event }) => {
              const next = { ...context, book: context.want.book, evaluators: event.output.evaluators };
              return { book: next.book, evaluators: next.evaluators, draft: opened(next, context.want.id, context.want.book), want: null };
            }),
          },
          {
            guard: ({ event }) => Array.isArray(event.output?.evaluators),
            target: "ready",
            actions: assign(({ context, event }) => ({ book: context.want.book, evaluators: event.output.evaluators, want: null })),
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
