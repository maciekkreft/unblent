import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that edits one Judge tool (6.4): the item list-then-item shows under
// its Back bar when rubric.selected arrives. It owns only UI state — the tool being edited
// as a draft, and whether typing is waiting to be saved — and points at two facts: it asks
// projects: read and rubrics: read for the starting picture and follows their .changed
// events after (4.3, fourth rule). Every edit leaves as the whole tool, rubric.saved, at a
// throttle while typing and at once on blur, as note-editor does (4.3, third rule). A
// removal leaves as removal.started; `rubrics` flags the item until notice-stack settles
// or undoes it, and the draft follows those flags, so the item disappears at once and
// comes back on Undo. The ask, the id minting and the throttle arrive through input, so
// the machine is a pure definition importable in Node.

const blankQuestion = (id) => ({ id, kind: "yesno", text: "", yes: "", no: "", options: [], removing: false });
const blankOption = (id) => ({ id, name: "", description: "", removing: false });

const live = (items) => items.filter((x) => !x.removing);

// The draft as rubric.saved carries it: no on/off, which rubric-list owns as a gesture, and
// no flagged item, which `rubrics` keeps in place by itself while its undo window runs.
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

// Nothing written anywhere in it: a New tool opened and left adds no row to the list.
export const isEmpty = (d) =>
  !d.name.trim() &&
  d.questions.every(
    (q) => !q.text.trim() && !q.yes.trim() && !q.no.trim() && q.options.every((o) => !o.name.trim() && !o.description.trim()),
  );

// Jev tells options apart by name (decisions), so two live options of one question named
// alike are worth a note while the user writes.
export const duplicateNames = (q) => {
  const names = live(q.options).map((o) => o.name.trim().toLowerCase()).filter(Boolean);
  return new Set(names).size < names.length;
};

const known = (context, id) => context.rubrics.some((r) => r.id === id);

// The empty rule holds for a tool `rubrics` has never had; a stored tool the user clears
// is still saved, so clearing it is kept.
const savable = (context) => context.draft && !context.draft.removing && (known(context, context.draft.id) || !isEmpty(context.draft));

const copy = (r) => structuredClone({ id: r.id, project: r.project, name: r.name, questions: r.questions, removing: r.removing });

