import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that edits one evaluator (6.4): the item the Evaluators tab's
// list-then-item shows under its Back bar when evaluator.selected arrives. It owns only
// UI state — the evaluator being edited as a draft, and whether typing is waiting to be
// saved — and points at three facts: it asks evaluators: list for every evaluator of the
// account and follows evaluator.changed / evaluator.deleted after, asks settings: read
// for the "Vim keys" preference (12) and follows settings.changed, and asks session: read
// and follows session.changed (4.3, fourth rule). Every edit leaves as the whole evaluator,
// evaluator.saved, at a throttle while typing and at once on blur (4.3, third rule). A
// removed question or option leaves in a save without it, and a delete as
// evaluator.discarded; each is a step `evaluators` records, so Undo brings it back
// (12, Undo). Whenever the evaluator it shows changes, picked or opened
// by itself after a reload, it says which with evaluator.opened, so
// the list marks that row; it learns nothing back. The ask, the id minting and the throttle arrive through
// input, so the machine is a pure definition importable in Node.

const blankQuestion = (id) => ({ id, on: true, kind: "yesno", text: "", yes: "", no: "", options: [], removing: false });
const blankOption = (id) => ({ id, name: "", description: "", removing: false });

const live = (items) => items.filter((x) => !x.removing);

// The icons an option may be given for its mark on a choice point line (choice-point-cards).
export const OPTION_ICONS = ["footprints", "person-simple-walk", "brain", "heart", "trophy", "hand-palm", "question", "check", "warning", "gavel", "prohibit", "lightning", "calendar-blank", "share-fat", "trash-simple"];

// The answer a question expects, while it names one the question has: yes or no, or one of
// its options. An option waiting out its undo window still counts, so the expectation is
// saved with it and comes back with Undo; `evaluators` drops it once the removal settles.
// It is kept whichever kind the question is, as the options are, so switching kind and back
// brings it back; the choice shows it only for the kind it fits (`shownExpect`).
export const expectOf = (q) => (q.expect === "yes" || q.expect === "no" || q.options.some((o) => o.id === q.expect) ? q.expect : null);
export const shownExpect = (q) =>
  (q.kind === "pick" ? live(q.options).some((o) => o.id === q.expect) : q.expect === "yes" || q.expect === "no") ? q.expect : null;

// The draft as evaluator.saved carries it, with each question's switch: no on/off for the evaluator, which evaluator-list owns as a gesture, and no marked item, which `evaluators` keeps in place by itself while its
// undo window runs.
export const wire = (d) => ({
  id: d.id,
  book: d.book,
  name: d.name,
  // Always sent, so clearing the box is kept rather than read as "keep the one it has".
  description: d.description ?? "",
  questions: live(d.questions).map((q) => ({
    id: q.id,
    on: q.on !== false,
    kind: q.kind,
    text: q.text,
    yes: q.yes,
    no: q.no,
    options: live(q.options).map((o) => ({ id: o.id, name: o.name, description: o.description, ...(o.icon ? { icon: o.icon } : {}) })),
    ...(expectOf(q) ? { expect: q.expect } : {}),
  })),
});

// Nothing written anywhere in it: a New evaluator opened and left adds no row to the list.
export const isEmpty = (d) =>
  !d.name.trim() &&
  !(d.description ?? "").trim() &&
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
// An evaluator built from another fact (Your values, from the values) is shown read only:
// nothing of it is saved from here, and it cannot be deleted.
const savable = (context) =>
  context.draft && !context.draft.removing && !context.draft.derivedFrom && (known(context, context.draft.id) || !isEmpty(context.draft));

const copy = (r) =>
  structuredClone({ id: r.id, book: r.book, name: r.name, description: typeof r.description === "string" ? r.description : "", questions: r.questions, removing: r.removing, ...(r.derivedFrom ? { derivedFrom: r.derivedFrom } : {}) });

