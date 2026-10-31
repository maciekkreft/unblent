import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component for the Evaluators tab of the gear's sheet (12): every evaluator of
// the account, one under the other and fully open, the way the Generators tab shows its
// generators. Evaluators are settings, so there is no list to pick from and no switch:
// what checks what is chosen under the Jev key in the Settings tab. It owns only UI
// state — the evaluator being typed in as a draft, and whether that typing waits to be
// saved — and points at three facts: it asks evaluators: list for every evaluator and
// follows evaluator.changed / evaluator.deleted, asks settings: read for the "Vim keys"
// preference (12) and follows settings.changed, and asks session: read and follows
// session.changed (4.3, fourth rule). Every edit leaves as the whole evaluator,
// evaluator.saved, at a throttle while typing and at once on blur (4.3, third rule); a
// removal leaves as removal.started and `evaluators` marks the item until notice-stack
// settles or undoes it. The ask, the id minting and the throttle arrive through input, so
// the machine is a pure definition importable in Node.
//
// One evaluator is edited at a time, the one the user last touched: a gesture on another
// first saves what was typed in the one before, so nothing typed is lost by moving on.

// Evaluators belong to the account, but each is stored with a book (`evaluators`); a new
// one is stored with the Journal, under the fixed id `books` gives it.
export const JOURNAL = "00000000000000000000000JRN";

// The try page whose Evaluate box checks text with these evaluators (8).
export const TRY_PATH = "/try/evaluators";

const blankQuestion = (id) => ({ id, on: true, kind: "yesno", text: "", yes: "", no: "", options: [], removing: false });
const blankOption = (id) => ({ id, name: "", description: "", removing: false });

const live = (items) => items.filter((x) => !x.removing);

// The icons an option may be given for its mark on a choice point line (choice-point-cards).
export const OPTION_ICONS = ["footprints", "person-simple-walk", "brain", "heart", "trophy", "hand-palm", "question", "check", "warning", "gavel", "prohibit", "lightning", "calendar-blank", "share-fat", "trash-simple"];

// The answer a question expects, while it names one the question has: yes or no, or one of
// its options, kept whichever kind the question is, so switching kind and back brings it
// back; the choice shows it only for the kind it fits (`shownExpect`).
export const expectOf = (q) => (q.expect === "yes" || q.expect === "no" || q.options.some((o) => o.id === q.expect) ? q.expect : null);
export const shownExpect = (q) =>
  (q.kind === "pick" ? live(q.options).some((o) => o.id === q.expect) : q.expect === "yes" || q.expect === "no") ? q.expect : null;

// The draft as evaluator.saved carries it: no on/off for the evaluator, which this tab
// does not offer, and no marked item, which `evaluators` keeps by itself while its undo
// window runs.
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

// Nothing written anywhere in it: a New evaluator left empty adds nothing.
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

// An option can be removed only once its name and description are cleared, so one press on
// its x never takes written words away by accident.
export const removable = (option) => !option.name.trim() && !option.description.trim();

const known = (context, id) => context.evaluators.some((r) => r.id === id);

// The empty rule holds for an evaluator the fact has never had; a kept evaluator the user
// clears is still saved, so clearing it is kept. One built from another fact (Your values)
// is shown read only and never saved from here.
const savable = (context) =>
  context.draft && !context.draft.removing && !context.draft.derivedFrom && (known(context, context.draft.id) || !isEmpty(context.draft));

const copy = (r) =>
  structuredClone({
    id: r.id,
    book: r.book,
    name: r.name,
    description: typeof r.description === "string" ? r.description : "",
    questions: r.questions,
    removing: r.removing,
    ...(r.derivedFrom ? { derivedFrom: r.derivedFrom } : {}),
  });

