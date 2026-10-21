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

Keep answers to a few sentences. When something in the reader's own library is relevant, you may look it up — their highlights and notes show what caught their attention and what they were thinking, so read them when they help you answer.

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

// The chat was left hanging, and Continue resumes it with everything saved, no new text
// needed (5: a finished turn is always on the server, so the chat can be resumed after an
// interruption). Two endings can be resumed: the reader's question with no answer yet
// (case a), or a finished answer that asked for lookups nobody ran — a reload or a Stop
// during a round (case b); the lookups only read, so running them now is harmless.
export const canContinue = (conversation) => {
  const last = lastTurn(conversation);
  if (!last) return false;
  if (last.role === "user") return true;
  return last.role === "assistant" && last.status === "done" && Boolean(last.calls && last.calls.length);
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

// Where the box's unsent text is kept (3.1, the view's own UI state): one draft per chat,
// and one per subject for a chat not yet started, so text typed about one book never
// shows up beside another, or in the journal. The view keys its storage by this. A chat
// with no messages counts as new: `conversations` keeps no such chat when the subject
// moves, so coming back opens none, and its text must be found under the subject. Null
// while the open chat is still being read, so the view does not load the wrong draft
// before it is known whether the chat has messages.
export const chatDraftKey = (id) => `chat:${id}`;
export const draftKey = (context) => {
  if (context.openId != null) {
    if (context.reading === context.openId) return null;
    if (turns(context.conversation).length) return chatDraftKey(context.openId);
  }
  if (context.subject) return `new:${context.subject.kind}:${context.subject.id}`;
  return "new:";
};

// A chat is new (it needs `about` and `start`) when it has no turns yet: `conversations`
// writes the start only when it first creates the chat (12).
const isNew = (context) => turns(context.conversation).length === 0;

// Picking a chat with no messages puts the cursor in the box (12). The view focuses when
// `focusRequest` changes; `focusFor` is the picked chat while its read is in flight.
const focusIfNew = (context, conversation) => ({
  focusFor: null,
  focusRequest: turns(conversation).length === 0 ? context.focusRequest + 1 : context.focusRequest,
});

// A list ended by sending leaves an empty item behind ("- "), which is not part of the
// question.
export const sendable = (text) => {
  let body = text.trim();
  while (/(^|\n) *[-*]$/.test(body)) body = body.replace(/ *[-*]$/, "").trim();
  return body;
};

// How many comments on the chat's last answer are waiting to go with the next message.
// They count only while that answer is still the last turn, as `conversations` keeps them.
export const unsentComments = (conversation) => {
  const marks = conversation?.marks;
  const last = lastTurn(conversation);
  if (!marks || !last || marks.answerId !== last.id) return 0;
  return marks.marks?.length ?? 0;
};

// Comments alone are a message: the box may be empty when there are some to send.
export const canSend = (conversation, text) => Boolean(sendable(text)) || unsentComments(conversation) > 0;

// The Send button names what it sends when comments ride along.
export const sendLabel = (conversation) => {
  const n = unsentComments(conversation);
  if (!n) return "Send";
  return n === 1 ? "Send 1 comment" : "Send " + n + " comments";
};

const submit = (context, enqueue, text) => {
  const body = sendable(text);
  if (!canSend(context.conversation, text)) return;
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
    // The "Vim keys" device preference (12), owned by `settings`. Read on its own so the
    // box works on a page with no settings fact (the ask replies no-answerer, Vim off).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "chat-input",
  meta: {
    description:
      "The box where the user types a question to the chat and sends it. While an answer is " +
      "arriving Send becomes Stop, and a chat left without an answer offers Continue or Try " +
      "again. It writes the instructions a new chat starts with once, when the chat is created, " +
      "naming the open item on one line; they never change afterwards, so the provider's cache " +
      "holds and the chat is an honest record of what the model was told. When the user picks a " +
      "chat with no messages yet, such as the New chat row or a new chat made with o or O in " +
      "the chat list, the box takes focus, in Vim's " +
      "insert mode when Vim keys is on; it follows the user's pick and not which chat is open, " +
      "so a change of subject or a reload never moves the cursor. Unsent text is kept in this " +
      "browser for each chat, and for a new chat about each open item, so it is still there " +
      "after a reload or on coming back, and never shows up in another chat; sending clears " +
      "it, and deleting a chat drops its text. When the user has commented on the last answer, " +
      "Send says how many comments it sends and works with an empty box. It disables itself while nobody is signed in " +
      "or the chosen provider has no key.",
    kind: "view",
    attributes: [],
    emits: ["turn.submitted", "turn.steered"],
    asks: ["conversations: open", "conversations: read", "subject: read", "llm: read", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    openId: null,
    conversation: null,
    subject: null,
    llm: null,
    // The "Vim keys" preference (12): off until settings says otherwise, and off on a
    // page without a settings fact.
    vimKeys: false,
    // Which fields an event set while the start actor was in flight, so onDone leaves
    // those alone.
    touched: {},
    focusFor: null,
    focusRequest: 0,
    // The chat whose read is in flight, so a pick of it waits for the read to land.
    reading: null,
    // Every chat deleted since mount, in order, so the view drops each one's draft even
    // when several land between two renders.
    deleted: [],
  }),
  initial: "starting",
  // Beside the states, so the preference arrives whatever the box is doing and a
  // keystroke never waits for it. A settings.changed that races it is held for us until
  // the reply lands (settings: read supersededBy).
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
  },
  // The fact's news, applied in every state so nothing that arrives while the machine is
  // still starting is lost (4.3).
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // The open chat changed on this device (12): read the new one for the starting
    // picture; conversation.changed keeps it current after (4.3), held until the read
    // lands (4.2).
    "conversation.opened": {
      actions: enqueueActions(({ context, event, enqueue, self }) => {
        enqueue.assign({ openId: event.id, conversation: null, reading: event.id, touched: mark(context.touched, "openId", "conversation") });
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
      actions: assign(({ context, event }) => ({
        conversation: event.conversation,
        reading: null,
        touched: mark(context.touched, "conversation"),
        ...(event.id === context.focusFor ? focusIfNew(context, event.conversation) : {}),
      })),
    },
    // The user picked a chat (12): the gesture, not conversation.opened, so a subject
    // change or a reload never moves the cursor. A chat already shown is decided now;
    // another waits for its read.
    "conversation.selected": {
      actions: assign(({ context, event }) =>
        event.id === context.openId && context.reading !== event.id ? focusIfNew(context, context.conversation) : { focusFor: event.id },
      ),
    },
    "conversation.changed": {
      guard: ({ context, event }) => event.id === context.openId,
      actions: assign({ conversation: ({ event }) => asConversation(event), touched: ({ context }) => mark(context.touched, "conversation") }),
    },
    "conversation.deleted": {
      actions: assign(({ context, event }) => ({
        deleted: [...context.deleted, event.id],
        ...(event.id === context.openId
          ? { openId: null, conversation: null, touched: mark(context.touched, "openId", "conversation") }
          : {}),
      })),
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