const opened = (context, id, book) => {
  const found = context.evaluators.find((r) => r.id === id);
  return found ? copy(found) : { id, book, name: "", description: "", questions: [blankQuestion(context.mint())], removing: false };
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
  return keepTyping && !draft.removing && !record.derivedFrom ? merged(draft, record) : copy(record);
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

// An option can be removed only once its name and description are cleared, so one press on
// its x never takes written words away by accident.
export const removable = (option) => !option.name.trim() && !option.description.trim();

// An option's icon, or null for none: an option with no icon carries no `icon` at all.
const withIcon = (draft, question, id, chosen) => ({
  ...draft,
  questions: draft.questions.map((q) =>
    q.id === question
      ? {
          ...q,
          options: q.options.map((o) => {
            if (o.id !== id) return o;
            const { icon: _, ...rest } = o;
            return chosen ? { ...rest, icon: chosen } : rest;
          }),
        }
      : q,
  ),
});

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
  // A question switched off stays in the draft, editable, and is saved with the rest;
  // ticking it again brings it back as it was.
  _switchQuestion: {
    guard: ({ context, event }) => typeof event.on === "boolean" && !!liveQuestion(context, event.id),
    target,
    actions: assign(({ context, event }) => ({ draft: patchQuestion(context.draft, event.id, { on: event.on }) })),
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

// A removal first saves what was typed as it stands, so the typing keeps its own step,
// then saves the draft without the item, a step of its own (12, Undo). In an evaluator
// that was never saved there is nothing written to lose, so the item just goes.
const removal = (find, dropped) => ({
  guard: ({ context, event }) => !context.draft.derivedFrom && !!find(context, event),
  target: ".clean",
  actions: enqueueActions(({ context, event, enqueue }) => {
    const draft = dropped(context.draft, event);
    if (savable(context)) {
      enqueue.emit({ type: "evaluator.saved", ...wire(context.draft) });
      enqueue.emit({ type: "evaluator.saved", ...wire(draft) });
    }
    enqueue.assign({ draft });
  }),
});

const isPick = (event) => typeof event.id === "string" && typeof event.book === "string";

// The list marks the row the editor shows, and the editor opens an evaluator by itself, so
// it says so each time the id shown changes. Not while fetching: the list keeps its mark
// until the next evaluator is on screen.
const announce = enqueueActions(({ context, enqueue }) => {
  const id = context.draft?.id ?? null;
  if (id === context.announced) return;
  enqueue.assign({ announced: id });
  enqueue.emit({ type: "evaluator.opened", id });
});

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the evaluator.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the editor shows of the account: "wait" until session answers, "sign-in" signed
// out, since list-then-item keeps its item shown across a reload and the evaluator open
// then is the account's (3.4), "show" otherwise. On a try page a visitor not yet a guest
// edits the starters, which are their own copies (8).
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("evaluators", "list", {})),
    // The "Vim keys" device preference (12); on a page without a settings fact the ask
    // replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "evaluator-editor",
  meta: {
    description:
      "Edits one evaluator, the item of the Evaluators tab: its name, its description and its questions. " +
        "Directly under the name, Description is a small text box saying what the evaluator checks, " +
        "which the chat reads to choose an evaluator; it is saved with the evaluator like every other field. Each " +
      "question has a tick box that switches it on or off: one switched off is greyed but stays " +
      "editable and is kept, but not asked, and ticking it again brings it back; a new question " +
      "starts switched on. Each question is Yes / no, with optional words for what yes and no mean, or Pick one, with " +
      "options that each have a name, an optional description and an optional icon. Under " +
      "each question's text, Expected answer offers None and the question's answers (Yes and " +
      "No, or its options by name), saved at once and kept across a switch of kind and back; removing the expected option takes the " +
      "expectation with it, and Undo brings both back. A choice point mark is green when Jev " +
      "gives the expected answer and red when not. The icon " +
      "button after an option's name, a dashed square while it has none, opens a small panel " +
      "of icons and No icon; choosing one saves it at once and closes the panel, and Escape or " +
      "a press outside closes it unchanged. The icon is what the option's mark shows on a " +
      "choice point line. Every edit is saved as the " +
      "whole evaluator a short time into typing and when a field loses focus, and a new " +
      "evaluator with nothing written in it is never saved; a new one is kept with the Journal, since evaluators belong to the account. Removing a question or an option " +
      "happens at once, and so does deleting the evaluator, with the short notice and its Undo; " +
      "Undo and Redo take back each of them, as they do an edit (section 12). The " +
      "evaluator open before a reload opens again while it is still kept. The question, what yes " +
      "and no mean and each option's description are text boxes that grow with what is written " +
      "and take Vim's keys when Vim keys is on, where p pastes text or a link copied in the reader with Vim keys, paragraphs kept; the name and the option names are one-line fields. " +
      "A press on a button or a choice keeps the keyboard there, and the editor's focus comes " +
      "back to the field last used, never jumping to the name, except that an evaluator just " +
      "picked in the list (with Enter, a click, or cc with Vim keys on) starts with the keyboard " +
      "in its name. Whichever evaluator it opens, " +
      "picked or opened by itself after a reload, the list beside it marks. Signed out it shows no evaluator, " +
      "only \"Sign in to run evaluators.\", as the list beside it does, and signing in shows " +
      "it again without a reload; on a try page a visitor not yet signed in edits the starters. Your values, which is built from the user's values, opens read only: its name, its fixed description, and each question with its answers and what each means, Serves marked expected, as words with nothing to type in, no Delete, and a line saying to change the values in the Values sheet, under the day's text in the Journal; with no values it says there is nothing to ask.",
    kind: "view",
    emits: ["evaluator.saved", "evaluator.discarded", "evaluator.opened"],
    attributes: [],
    asks: ["evaluators: list", "settings: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Puts text copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    // How many times the user picked an evaluator in the list (evaluator.selected), so the
    // view knows a pick from a return of the keyboard: a pick starts in the name.
    picks: 0,
    // Every evaluator of the account.
    evaluators: [],
    draft: null,
    // The id last told to the list with evaluator.opened.
    announced: null,
    // The pick being fetched: { id, book }, and `restore` for the evaluator open before a
    // reload, kept on this device (3.1) because list-then-item keeps its item shown; it
    // is reopened only while that evaluator still exists.
    want: isPick(input.open ?? {}) ? { id: input.open.id, book: input.open.book, restore: true } : null,
    remember: input.remember ?? (() => {}),
    vimKeys: false,
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
  }),
  // Beside the states, so the preference and the session arrive whatever the editor is
  // doing; a settings.changed or session.changed that races its ask is held until the
  // reply lands (supersededBy).
  invoke: [
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
  on: {
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, blocks a blank line apart as paragraphs are.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null }) },
  },
  initial: "starting",
  states: {
    starting: {
      always: { target: "fetching" },
    },
    // The evaluators are asked for; a change the fact makes meanwhile is held for this ask
    // and arrives once the reply has landed (4.2).
    fetching: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ context, event }) =>
              Array.isArray(event.output?.evaluators) &&
              context.want != null &&
              (!context.want.restore || event.output.evaluators.some((r) => r.id === context.want.id && !r.removing)),
            target: "ready.editing",
            actions: [
              assign(({ context, event }) => ({
                evaluators: event.output.evaluators,
                draft: opened({ ...context, evaluators: event.output.evaluators }, context.want.id, context.want.book),
                want: null,
              })),
              announce,
            ],
          },
          {
            guard: ({ event }) => Array.isArray(event.output?.evaluators),
            target: "ready",
            actions: [assign(({ event }) => ({ evaluators: event.output.evaluators, want: null })), announce],
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
            assign(({ context, event }) => ({ want: { id: event.id, book: event.book }, picks: context.picks + 1 })),
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
              (context, event) => liveQuestion(context, event.id),
              (d, event) => ({ ...d, questions: d.questions.filter((q) => q.id !== event.id) }),
            ),
            _removeOption: removal(
              (context, event) => {
                const option = liveOption(context, event.question, event.id);
                return option && removable(option) ? option : undefined;
              },
              (d, event) => ({
                ...d,
                questions: d.questions.map((q) => (q.id === event.question ? { ...q, options: q.options.filter((o) => o.id !== event.id) } : q)),
              }),
            ),
            // The expected answer is one choice, saved at once like the icon; None is null.
            _expect: {
              guard: ({ context, event }) => {
                const q = liveQuestion(context, event.question);
                if (!q || shownExpect(q) === event.expect) return false;
                if (event.expect === null) return true;
                return q.kind === "pick" ? live(q.options).some((o) => o.id === event.expect) : event.expect === "yes" || event.expect === "no";
              },
              target: ".clean",
              actions: [
                assign(({ context, event }) => {
                  const { expect: _, ...rest } = liveQuestion(context, event.question);
                  const next = event.expect === null ? rest : { ...rest, expect: event.expect };
                  return { draft: { ...context.draft, questions: context.draft.questions.map((q) => (q.id === next.id ? next : q)) } };
                }),
                save,
              ],
            },
            // Choosing an icon is one press, so it is saved at once with whatever was typed;
            // choosing again is its undo.
            _optionIcon: {
              guard: ({ context, event }) =>
                (event.icon === null || OPTION_ICONS.includes(event.icon)) &&
                !!liveOption(context, event.question, event.id) &&
                (liveOption(context, event.question, event.id).icon ?? null) !== event.icon,
              target: ".clean",
              actions: [assign(({ context, event }) => ({ draft: withIcon(context.draft, event.question, event.id, event.icon) })), save],
            },
            // Only an evaluator the fact holds can be deleted; a New evaluator with nothing
            // in it offers no Delete, because leaving it already keeps nothing. It goes at
            // once, with the short notice and its Undo (12, Undo).
            _delete: {
              guard: ({ context }) => !context.draft.removing && !context.draft.derivedFrom && known(context, context.draft.id),
              target: ".clean",
              actions: [
                save,
                assign(({ context }) => ({ draft: { ...context.draft, removing: true } })),
                emit(({ context }) => ({ type: "evaluator.discarded", id: context.draft.id })),
              ],
            },
          },
        },
      },
      on: {
        "evaluator.changed": { actions: assign(({ context, event }) => ({ evaluators: changedList(context, event) })) },
        "evaluator.deleted": { actions: assign(({ context, event }) => ({ evaluators: changedList(context, event) })) },
        // Moving to another evaluator settles the one being left: its draft is saved now,
        // so nothing typed is lost by moving on.
        "evaluator.selected": {
          guard: ({ event }) => isPick(event),
          target: ".editing",
          reenter: true,
          actions: [
            save,
            assign(({ context, event }) => ({ draft: opened(context, event.id, event.book), picks: context.picks + 1 })),
            announce,
            ({ context, event }) => context.remember({ id: event.id, book: event.book }),
          ],
        },
      },
    },
    failed: {},
  },
});