const opened = (context, id) => {
  const found = context.rubrics.find((r) => r.id === id);
  return found ? copy(found) : { id, project: context.current, name: "", questions: [blankQuestion(context.mint())], removing: false };
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

// The draft after rubric.changed. A tool the fact no longer has, though it had it, was
// deleted (here and settled, or elsewhere): the editor says so.
const followed = (context, rubrics, keepTyping) => {
  const { draft } = context;
  const record = rubrics.find((r) => r.id === draft.id);
  if (!record) return known(context, draft.id) || draft.removing ? { ...draft, removing: true } : draft;
  return keepTyping && !draft.removing ? merged(draft, record) : copy(record);
};

const save = enqueueActions(({ context, enqueue }) => {
  if (savable(context)) enqueue.emit({ type: "rubric.saved", ...wire(context.draft) });
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

// A removal first saves the draft as it stands, so `rubrics` holds the item it is about
// to flag; then the item is flagged here too and the gesture leaves. In a tool that was
// never saved there is nothing to flag and nothing written to lose, so the item just goes.
const removal = (kind, find, flagged, dropped) => ({
  guard: ({ context, event }) => !!find(context, event),
  target: ".clean",
  actions: enqueueActions(({ context, event, enqueue }) => {
    if (!savable(context)) {
      enqueue.assign(() => ({ draft: dropped(context.draft, event) }));
      return;
    }
    enqueue.emit({ type: "rubric.saved", ...wire(context.draft) });
    enqueue.assign(() => ({ draft: flagged(context.draft, event) }));
    const item = find(context, event);
    enqueue.emit({ type: "removal.started", kind, id: item.id, name: kind === "question" ? "" : item.name.trim() });
  }),
});

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => Promise.all([input.ask("projects", "read", {}), input.ask("rubrics", "read", {})])),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "rubric-editor",
  meta: {
    description:
      "Edits one detector, the item list-then-item shows under its Back bar: its name and its " +
      "questions. Each question chooses its kind, Yes / no or Pick one. A yes / no question has " +
      "optional words for what yes means and what no means; a pick-one question has options, " +
      "each a name and an optional description, starting with two empty ones. Every edit is " +
      "saved as the whole detector a short time into typing, when a field loses focus and before " +
      "another detector opens, and a new detector with nothing written in it is never saved. Two options " +
      "of one question with the same name get a short note, because Jev tells options apart by " +
      "name. Removing a question or an option, and deleting " +
      "the detector, wait out the undo window, with Undo in a notice.",
    kind: "view",
    emits: ["rubric.saved", "removal.started"],
    attributes: [],
    asks: ["projects: read", "rubrics: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    current: null,
    rubrics: [],
    draft: null,
    // A pick that arrived before the starting picture; opened once it lands.
    want: null,
    // The tool open before a reload, kept on this device (3.1) because list-then-item
    // keeps its item shown; reopened only while that tool still exists.
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
            guard: ({ event }) => typeof event.output[0]?.current === "string" && Array.isArray(event.output[1]?.rubrics),
            target: "ready.editing",
            actions: assign(({ context, event }) => {
              const [p, r] = event.output;
              const next = { ...context, current: p.current, rubrics: r.rubrics };
              return { current: p.current, rubrics: r.rubrics, draft: opened(next, context.want ?? context.open), want: null };
            }),
            guard: ({ context, event }) =>
              typeof event.output[0]?.current === "string" &&
              Array.isArray(event.output[1]?.rubrics) &&
              (context.want != null || event.output[1].rubrics.some((r) => r.id === context.open && !r.removing)),
          },
          {
            guard: ({ event }) => typeof event.output[0]?.current === "string" && Array.isArray(event.output[1]?.rubrics),
            target: "ready",
            actions: assign(({ event }) => ({ current: event.output[0].current, rubrics: event.output[1].rubrics })),
          },
          // A fact could not answer: an honest failure rather than an empty editor.
          { target: "failed" },
        ],
        onError: "failed",
      },
      on: { "rubric.selected": { actions: assign(({ event }) => ({ want: event.id })) } },
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
                "rubric.changed": {
                  actions: assign(({ context, event }) => ({ draft: followed(context, event.rubrics, false), rubrics: event.rubrics })),
                },
              },
            },
            // Typing within the window joins the one save at its end: a throttle, not a
            // debounce, so the targetless edits below never restart the timer.
            dirty: {
              on: {
                ...edits(undefined),
                _blur: { target: "clean", actions: save },
                "rubric.changed": {
                  actions: assign(({ context, event }) => ({ draft: followed(context, event.rubrics, true), rubrics: event.rubrics })),
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
            // Only a tool the fact holds can be deleted; a New tool with nothing in it
            // offers no Delete, because leaving it already keeps nothing.
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
        "rubric.changed": { actions: assign(({ event }) => ({ rubrics: event.rubrics })) },
        // Moving to another tool settles the one being left: its draft is saved now, so
        // nothing typed is lost by moving on.
        "rubric.selected": {
          target: ".editing",
          reenter: true,
          actions: [
            save,
            assign(({ context, event }) => ({ draft: opened(context, event.id), open: event.id })),
            ({ context, event }) => context.remember(event.id),
          ],
        },
        // Another project shows other tools: the one open here is settled and closed.
        "project.changed": [
          {
            guard: ({ context, event }) => !!context.draft && context.draft.project !== event.current,
            target: ".choosing",
            actions: [save, assign(({ event }) => ({ current: event.current, draft: null }))],
          },
          { actions: assign(({ event }) => ({ current: event.current })) },
        ],
      },
    },
    failed: {},
  },
});
