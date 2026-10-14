import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that edits one of the journal's detectors (6.4): the item the
// Detectors dock's inner list-then-item shows under its Back bar when detector.selected
// arrives. It owns only UI state — the detector being edited
// as a draft, and whether typing is waiting to be saved — and points at one fact: it asks
// journal: read for the starting picture and follows journal.changed after (4.3, fourth
// rule). Every edit leaves as the whole detector, detector.saved, at a throttle while
// typing and at once on blur (4.3, third rule). A removal leaves as removal.started (a
// detector is a "rubric" in that vocabulary); `journal` flags the item until notice-stack
// settles or undoes it, and the draft follows those flags, so the item disappears at once
// and comes back on Undo. The ask, the id minting and the throttle arrive through input,
// so the machine is a pure definition importable in Node.

const blankQuestion = (id) => ({ id, kind: "yesno", text: "", yes: "", no: "", options: [], removing: false });
const blankOption = (id) => ({ id, name: "", description: "", removing: false });

const live = (items) => items.filter((x) => !x.removing);

// The draft as detector.saved carries it: no on/off, which detector-list owns as a gesture,
// and no flagged item, which `journal` keeps in place by itself while its undo window runs.
export const wire = (d) => ({
  id: d.id,
  project: d.project,
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

// Nothing written anywhere in it: a New detector opened and left adds no row to the list.
export const isEmpty = (d) =>
  !d.name.trim() &&
  d.questions.every(
    (q) => !q.text.trim() && !q.yes.trim() && !q.no.trim() && q.options.every((o) => !o.name.trim() && !o.description.trim()),
  );

// Jev tells options apart by name, so two live options of one question named alike are
// worth a note while the user writes.
export const duplicateNames = (q) => {
  const names = live(q.options).map((o) => o.name.trim().toLowerCase()).filter(Boolean);
  return new Set(names).size < names.length;
};

const known = (context, id) => context.detectors.some((r) => r.id === id);

// The empty rule holds for a detector `journal` has never had; a stored detector the user
// clears is still saved, so clearing it is kept.
const savable = (context) => context.draft && !context.draft.removing && (known(context, context.draft.id) || !isEmpty(context.draft));

const copy = (r) => structuredClone({ id: r.id, project: r.project, name: r.name, questions: r.questions, removing: r.removing });

// A new detector belongs to the project detector.selected named.
const opened = (context, id, project) => {
  const found = context.detectors.find((r) => r.id === id);
  return found ? copy(found) : { id, project, name: "", questions: [blankQuestion(context.mint())], removing: false };
};

// While typing waits to be saved, a change from the fact brings only its removal flags,
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

// The draft after journal.changed. A detector the fact no longer has, though it had it,
// was deleted (here and settled, or elsewhere): the editor says so.
const followed = (context, detectors, keepTyping) => {
  const { draft } = context;
  const record = detectors.find((r) => r.id === draft.id);
  if (!record) return known(context, draft.id) || draft.removing ? { ...draft, removing: true } : draft;
  return keepTyping && !draft.removing ? merged(draft, record) : copy(record);
};

const save = enqueueActions(({ context, enqueue }) => {
  if (savable(context)) enqueue.emit({ type: "detector.saved", ...wire(context.draft) });
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

// A removal first saves the draft as it stands, so `journal` holds the item it is about
// to flag; then the item is flagged here too and the gesture leaves. In a detector that
// was never saved there is nothing to flag and nothing written to lose, so the item just
// goes.
const removal = (kind, find, flagged, dropped) => ({
  guard: ({ context, event }) => !!find(context, event),
  target: ".clean",
  actions: enqueueActions(({ context, event, enqueue }) => {
    if (!savable(context)) {
      enqueue.assign(() => ({ draft: dropped(context.draft, event) }));
      return;
    }
    enqueue.emit({ type: "detector.saved", ...wire(context.draft) });
    enqueue.assign(() => ({ draft: flagged(context.draft, event) }));
    const item = find(context, event);
    enqueue.emit({ type: "removal.started", kind, id: item.id, name: kind === "question" ? "" : item.name.trim() });
  }),
});

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "detector-editor",
  meta: {
    description:
      "Edits one of the journal's detectors, the third level of the Detectors dock: its name and " +
      "its questions. Each question is Yes / no, with " +
      "optional words for what yes and no mean, or Pick one, with options that each have a name " +
      "and an optional description. Every edit is saved as the whole detector a short time into " +
      "typing and when a field loses focus, and a new detector with nothing written in it is " +
      "never saved. Rewording a question re-reads today's entry; earlier days keep their " +
      "answers. Removing a question or an option, and deleting the detector, wait out the undo " +
      "window, with Undo in a notice.",
    kind: "view",
    emits: ["detector.saved", "removal.started"],
    attributes: [],
    asks: ["journal: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    detectors: [],
    draft: null,
    // A pick that arrived before the starting picture, as detector.selected carries it;
    // opened once the picture lands.
    want: null,
    // The detector open before a reload, kept on this device (3.1) because list-then-item
    // keeps its item shown; reopened only while that detector still exists.
    open: input.open ?? null,
    remember: input.remember ?? (() => {}),
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ context, event }) =>
              Array.isArray(event.output?.detectors) &&
              (context.want != null || event.output.detectors.some((r) => r.id === context.open && !r.removing)),
            target: "ready.editing",
            actions: assign(({ context, event }) => {
              const detectors = event.output.detectors;
              const pick = context.want ?? { id: context.open, project: null };
              return { detectors, draft: opened({ ...context, detectors }, pick.id, pick.project), want: null };
            }),
          },
          {
            guard: ({ event }) => Array.isArray(event.output?.detectors),
            target: "ready",
            actions: assign(({ event }) => ({ detectors: event.output.detectors })),
          },
          // The fact could not answer: an honest failure rather than an empty editor.
          { target: "failed" },
        ],
        onError: "failed",
      },
      on: { "detector.selected": { actions: assign(({ event }) => ({ want: { id: event.id, project: event.project } })) } },
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
                "journal.changed": {
                  actions: assign(({ context, event }) => ({ draft: followed(context, event.detectors, false), detectors: event.detectors })),
                },
              },
            },
            // Typing within the window joins the one save at its end: a throttle, not a
            // debounce, so the targetless edits below never restart the timer.
            dirty: {
              on: {
                ...edits(undefined),
                _blur: { target: "clean", actions: save },
                "journal.changed": {
                  actions: assign(({ context, event }) => ({ draft: followed(context, event.detectors, true), detectors: event.detectors })),
                },
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
            // Only a detector the fact holds can be deleted; a New detector with nothing in
            // it offers no Delete, because leaving it already keeps nothing.
            _delete: {
              guard: ({ context }) => !context.draft.removing && known(context, context.draft.id),
              target: ".clean",
              actions: [
                save,
                assign(({ context }) => ({ draft: { ...context.draft, removing: true } })),
                emit(({ context }) => ({ type: "removal.started", kind: "rubric", id: context.draft.id, name: context.draft.name.trim() })),
              ],
            },
          },
        },
      },
      on: {
        "journal.changed": { actions: assign(({ event }) => ({ detectors: event.detectors })) },
        // Moving to another detector settles the one being left: its draft is saved now,
        // so nothing typed is lost by moving on.
        "detector.selected": {
          target: ".editing",
          reenter: true,
          actions: [
            save,
            assign(({ context, event }) => ({ draft: opened(context, event.id, event.project), open: event.id })),
            ({ context, event }) => context.remember(event.id),
          ],
        },
      },
    },
    failed: {},
  },
});
