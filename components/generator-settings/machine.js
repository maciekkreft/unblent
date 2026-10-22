import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The view component of the Generators tab (3.1): a child of `settings-tabs` labelled
// Generators. It owns only UI state — what is typed in a name or a prompt and not yet
// saved, and whether Run was just pressed — and points at four facts: it asks
// generators: list and follows generator.changed, llm: read for the models the account
// offers and follows llm.changed, session: read for who the account is and follows
// session.changed, and settings: read for the "Vim keys" preference (12) and follows
// settings.changed (4.3, fourth rule). Every gesture leaves as an event (4.3, fifth
// rule): generator.edited with only the fields changed, typing at a throttle and at once
// on blur as the other editors save, and generation.requested for Run. The ask and the
// clock arrive through input, so the machine is a pure definition importable in Node.

export const IDS = ["chat-title", "journal-summary"];
const TYPED = ["name", "prompt"];

// What Run does for each generator, in the words the user sees on its row and after
// pressing it.
export const RUN = {
  "chat-title": { label: "Run on the open chat", asked: "Asked for a new title for the open chat." },
  "journal-summary": { label: "Run on the picked journal entry", asked: "Asked for a new summary of the picked journal entry." },
};

// Signed in with a passkey: a guest or nobody runs no generator (3.4), so the tab asks
// them to sign in. A reply without a userId (no `session` on the page) counts as signed
// in, so a page that cannot tell never hides the generators.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null && reply.guest !== true : true);

// A generator as the tab shows it: the fact's copy with what is typed and not yet saved
// over it, so a change from the fact never overwrites what is on screen.
export const shown = (context, id) => {
  const record = context.generators?.find((g) => g.id === id);
  return record ? { ...record, ...(context.pending[id] ?? {}) } : null;
};

// The fields of a pending edit that differ from the fact's copy: what generator.edited
// carries (only the fields changed).
export const changed = (record, pending = {}) =>
  Object.fromEntries(TYPED.filter((k) => typeof pending[k] === "string" && pending[k] !== record[k]).map((k) => [k, pending[k]]));

// The models to choose from: those the account's key offers (llm: read), and the one
// stored when the key does not offer it, so the choice shows what is kept.
export const modelsFor = (llm, model) => {
  const models = Array.isArray(llm?.models) ? llm.models : [];
  return models.some((m) => m.id === model) ? models : [...models, { id: model, label: model }];
};

// Generators run on the account's own Anthropic key (7.7); null while llm has not
// answered, so the tab says nothing until it knows.
export const keySet = (llm) => {
  if (!llm || !Array.isArray(llm.providers)) return null;
  return llm.providers.some((p) => p.id === "anthropic" && p.keySet);
};

const replace = (generators, next) => (generators ?? []).map((g) => (g.id === next.id ? next : g));

// Saves what is typed: one generator.edited per generator with only what changed, and
// the fact's copy here takes the change at once, so a later edit compares against it.
const flush = enqueueActions(({ context, enqueue }) => {
  let generators = context.generators;
  for (const [id, pending] of Object.entries(context.pending)) {
    const record = generators?.find((g) => g.id === id);
    if (!record) continue;
    const fields = changed(record, pending);
    if (!Object.keys(fields).length) continue;
    enqueue.emit({ type: "generator.edited", id, ...fields });
    generators = replace(generators, { ...record, ...fields });
  }
  enqueue.assign({ generators, pending: {} });
});

const known = (context, id) => !!context.generators?.some((g) => g.id === id);

// A tick or a model is one gesture, saved at once; choosing again is its undo.
const choice = (field, valid) => ({
  guard: ({ context, event }) => known(context, event.id) && valid(event[field]) && shown(context, event.id)[field] !== event[field],
  actions: enqueueActions(({ context, event, enqueue }) => {
    enqueue.emit({ type: "generator.edited", id: event.id, [field]: event[field] });
    const record = context.generators.find((g) => g.id === event.id);
    enqueue.assign({ generators: replace(context.generators, { ...record, [field]: event[field] }) });
  }),
});

const typing = (target) => ({
  _type: {
    guard: ({ context, event }) => known(context, event.id) && TYPED.includes(event.field) && typeof event.value === "string",
    target,
    actions: assign({
      pending: ({ context, event }) => ({ ...context.pending, [event.id]: { ...(context.pending[event.id] ?? {}), [event.field]: event.value } }),
    }),
  },
});