// The order the user set (5): by the place `evaluators` gives each, a key compared as plain
// text, id as the tiebreak, the same order the fact answers in. One without a place sorts
// after the placed ones, oldest first.
const placeOf = (e) => (typeof e.position === "string" ? e.position : `z${e.id}V`);
const byPlace = (a, b) => {
  const pa = placeOf(a);
  const pb = placeOf(b);
  return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// What the tab shows, top to bottom: a New evaluator not saved yet first, then every
// evaluator not waiting out its undo window, each as the draft while it is the one being
// typed in, else as the fact has it.
export const shownOf = ({ evaluators, draft }) => {
  const kept = [...evaluators].filter((r) => !r.removing).sort(byPlace);
  const fresh = draft && !draft.removing && !evaluators.some((r) => r.id === draft.id) ? [draft] : [];
  return [...fresh, ...kept.map((r) => (draft && draft.id === r.id ? draft : copy(r)))].filter((d) => !d.removing);
};

// While typing waits to be saved, a change from the fact brings only its removal marks, so
// it never overwrites what is on screen.
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

// The evaluators after one change from the fact, and the draft with them: one the fact no
// longer has, though it had it, was deleted, so the draft goes with it.
const changed = (keepTyping) =>
  assign(({ context, event }) => {
    const evaluators =
      event.type === "evaluator.deleted"
        ? context.evaluators.filter((r) => r.id !== event.id)
        : [...context.evaluators.filter((r) => r.id !== event.evaluator.id), event.evaluator];
    const { draft } = context;
    if (!draft) return { evaluators };
    const record = evaluators.find((r) => r.id === draft.id);
    if (!record) return { evaluators, draft: known(context, draft.id) ? null : draft };
    return { evaluators, draft: keepTyping && !draft.removing && !record.derivedFrom ? merged(draft, record) : copy(record) };
  });

const save = enqueueActions(({ context, enqueue }) => {
  if (savable(context)) enqueue.emit({ type: "evaluator.saved", ...wire(context.draft) });
});

// A gesture names the evaluator it is on. On another than the draft, what was typed in the
// draft is saved first (while typing waits, `pending`), and that evaluator becomes the draft.
const take = (pending) =>
  enqueueActions(({ context, event, enqueue }) => {
    if (context.draft?.id === event.evaluator) return;
    if (pending && savable(context)) enqueue.emit({ type: "evaluator.saved", ...wire(context.draft) });
    const record = context.evaluators.find((r) => r.id === event.evaluator);
    enqueue.assign({ draft: record ? copy(record) : null });
  });

// A gesture may touch a shown evaluator, written by the user, not built from another fact.
const editable = (context, id) => {
  if (context.draft?.id === id) return !context.draft.removing && !context.draft.derivedFrom;
  const r = context.evaluators.find((x) => x.id === id);
  return Boolean(r && !r.removing && !r.derivedFrom);
};

// The draft as a gesture names it, after take: the record's copy when it was not the draft.
const draftFor = (context, id) => {
  if (context.draft?.id === id) return context.draft;
  const r = context.evaluators.find((x) => x.id === id);
  return r ? copy(r) : null;
};

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

// Pick one with no options to pick starts with two empty ones; switching keeps the yes / no
// wording and the options alike, so switching back loses nothing.
const kinded = (draft, id, kind, mint) => {
  const q = draft.questions.find((x) => x.id === id);
  return patchQuestion(draft, id, {
    kind,
    ...(kind === "pick" && !live(q.options).length ? { options: [...q.options, blankOption(mint()), blankOption(mint())] } : {}),
  });
};

const liveQuestion = (draft, id) => draft?.questions.find((q) => q.id === id && !q.removing);
const liveOption = (draft, question, id) => liveQuestion(draft, question)?.options.find((o) => o.id === id && !o.removing);

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

// A typing gesture: guarded on the evaluator and the item it names, then the draft taken
// and changed. The same in clean and dirty; only the target and whether a draft left waits
// to be saved differ.
const typing = (target, pending, guard, change) => ({
  guard: ({ context, event }) => editable(context, event.evaluator) && guard(draftFor(context, event.evaluator), event),
  target,
  actions: [take(pending), assign(({ context, event }) => ({ draft: change(context.draft, event, context) }))],
});

const edits = (target, pending) => ({
  _edit: typing(target, pending, () => true, (d, event) => ({ ...d, ...event.patch })),
  _editQuestion: typing(target, pending, (d, event) => !!liveQuestion(d, event.id), (d, event) => patchQuestion(d, event.id, event.patch)),
  _kind: typing(
    target,
    pending,
    (d, event) => (event.kind === "yesno" || event.kind === "pick") && liveQuestion(d, event.id)?.kind !== event.kind,
    (d, event, context) => kinded(d, event.id, event.kind, context.mint),
  ),
  _editOption: typing(target, pending, (d, event) => !!liveOption(d, event.question, event.id), (d, event) => patchOption(d, event.question, event.id, event.patch)),
  // A question switched off stays, editable, and is saved with the rest.
  _switchQuestion: typing(
    target,
    pending,
    (d, event) => typeof event.on === "boolean" && !!liveQuestion(d, event.id),
    (d, event) => patchQuestion(d, event.id, { on: event.on }),
  ),
  _addQuestion: typing(target, pending, () => true, (d, _event, context) => ({ ...d, questions: [...d.questions, blankQuestion(context.mint())] })),
  _addOption: typing(
    target,
    pending,
    (d, event) => !!liveQuestion(d, event.question),
    (d, event, context) => ({
      ...d,
      questions: d.questions.map((q) => (q.id === event.question ? { ...q, options: [...q.options, blankOption(context.mint())] } : q)),
    }),
  ),
});

// A removal first saves the draft as it stands, so `evaluators` holds the item it is about
// to mark; then the item is marked here too and the gesture leaves. In an evaluator never
// saved there is nothing to mark and nothing written to lose, so the item just goes.
const removal = (pending, kind, find, flagged, dropped) => ({
  guard: ({ context, event }) => editable(context, event.evaluator) && !!find(draftFor(context, event.evaluator), event),
  target: "clean",
  actions: [
    take(pending),
    enqueueActions(({ context, event, enqueue }) => {
      if (!savable(context)) {
        enqueue.assign({ draft: dropped(context.draft, event) });
        return;
      }
      enqueue.emit({ type: "evaluator.saved", ...wire(context.draft) });
      enqueue.assign({ draft: flagged(context.draft, event) });
      const item = find(context.draft, event);
      enqueue.emit({ type: "removal.started", kind, id: item.id, name: kind === "question" ? "" : item.name.trim() });
    }),
  ],
});

// The gestures saved at once, the same in clean and dirty (a draft left while typing
// waited is saved first).
const presses = (pending) => ({
  _removeQuestion: removal(
    pending,
    "question",
    (d, event) => liveQuestion(d, event.id),
    (d, event) => patchQuestion(d, event.id, { removing: true }),
    (d, event) => ({ ...d, questions: d.questions.filter((q) => q.id !== event.id) }),
  ),
  _removeOption: removal(
    pending,
    "option",
    (d, event) => {
      const option = liveOption(d, event.question, event.id);
      return option && removable(option) ? option : undefined;
    },
    (d, event) => patchOption(d, event.question, event.id, { removing: true }),
    (d, event) => ({
      ...d,
      questions: d.questions.map((q) => (q.id === event.question ? { ...q, options: q.options.filter((o) => o.id !== event.id) } : q)),
    }),
  ),
  // The expected answer is one choice, saved at once like the icon; None is null.
  _expect: {
    guard: ({ context, event }) => {
      if (!editable(context, event.evaluator)) return false;
      const q = liveQuestion(draftFor(context, event.evaluator), event.question);
      if (!q || shownExpect(q) === event.expect) return false;
      if (event.expect === null) return true;
      return q.kind === "pick" ? live(q.options).some((o) => o.id === event.expect) : event.expect === "yes" || event.expect === "no";
    },
    target: "clean",
    actions: [
      take(pending),
      assign(({ context, event }) => {
        const { expect: _, ...rest } = liveQuestion(context.draft, event.question);
        const next = event.expect === null ? rest : { ...rest, expect: event.expect };
        return { draft: { ...context.draft, questions: context.draft.questions.map((q) => (q.id === next.id ? next : q)) } };
      }),
      save,
    ],
  },
  // Choosing an icon is one press, saved at once; choosing again is its undo.
  _optionIcon: {
    guard: ({ context, event }) => {
      if (!editable(context, event.evaluator) || !(event.icon === null || OPTION_ICONS.includes(event.icon))) return false;
      const o = liveOption(draftFor(context, event.evaluator), event.question, event.id);
      return !!o && (o.icon ?? null) !== event.icon;
    },
    target: "clean",
    actions: [take(pending), assign(({ context, event }) => ({ draft: withIcon(context.draft, event.question, event.id, event.icon) })), save],
  },
  // Only an evaluator the fact holds can be deleted; a New evaluator with nothing in it
  // offers no Delete, because leaving it already keeps nothing.
  _delete: {
    guard: ({ context, event }) => editable(context, event.evaluator) && known(context, event.evaluator),
    target: "clean",
    actions: [
      take(pending),
      save,
      emit(({ context }) => ({ type: "removal.started", kind: "evaluator", id: context.draft.id, name: context.draft.name.trim() })),
      assign(({ context }) => ({ draft: { ...context.draft, removing: true } })),
    ],
  },
  // + New evaluator: an empty evaluator at the top, kept with the Journal, saved once
  // something is written in it. Pressed again while it is still empty, it stays the one.
  _new: {
    target: "clean",
    actions: enqueueActions(({ context, enqueue }) => {
      if (context.draft && !known(context, context.draft.id) && isEmpty(context.draft) && !context.draft.removing) return;
      if (pending && savable(context)) enqueue.emit({ type: "evaluator.saved", ...wire(context.draft) });
      enqueue.assign({
        draft: { id: context.mint(), book: JOURNAL, name: "", description: "", questions: [blankQuestion(context.mint())], removing: false },
        news: context.news + 1,
      });
    }),
  },
});

// --- The keyboard path (12, "Vim keys") ----------------------------------------------

const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

// What a key does on a stop of the tab that is not a text box: "down" or "up" to the next
// or previous stop, "first" or "last", "prev" or "next" to change a choice by one, "g" for
// the first g of gg, or null to leave the key alone. The arrows always move; with Vim keys
// on j, k, gg and G do too, never in a one-line field, where they are typed. A choice (a
// radio of Yes / no and Pick one, or a select) changes with the left and right arrows and,
// with Vim keys on, h and l, so its up and down arrows are the path's, not the choice's.
export function stopKey(e, { tag, type, vim, afterG = false }) {
  if (!plain(e)) return null;
  const arrow = { ArrowDown: "down", ArrowUp: "up" }[e.key];
  if (arrow) return arrow;
  const typing = tag === "INPUT" && type !== "checkbox" && type !== "radio";
  const choice = tag === "SELECT" || type === "radio";
  if (choice && tag === "SELECT" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return e.key === "ArrowRight" ? "next" : "prev";
  if (!vim || typing) return null;
  if (choice && (e.key === "h" || e.key === "l")) return e.key === "l" ? "next" : "prev";
  if (e.key === "g") return afterG ? "first" : "g";
  return { j: "down", k: "up", G: "last" }[e.key] ?? null;
}

// In a text box: j on its last line or k on its first in Vim's normal mode, and the down
// arrow on its last line or the up arrow on its first, leave it along the path. A count,
// an operator or a half-typed command keeps the key Vim's.
export function boxEdge(e, vim, line, lines, vimOn) {
  if (!plain(e)) return null;
  if (e.key === "ArrowDown" && line >= lines) return "down";
  if (e.key === "ArrowUp" && line <= 1) return "up";
  if (!vimOn || !vim || vim.insertMode || vim.visualMode) return null;
  const s = vim.inputState;
  if (s && (s.operator || s.keyBuffer?.length || s.prefixRepeat?.length || s.motionRepeat?.length)) return null;
  if (e.key === "j" && line >= lines) return "down";
  if (e.key === "k" && line <= 1) return "up";
  return null;
}

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the tab.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// The Mac app (3.4): its session picture carries `connect`. The try page shares evaluators
// with guests of the website, so the Mac does not link to it.
export const onMac = (reply) => Boolean(reply?.connect);

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
  id: "evaluator-settings",
  meta: {
    description:
      "The Evaluators tab of the gear's sheet, before Generators. At the top a link, Try " +
      "evaluators, opens the Evaluators try page in a new tab, where lines written in its " +
      "Evaluate box are checked by the evaluators switched on there; the Mac app has no " +
      "such link, since the try page shares evaluators with the website's guests. Under it, + New evaluator " +
      "adds an empty evaluator at the top, kept with the Journal and saved once something is " +
      "written in it. Then every evaluator of the account, one under the other, in the order " +
      "the user set: whichever book it " +
      "was once kept with, since evaluators belong to the account. There is no On tick box: " +
      "what checks what is chosen in the Settings tab under the Jev key, and the chat may use " +
      "any evaluator. Each evaluator has a heading with its name and a caret that folds and " +
      "unfolds it on its own: a press on the heading, or Enter while the keyboard is on it, " +
      "turns it. Folded, only the heading shows, and the keyboard's path passes it as one stop. " +
      "Which evaluators are folded is kept in this browser; every evaluator is open at first, " +
      "and a new evaluator starts open, since the user is about to write it. Open, an " +
      "evaluator shows its name, Description (what it checks, which the " +
      "chat reads to choose one), its questions and Delete evaluator. Each question has a tick " +
      "box that switches it on or off (one switched off is greyed but stays editable, kept " +
      "but not asked), Remove, Yes / no or Pick one, its text, Expected answer (None or one of " +
      "its answers, saved at once and kept across a switch of kind and back), and either what " +
      "yes and no mean or its options, each with a name, an optional description, an icon " +
      "button that opens a small panel of icons and No icon, and an x that removes it once its " +
      "words are cleared; Add an option and Add a question add one. Every edit is saved as the " +
      "whole evaluator a short time into typing and when the keyboard leaves it, and moving " +
      "to another evaluator saves the one left first. Removing a question or an option, and " +
      "deleting an evaluator, wait out the undo window with Undo in a notice, the item hidden " +
      "meanwhile. Your values, built from the user's values, is shown read only: its " +
      "questions and their answers as words, and a line saying to change the values in the " +
      "Values sheet. The multi-line fields are text boxes that grow with what is written and " +
      "take Vim's keys when Vim keys is on. The keyboard moves through the tab top to bottom: " +
      "the up and down arrows move from a link, a button, a tick box, a choice or a one-line " +
      "field to the one before or after, and from a text box's first or last line out of it; " +
      "with Vim keys on j and k do the same, never while typing in a one-line field, gg and G " +
      "go to the first and the last, and in a text box j on its last line and k on its first " +
      "move on in Vim's normal mode. A choice between Yes / no and Pick one, and Expected " +
      "answer, change with the left and right arrows, and with h and l with Vim keys on. " +
      "Signed out it shows only \"Sign in to use evaluators.\"",
    kind: "view",
    emits: ["evaluator.saved", "removal.started"],
    attributes: [],
    asks: ["evaluators: list", "settings: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 200,
    evaluators: [],
    // The evaluator being typed in, or null.
    draft: null,
    // How many times + New evaluator made one, so the view puts the keyboard in its name.
    news: 0,
    vimKeys: false,
    // The evaluators folded shut, by id. UI state the view keeps in localStorage (3.1) and
    // hands back through input, so the folds follow the browser.
    folded: new Set(input.folded ?? []),
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page runs in the Mac app (onMac).
    mac: false,
  }),
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
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output), mac: ({ event }) => onMac(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
  ],
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null, mac: ({ event }) => onMac(event) }) },
    // A press on an evaluator's heading, or Enter on it: fold it, or unfold it.
    _fold: {
      actions: assign({
        folded: ({ context, event }) => {
          const next = new Set(context.folded);
          if (next.has(event.id)) next.delete(event.id);
          else next.add(event.id);
          return next;
        },
      }),
    },
  },
  initial: "loading",
  states: {
    // A change the fact makes meanwhile is held for this ask and arrives once the reply has
    // landed (4.2).
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.evaluators),
            target: "ready",
            actions: assign({ evaluators: ({ event }) => event.output.evaluators }),
          },
          // The fact could not answer: an honest failure rather than an empty tab.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      initial: "clean",
      states: {
        clean: {
          on: {
            ...edits("dirty", false),
            ...presses(false),
            "evaluator.changed": { actions: changed(false) },
            "evaluator.deleted": { actions: changed(false) },
          },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        dirty: {
          on: {
            ...edits(undefined, true),
            ...presses(true),
            _blur: { target: "clean", actions: save },
            "evaluator.changed": { actions: changed(true) },
            "evaluator.deleted": { actions: changed(true) },
          },
          after: { throttle: { target: "clean", actions: save } },
        },
      },
    },
    failed: {},
  },
});
