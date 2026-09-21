import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The question box (architecture.md 3.1): a view owning only its draft (kept in the
// view's own storage, 3.1). It emits `turn.submitted` when the reader sends and
// `turn.steered` to stop or continue an answer (4, fifth rule; 6.3). It asks
// `conversations` which chat is open and reads it, so it knows whether an answer is
// arriving (Send becomes Stop) or the chat was left hanging (Continue / Try again); it
// asks `subject` for what a new chat links to, and `llm` to know whether it must
// disable itself (signed out, or the provider has no key). It follows the matching
// events. Everything with a side effect — the queries, minting an id — arrives through
// input, so this stays a pure definition importable in Node.

// The instructions a new chat begins with (12: the text a chat starts with is filled
// once, by the view where the user acted, and never changes). Written once when the chat
// is created and never changed, so the provider's cache holds and the chat is an honest
// record of what the model was told. General on purpose: the specific request is what
// the reader types. The open item, if any, is named on one appended line.
const START = `You are a thoughtful reading companion inside a personal library app. The reader keeps books, highlights passages that matter to them, and writes notes. Help them read and understand what they are reading.

Be concise and direct. When something in the reader's own library is relevant, you may look it up — their highlights and notes show what caught their attention and what they were thinking, so read them when they help you answer.

Answer in plain language, and say when you are unsure.`;

export const startText = (subject) => {
  if (!subject) return START;
  const named = subject.title ? `${subject.kind} "${subject.title}"` : subject.kind;
  return `${START}\n\nThe reader currently has open: ${named}.`;
};

const asConversation = (event) => {
  const { type, ...rest } = event;
  return rest;
};

// The starting picture must not overwrite a value an event already set while the four
// asks were in flight (4.3, fourth rule: an event is the authority, the ask reply is the
// baseline). The event handlers live at the root so they apply in every state, including
// `starting`; each marks the fields it set, and the start actor's onDone assigns a field
// only when no event has touched it since the machine started.
const mark = (touched, ...fields) => {
  const next = { ...touched };
  for (const f of fields) next[f] = true;
  return next;
};

const turns = (conversation) => conversation?.turns ?? [];
const lastTurn = (conversation) => {
  const t = turns(conversation);
  return t.length ? t[t.length - 1] : null;
};

// While an answer is arriving the last turn is a pending assistant turn; its id is what
// a Stop steers (12).
export const pendingTurn = (conversation) => {
  const last = lastTurn(conversation);
  return last && last.role === "assistant" && last.status === "pending" ? last : null;
};

// The chat was left hanging at the reader's question: Continue asks the model again with
// everything saved, no new text needed (5: a finished turn is always on the server, so
// the model can be re-asked after an interruption).
export const canContinue = (conversation) => {
  const last = lastTurn(conversation);
  return Boolean(last && last.role === "user");
};

// The question to resend when an answer failed or was stopped with nothing worth
// keeping (12): the user turn just before that assistant turn, or null when there is
// nothing to try again.
export const retryText = (conversation) => {
  const list = turns(conversation);
  const last = list[list.length - 1];
  if (!last || last.role !== "assistant") return null;
  const worthRetrying = last.status === "failed" || (last.status === "stopped" && !last.text);
  if (!worthRetrying) return null;
  const prev = list[list.length - 2];
  return prev && prev.role === "user" ? prev.text : null;
};

// Whether the box is usable, and the one line shown when it is not (12): signed out, or
// the chosen provider needs a key it does not have. While the llm picture is still
// loading the box is disabled with no line, so no wrong message flashes.
export const inputState = (llm) => {
  if (!llm) return { disabled: true, notice: null };
  if (!llm.signedIn) return { disabled: true, notice: "Sign in to chat." };
  const provider = (llm.providers || []).find((p) => p.id === llm.provider);
  if (provider && provider.needsKey && !provider.keySet) return { disabled: true, notice: "Add your API key in Settings." };
  return { disabled: false, notice: null };
};

// A chat is new (it needs `about` and `start`) when it has no turns yet: `conversations`
// writes the start only when it first creates the chat (12).
const isNew = (context) => turns(context.conversation).length === 0;

const submit = (context, enqueue, text) => {
  const body = text.trim();
  if (!body) return;
  if (pendingTurn(context.conversation)) return; // an answer is arriving; the button is Stop
  const conversationId = context.openId ?? context.mint();
  const event = { type: "turn.submitted", conversationId, turn: { id: context.mint(), text: body } };
  if (isNew(context)) {
    event.about = context.subject ? [{ kind: context.subject.kind, id: context.subject.id }] : [];
    event.start = startText(context.subject);
  }
  enqueue.emit(event);
};

const retry = (context, enqueue) => {
  const text = retryText(context.conversation);
  if (text == null || context.openId == null) return;
  enqueue.emit({ type: "turn.submitted", conversationId: context.openId, turn: { id: context.mint(), text } });
};

const stop = (context, enqueue) => {
  const pending = pendingTurn(context.conversation);
  if (!pending || context.openId == null) return;
  enqueue.emit({ type: "turn.steered", conversationId: context.openId, turnId: pending.id, action: "stop" });
};

const resume = (context, enqueue) => {
  const last = lastTurn(context.conversation);
  if (!canContinue(context.conversation) || context.openId == null) return;
  enqueue.emit({ type: "turn.steered", conversationId: context.openId, turnId: last.id, action: "continue" });
};

export const machine = setup({
  actors: {
    // The starting picture (4.3): which chat is open and its turns, the subject a new
    // chat links to, and the account picture that decides whether the box is usable.
    // subject: read may go unanswered where no subject fact is mounted (a Node test); it
    // is treated as none.
    start: fromPromise(async ({ input }) => {
      const [open, subject, llm] = await Promise.all([
        input.ask("conversations", "open", {}),
        input.ask("subject", "read", {}).catch(() => ({ subject: null })),
        input.ask("llm", "read", {}),
      ]);
      let conversation = null;
      const openId = open?.id ?? null;
      if (openId != null) {
        const reply = await input.ask("conversations", "read", { id: openId });
        conversation = reply?.conversation ?? null;
      }
      return { openId, subject: subject?.subject ?? null, llm, conversation };
    }),
  },
}).createMachine({
  id: "chat-input",
  meta: {
    kind: "view",
    attributes: [],
    emits: ["turn.submitted", "turn.steered"],
    asks: ["conversations: open", "conversations: read", "subject: read", "llm: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    openId: null,
    conversation: null,
    subject: null,
    llm: null,
    // Which fields an event set while the start actor was in flight, so onDone leaves
    // those alone.
    touched: {},
  }),
  initial: "starting",
  // The fact's news, applied in every state so nothing that arrives while the machine is
  // still starting is lost (4.3).
  on: {
    // The open chat changed on this device (12): read the new one for the starting
    // picture; conversation.changed keeps it current after (4.3), held until the read
    // lands (4.2).
    "conversation.opened": {
      actions: enqueueActions(({ context, event, enqueue, self }) => {
        enqueue.assign({ openId: event.id, conversation: null, touched: mark(context.touched, "openId", "conversation") });
        if (event.id != null) {
          const id = event.id;
          enqueue(() =>
            context
              .ask("conversations", "read", { id })
              .then((reply) => self.send({ type: "_openLoaded", id, conversation: reply?.conversation ?? null }))
              .catch(() => {}),
          );
        }
      }),
    },
    _openLoaded: {
      guard: ({ context, event }) => event.id === context.openId,
      actions: assign({ conversation: ({ event }) => event.conversation, touched: ({ context }) => mark(context.touched, "conversation") }),
    },
    "conversation.changed": {
      guard: ({ context, event }) => event.id === context.openId,
      actions: assign({ conversation: ({ event }) => asConversation(event), touched: ({ context }) => mark(context.touched, "conversation") }),
    },
    "conversation.deleted": {
      guard: ({ context, event }) => event.id === context.openId,
      actions: assign({ openId: null, conversation: null, touched: ({ context }) => mark(context.touched, "openId", "conversation") }),
    },
    // The stage moved (4.3): a new chat links to the subject now on the stage.
    "subject.changed": {
      actions: assign({ subject: ({ event }) => event.subject ?? null, touched: ({ context }) => mark(context.touched, "subject") }),
    },
    // The account picture changed (4.3): the box enables or disables to match.
    "llm.changed": {
      actions: assign({ llm: ({ event }) => asPicture(event), touched: ({ context }) => mark(context.touched, "llm") }),
    },
  },
  states: {
    starting: {
      invoke: {
        src: "start",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: assign(({ context, event }) => {
            const t = context.touched;
            const o = event.output;
            return {
              openId: t.openId ? context.openId : o.openId,
              subject: t.subject ? context.subject : o.subject,
              llm: t.llm ? context.llm : o.llm,
              conversation: t.conversation ? context.conversation : o.conversation,
            };
          }),
        },
        // A failed start leaves the box disabled with no line, as while loading.
        onError: "ready",
      },
    },
    ready: {
      on: {
        // The reader's gestures, forwarded by the view.
        _send: { actions: enqueueActions(({ context, event, enqueue }) => submit(context, enqueue, event.text)) },
        _retry: { actions: enqueueActions(({ context, enqueue }) => retry(context, enqueue)) },
        _stop: { actions: enqueueActions(({ context, enqueue }) => stop(context, enqueue)) },
        _continue: { actions: enqueueActions(({ context, enqueue }) => resume(context, enqueue)) },
      },
    },
  },
});

// llm.changed carries the read picture with a `type`; strip it, as with conversations.
function asPicture(event) {
  const { type, ...rest } = event;
  return rest;
}