export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("generators", "list", {})),
    llm: fromPromise(({ input }) => input.ask("llm", "read", {})),
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // On a page without a settings fact the ask replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "generator-settings",
  meta: {
    description:
      "The Generators tab of the gear's sheet, after Settings. It shows the two generators one " +
      "under the other, Chat title and Journal summary, each with an On tick box, its name, Model " +
      "(the models the account's Anthropic key offers, Haiku 5.5 at first) and Ask the model, the " +
      "prompt, in an editor box that follows the Vim keys preference. Every change is saved to the " +
      "account (generator.edited, carrying only the fields changed): the tick box and the model at " +
      "once, the name and the prompt a short time into typing and when the field loses focus. " +
      "Without an Anthropic key one line says generators run on it and that it is added in the " +
      "Settings tab. Run on the open chat, or Run on the picked journal " +
      "entry, asks for that one text again now with the current prompt (generation.requested), " +
      "saving what was typed first; a line under the button says what was asked for, for a few " +
      "seconds. The sheet takes the stage, so the chat list and the journal's contents stay in " +
      "sight and the new text is seen landing. Signed out or as a guest nothing runs, and the tab " +
      "shows only \"Sign in to use generators.\" It asks `generators: list`, `llm: read` for the models, `session: read` for who " +
      "the account is and `settings: read` for Vim keys, and follows each after.",
    kind: "view",
    attributes: [],
    emits: ["generator.edited", "generation.requested"],
    asks: ["generators: list", "llm: read", "session: read", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    throttleMs: input.throttleMs ?? 200,
    // How long the line saying what Run asked for stays.
    askedMs: input.askedMs ?? 4000,
    // The fact's two generators, null until generators: list answers.
    generators: null,
    failed: false,
    // What is typed and not yet saved, per generator: { name?, prompt? }.
    pending: {},
    llm: null,
    vimKeys: false,
    // Whether an account with a passkey is signed in: null until session answers.
    signedIn: null,
    // The generator whose Run was just pressed, and a count so an older timer ends nothing.
    asked: null,
    askedCount: 0,
  }),
  // Beside the states, so every picture arrives whatever the tab is doing; a change that
  // races its ask is held until the reply lands (4.2).
  invoke: [
    {
      src: "list",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        actions: assign(({ event }) =>
          Array.isArray(event.output?.generators) ? { generators: event.output.generators } : { failed: true },
        ),
      },
      onError: { actions: assign({ failed: true }) },
    },
    {
      src: "llm",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ llm: ({ event }) => (Array.isArray(event.output?.models) ? event.output : null) }) },
      onError: { actions: [] },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
  ],
  on: {
    "generator.changed": {
      actions: assign(({ context, event }) => {
        const next = event.generator;
        if (!context.generators) return {};
        const has = context.generators.some((g) => g.id === next.id);
        return { generators: has ? replace(context.generators, next) : [...context.generators, next] };
      }),
    },
    "llm.changed": {
      actions: assign({
        llm: ({ event }) => {
          const { type: _, ...picture } = event;
          return picture;
        },
      }),
    },
    "session.changed": { actions: assign({ signedIn: ({ event }) => signedIn(event) }) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    _switch: choice("on", (v) => typeof v === "boolean"),
    _model: choice("model", (v) => typeof v === "string" && v !== ""),
    _askedEnd: {
      guard: ({ context, event }) => event.count === context.askedCount,
      actions: assign({ asked: null }),
    },
    // Run saves what is typed first, so the text is made with the prompt on screen; the
    // bus delivers the two in order.
    _run: {
      guard: ({ context, event }) => known(context, event.id),
      target: ".clean",
      actions: [
        flush,
        enqueueActions(({ context, event, enqueue }) => {
          enqueue.emit({ type: "generation.requested", generator: event.id });
          const count = context.askedCount + 1;
          enqueue.assign({ asked: event.id, askedCount: count });
          enqueue.raise({ type: "_askedEnd", count }, { delay: context.askedMs });
        }),
      ],
    },
  },
  initial: "clean",
  states: {
    clean: { on: typing("dirty") },
    // Typing within the window joins the one save at its end: a throttle, not a
    // debounce, so the targetless edits below never restart the timer.
    dirty: {
      on: { ...typing(undefined), _blur: { target: "clean", actions: flush } },
      after: { throttle: { target: "clean", actions: flush } },
    },
  },
});
