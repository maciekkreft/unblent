import { setup, fromPromise, fromCallback, enqueueActions } from "xstate";

// `conversations` owns the chats (architecture.md 3.1): remote-only, because every
// turn needs the model and the model needs the server, so a chat cannot be made
// offline the way a note can (section 5). The browser holds only the open chat in
// memory; each turn is sent to the server the moment it is finished, and the server
// adds turns by id and ignores one it already has, so a resend is harmless and a
// chat continued later on another device keeps every turn. An answer still arriving
// when the page goes away is not kept (5): after a reload the chat ends with the
// question and Continue asks again. It answers `list`, `read`, `open` (which chat is
// open, per device) and `tools`; it emits `conversation.changed`,
// `conversation.deleted`, `conversation.opened` and `tools.changed`. It is where the
// tool loop will live (7.7), so it asks `llm: complete` and learns what the user did
// from events; it follows `subject.changed` to open the right chat (12) and
// `session.changed` to sync. Everything with a side effect — the network, the store,
// the clock, the id source — arrives through `input`, so this stays a pure
// definition importable in Node.

// A chat's title is the first non-empty line of the first message, cut short (12).
const firstLine = (text) => (text.split("\n").find((l) => l.trim() !== "") || "").trim().slice(0, 60);

// A chat is about a subject when one of its links names that subject (12).
const aboutMatch = (about, sub) => Boolean(sub) && about.some((a) => a.kind === sub.kind && a.id === sub.id);

// The most recently updated chat linked to the subject, or null (12): what the open
// chat becomes when the subject changes.
const mostRecentAbout = (headings, sub) => {
  if (!sub) return null;
  let best = null;
  for (const h of headings) if (aboutMatch(h.about, sub) && (!best || h.updatedAt > best.updatedAt)) best = h;
  return best ? best.id : null;
};

const sameSubject = (a, b) => (a && b ? a.kind === b.kind && a.id === b.id : a === b);

// A tool result rides to views as its size, not its content (4.3): the content can
// be very large and conversation.changed is announced many times a second, so
// `conversations` keeps the content and sends only its length.
const stripTurn = (turn) => {
  if (turn.role !== "user" || !turn.results) return turn;
  return {
    ...turn,
    results: turn.results.map((r) => {
      const out = { callId: r.callId, size: r.content != null ? r.content.length : r.size ?? 0 };
      if (r.isError !== undefined) out.isError = r.isError;
      return out;
    }),
  };
};

const hasUnsent = (context, id) => {
  const chat = context.chats.get(id);
  return chat ? chat.turns.some((t) => context.unsent.has(t.id)) : false;
};

// The whole conversation as it rides the bus (4.3, third rule): results without
// their content, and pending while a finished turn is not yet on the server (5).
const changedPayload = (context, chat) => ({
  type: "conversation.changed",
  id: chat.id,
  title: chat.title,
  about: chat.about,
  start: chat.start,
  turns: chat.turns.map(stripTurn),
  pending: hasUnsent(context, chat.id),
  updatedAt: chat.updatedAt,
});

// The read reply's conversation, shaped like the event minus the `type`.
const readShape = (context, chat) => {
  const { type, ...rest } = changedPayload(context, chat);
  return rest;
};

const heading = (chat) => ({ id: chat.id, title: chat.title, about: chat.about, updatedAt: chat.updatedAt });

const emptyChat = (id) => ({ id, title: "", about: [], start: "", turns: [], updatedAt: 0 });

// A completion.progressed `status` mapped to how the turn stores its end: a turn knows
// only done, stopped and failed, so refused and truncated are kept as failed with the
// reason in `error`.
const END_STATUS = { done: "done", stopped: "stopped", failed: "failed", refused: "failed", truncated: "failed" };

// The finished assistant turn from the final completion.progressed: `raw` only on done
// (kept so the same model can be replayed exactly what it produced), the reason in
// `error` for refused and truncated, and a truncated turn's calls dropped, because a
// cut-off call must never run. No tools are sent yet, so no turn carries calls.
const finalize = (turn, e) => {
  const t = { id: turn.id, role: "assistant", text: e.text, status: END_STATUS[e.status] || "failed" };
  if (turn.at !== undefined) t.at = turn.at;
  if (e.thinking) t.thinking = e.thinking;
  else if (turn.thinking) t.thinking = turn.thinking;
  if (e.status === "done") {
    if (e.raw !== undefined) t.raw = e.raw;
    for (const field of ["provider", "model", "usage"]) if (e[field] !== undefined) t[field] = e[field];
  }
  if (e.status === "refused") t.error = "refused";
  else if (e.status === "truncated") t.error = "truncated";
  else if (e.error !== undefined) t.error = e.error;
  return t;
};

// What is sent to the model: an empty assistant turn is left out; a done assistant turn
// carries its `raw` (and provider/model) so the same model is replayed what it produced;
// user turns carry their results with content. No tool rounds (calls followed by
// results) are built yet.
const forModel = (turns) => {
  const out = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      const u = { id: turn.id, role: "user", text: turn.text };
      if (turn.at !== undefined) u.at = turn.at;
      if (turn.results) u.results = turn.results;
      out.push(u);
    } else {
      if (!turn.text && !(turn.calls && turn.calls.length)) continue;
      const a = { id: turn.id, role: "assistant", text: turn.text, status: turn.status };
      if (turn.at !== undefined) a.at = turn.at;
      if (turn.raw !== undefined) a.raw = turn.raw;
      for (const field of ["provider", "model", "usage"]) if (turn[field] !== undefined) a[field] = turn[field];
      out.push(a);
    }
  }
  return out;
};

const findTurn = (context, turnId) => {
  for (const chat of context.chats.values()) {
    const index = chat.turns.findIndex((t) => t.id === turnId && t.role === "assistant");
    if (index >= 0) return { chat, index };
  }
  return null;
};

const chatsWithUnsent = (context) => {
  const ids = new Set();
  for (const chat of context.chats.values()) if (chat.turns.some((t) => context.unsent.has(t.id))) ids.add(chat.id);
  return [...ids];
};

const upsertHeading = (context, chat) => {
  const row = heading(chat);
  const index = context.headings.findIndex((h) => h.id === chat.id);
  if (index >= 0) context.headings = context.headings.map((h) => (h.id === chat.id ? row : h));
  else context.headings = [row, ...context.headings];
};

// --- side effects (fire and forget, reporting back through the actor's mailbox) ----
// The network never blocks a state: a request is fired and its outcome arrives as an
// internal message, so the actor stays a mailbox processed one message at a time
// (3.2). Saves are idempotent on the server (add by id), so a retry is harmless.

const fireSave = (context, self, chatId) => {
  const chat = context.chats.get(chatId);
  if (!chat) return;
  const turns = chat.turns.filter((t) => context.unsent.has(t.id));
  if (!turns.length) return;
  const body = { title: chat.title, about: chat.about, start: chat.start, turns };
  const turnIds = turns.map((t) => t.id);
  context
    .saveChat(chatId, body)
    .then((r) => self.send({ type: "_saved", chatId, turnIds, updatedAt: r ? r.updatedAt : undefined }))
    .catch(() => self.send({ type: "_saveFailed", chatId }));
};

const fireLoad = (context, self, id) => {
  if (context.loading.has(id)) return;
  context.loading.add(id);
  context
    .read(id)
    .then((conversation) => self.send({ type: "_loaded", id, conversation }))
    .catch(() => self.send({ type: "_loadFailed", id }));
};

const fireComplete = (context, self, turnId, request) => {
  context
    .complete(request)
    .then((reply) => self.send({ type: "_completeReply", turnId, reply }))
    .catch(() => self.send({ type: "_completeReply", turnId, reply: { error: "unavailable" } }));
};

const fireList = (context, self) => {
  context
    .list()
    .then((result) => self.send({ type: "_listed", result }))
    .catch(() => {}); // a failed reload keeps what we have; the chat already says it needs a connection
};

// Set which chat is open (12): kept per device through the store, announced only on a
// real change (4.3). A null id clears it.
const setOpen = (context, enqueue, id) => {
  if (context.openId === id) return;
  context.openId = id;
  enqueue(() => context.store.write(id));
  enqueue.emit({ type: "conversation.opened", id });
};

// --- handlers ----------------------------------------------------------------------

const onSubmit = (context, event, enqueue, self) => {
  const { conversationId, turn, about, start } = event;
  let chat = context.chats.get(conversationId);
  if (!chat) {
    chat = { id: conversationId, title: firstLine(turn.text), about: about ?? [], start: start ?? "", turns: [], updatedAt: context.now() };
    context.chats.set(conversationId, chat);
  }
  chat.turns.push({ id: turn.id, role: "user", text: turn.text, at: context.now() });
  const answerId = context.ulid();
  chat.turns.push({ id: answerId, role: "assistant", text: "", status: "pending", at: context.now() });
  context.running = { chatId: conversationId, turnId: answerId };
  setOpen(context, enqueue, conversationId);
  context.unsent.add(turn.id); // the user turn is finished the moment it is sent (5)
  upsertHeading(context, chat);
  enqueue(() => fireSave(context, self, conversationId));
  enqueue(() => fireComplete(context, self, answerId, { id: answerId, start: chat.start, turns: forModel(chat.turns), tools: [] }));
  enqueue.emit(changedPayload(context, chat));
};

// Continue when the chat ends with a user turn: ask the model again with everything
// saved, so an interruption loses nothing (5). Continuing a done answer that carries
// unrun lookups is not built yet.
const onContinue = (context, event, enqueue, self) => {
  const chat = context.chats.get(event.conversationId);
  if (!chat) return;
  const last = chat.turns[chat.turns.length - 1];
  if (!last || last.role !== "user") return;
  const answerId = context.ulid();
  chat.turns.push({ id: answerId, role: "assistant", text: "", status: "pending", at: context.now() });
  context.running = { chatId: chat.id, turnId: answerId };
  enqueue(() => fireComplete(context, self, answerId, { id: answerId, start: chat.start, turns: forModel(chat.turns), tools: [] }));
  enqueue.emit(changedPayload(context, chat));
};

const onProgress = (context, event, enqueue, self) => {
  const loc = findTurn(context, event.id);
  if (!loc) return; // a stray piece for a turn we no longer hold
  const { chat, index } = loc;
  if (!event.done) {
    const turn = { ...chat.turns[index], text: event.text };
    if (event.thinking) turn.thinking = event.thinking;
    chat.turns[index] = turn;
    enqueue.emit(changedPayload(context, chat));
    return;
  }
  chat.turns[index] = finalize(chat.turns[index], event);
  context.running = null;
  context.unsent.add(chat.turns[index].id);
  chat.updatedAt = context.now();
  upsertHeading(context, chat);
  enqueue(() => fireSave(context, self, chat.id));
  enqueue.emit(changedPayload(context, chat));
};

// A `complete` refusal (busy, signed-out, no-key, unavailable) or a network error:
// the pending answer becomes a failed turn the chat can offer Try again for (12).
const onCompleteReply = (context, event, enqueue, self) => {
  if (event.reply && event.reply.id) return; // the answer is streaming; nothing to do
  const loc = findTurn(context, event.turnId);
  if (!loc) return;
  const { chat, index } = loc;
  if (chat.turns[index].status !== "pending") return;
  chat.turns[index] = { ...chat.turns[index], status: "failed", error: (event.reply && event.reply.error) || "unavailable" };
  context.running = null;
  context.unsent.add(chat.turns[index].id);
  chat.updatedAt = context.now();
  upsertHeading(context, chat);
  enqueue(() => fireSave(context, self, chat.id));
  enqueue.emit(changedPayload(context, chat));
};

const onSelect = (context, event, enqueue, self) => {
  setOpen(context, enqueue, event.id);
  if (event.id != null && !context.chats.has(event.id) && context.headings.some((h) => h.id === event.id))
    enqueue(() => fireLoad(context, self, event.id));
};

const onDiscard = (context, event, enqueue) => {
  const { id } = event;
  const chat = context.chats.get(id);
  if (chat) for (const turn of chat.turns) context.unsent.delete(turn.id);
  context.chats.delete(id);
  context.headings = context.headings.filter((h) => h.id !== id);
  if (context.openId === id) setOpen(context, enqueue, null);
  enqueue(() => context.deleteChat(id).catch(() => {}));
  enqueue.emit({ type: "conversation.deleted", id });
};

const onToolsEdited = (context, event, enqueue) => {
  if (event.tools) context.tools = { ...context.tools, ...event.tools };
  if (event.approval) context.approval = event.approval;
  const value = { tools: context.tools, approval: context.approval };
  enqueue(() => context.saveTools(value).catch(() => {}));
  enqueue.emit({ type: "tools.changed", ...value });
};

const onSubjectChanged = (context, event, enqueue, self) => {
  const sub = event.subject ? { kind: event.subject.kind, id: event.subject.id } : null;
  if (sameSubject(sub, context.lastSubject)) return;
  context.lastSubject = sub;
  const next = mostRecentAbout(context.headings, sub);
  if (next === context.openId) return;
  setOpen(context, enqueue, next);
  if (next != null && !context.chats.has(next)) enqueue(() => fireLoad(context, self, next));
};

const answerList = (context, reply) => {
  if (context.unavailable) return reply({ error: "unavailable" });
  const conversations = context.headings
    .map((h) => ({ id: h.id, title: h.title, about: h.about, updatedAt: h.updatedAt, pending: hasUnsent(context, h.id) }))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  reply({ conversations });
};

const answerRead = (context, event, enqueue, self) => {
  const { id } = event.payload;
  const chat = context.chats.get(id);
  if (chat) return event.reply({ conversation: readShape(context, chat) });
  if (context.unavailable) return event.reply({ error: "unavailable" });
  if (!context.signedIn) return event.reply({ error: "not-found" });
  if (context.headings.some((h) => h.id === id)) {
    context.reading.set(id, [...(context.reading.get(id) || []), event.reply]);
    enqueue(() => fireLoad(context, self, id));
    return;
  }
  // An id no chat has is an empty new chat (12): the panel shows an empty thread.
  event.reply({ conversation: readShape(context, emptyChat(id)) });
};

const onLoaded = (context, event, enqueue) => {
  context.loading.delete(event.id);
  const c = event.conversation;
  const chat = { id: c.id, title: c.title, about: c.about ?? [], start: c.start ?? "", turns: c.turns ?? [], updatedAt: c.updatedAt ?? 0 };
  context.chats.set(event.id, chat);
  upsertHeading(context, chat);
  const held = context.reading.get(event.id);
  if (held) {
    for (const reply of held) reply({ conversation: readShape(context, chat) });
    context.reading.delete(event.id);
  }
  enqueue.emit(changedPayload(context, chat));
};

const onLoadFailed = (context, event) => {
  context.loading.delete(event.id);
  const held = context.reading.get(event.id);
  if (held) {
    for (const reply of held) reply({ error: "unavailable" });
    context.reading.delete(event.id);
  }
};

const onSaved = (context, event, enqueue) => {
  for (const turnId of event.turnIds) context.unsent.delete(turnId);
  const chat = context.chats.get(event.chatId);
  if (!chat) return;
  if (event.updatedAt != null) chat.updatedAt = event.updatedAt;
  upsertHeading(context, chat);
  enqueue.emit(changedPayload(context, chat));
};

const onListed = (context, event) => {
  const result = event.result;
  if (!result || !result.conversations) return;
  // Keep a local heading the server has not yet confirmed (a new chat whose turns are
  // still unsent), so a focus reload does not drop it from the list.
  const serverIds = new Set(result.conversations.map((h) => h.id));
  const keptLocal = context.headings.filter((h) => !serverIds.has(h.id) && hasUnsent(context, h.id));
  context.headings = [...result.conversations, ...keptLocal];
  if (result.tools) {
    context.tools = result.tools.tools || {};
    context.approval = result.tools.approval || "auto";
  }
  context.unavailable = false;
};

const onFocus = (context, enqueue, self) => {
  if (!context.signedIn) return;
  enqueue(() => fireList(context, self));
  // Do not reload a chat that still has finished turns the server has not confirmed: the
  // server's copy is missing them, so replacing memory with it would drop turns that can
  // never be sent (5: nothing that was completed is lost). Retry the save instead.
  if (context.openId != null && !context.running && !hasUnsent(context, context.openId) && context.headings.some((h) => h.id === context.openId))
    enqueue(() => fireLoad(context, self, context.openId));
  for (const chatId of chatsWithUnsent(context)) enqueue(() => fireSave(context, self, chatId));
};

const onOnline = (context, enqueue, self) => {
  for (const chatId of chatsWithUnsent(context)) enqueue(() => fireSave(context, self, chatId));
};

// The boot picture: who is signed in decides whether the server is read at all (3.4);
// signed in, the chats and the tool preferences are loaded and the subject read for
// the starting open chat (12). A failed list is reported so `list`/`read` answer
// unavailable. Missing session or subject askers (a Node test) are treated as absent.
const applyBoot = (context, out, self) => {
  const base = { chats: new Map(), unsent: new Set(), reading: new Map(), loading: new Set(), running: null };
  if (out.userId == null) {
    Object.assign(context, base, { userId: null, signedIn: false, unavailable: false, headings: [], openId: null, lastSubject: null, tools: {}, approval: "auto" });
  } else if (out.failed) {
    Object.assign(context, base, { userId: out.userId, signedIn: true, unavailable: true, headings: [], openId: context.store.read(), lastSubject: null, tools: {}, approval: "auto" });
  } else {
    const headings = out.list.conversations || [];
    const toolsValue = out.list.tools || {};
    const sub = out.subject ? { kind: out.subject.kind, id: out.subject.id } : null;
    const stored = context.store.read();
    const openId = stored != null ? stored : mostRecentAbout(headings, sub);
    Object.assign(context, base, { userId: out.userId, signedIn: true, unavailable: false, headings, openId, lastSubject: sub, tools: toolsValue.tools || {}, approval: toolsValue.approval || "auto" });
  }
  const queued = context.queued;
  context.queued = [];
  for (const message of queued) self.send(message);
};

// A message that arrived before the boot picture is queued and replayed once ready.
const queue = enqueueActions(({ context, event }) => {
  context.queued = [...context.queued, event];
});

export const machine = setup({
  actors: {
    // The one round trip that gates the rest: session, then the chats and the subject.
    boot: fromPromise(async ({ input }) => {
      const session = await input.session();
      const userId = session ? session.userId ?? null : null;
      if (userId == null) return { userId: null };
      let list;
      try {
        list = await input.list();
      } catch {
        return { userId, failed: true };
      }
      const subjectReply = await input.subject().catch(() => ({}));
      return { userId, list, subject: subjectReply && subjectReply.subject ? subjectReply.subject : null };
    }),
    // The browser's focus and online signals (5): a subscribe function from fact.js
    // sends _focus/_online; absent (a Node test) it is a no-op, and tests send those
    // messages by hand.
    signals: fromCallback(({ input, sendBack }) => {
      const stop = input.subscribe ? input.subscribe((type) => sendBack({ type })) : undefined;
      return () => stop?.();
    }),
  },
}).createMachine({
  id: "conversations",
  meta: {
    kind: "fact",
    shape: "remote-only",
    owns: "the chats",
    emits: ["conversation.changed", "conversation.deleted", "conversation.opened", "tools.changed"],
    asks: ["session: read", "subject: read", "llm: complete", "catalog: contracts"],
  },
  context: ({ input }) => ({
    session: input.session,
    subject: input.subject,
    complete: input.complete,
    list: input.list,
    read: input.read,
    saveChat: input.saveChat,
    deleteChat: input.deleteChat,
    saveTools: input.saveTools,
    store: input.store,
    ulid: input.ulid,
    now: input.now,
    subscribe: input.subscribe,
    userId: null,
    signedIn: false,
    unavailable: false,
    headings: [],
    chats: new Map(), // id -> { id, title, about, start, turns, updatedAt }; turns keep their results' content
    unsent: new Set(), // finished turn ids not yet confirmed by the server; pending is derived from this
    reading: new Map(), // id -> [reply]; read replies held while a chat loads
    loading: new Set(),
    openId: null,
    lastSubject: null,
    tools: {},
    approval: "auto",
    running: null, // { chatId, turnId } while an answer streams
    queued: [],
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "boot",
        input: ({ context }) => ({ session: context.session, list: context.list, subject: context.subject }),
        onDone: { target: "ready", actions: enqueueActions(({ context, event, self }) => applyBoot(context, event.output, self)) },
        onError: { target: "ready", actions: enqueueActions(({ context, self }) => applyBoot(context, { userId: null }, self)) },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "open?": { actions: queue },
        "tools?": { actions: queue },
        "turn.submitted": { actions: queue },
        "turn.steered": { actions: queue },
        "conversation.selected": { actions: queue },
        "conversation.discarded": { actions: queue },
        "tools.edited": { actions: queue },
      },
    },
    ready: {
      invoke: { src: "signals", input: ({ context }) => ({ subscribe: context.subscribe }) },
      on: {
        "list?": { actions: ({ context, event }) => answerList(context, event.reply) },
        "read?": { actions: enqueueActions(({ context, event, enqueue, self }) => answerRead(context, event, enqueue, self)) },
        "open?": { actions: ({ context, event }) => event.reply({ id: context.openId }) },
        "tools?": { actions: ({ context, event }) => event.reply({ tools: context.tools, approval: context.approval }) },
        "turn.submitted": { actions: enqueueActions(({ context, event, enqueue, self }) => onSubmit(context, event, enqueue, self)) },
        "turn.steered": {
          actions: enqueueActions(({ context, event, enqueue, self }) => {
            if (event.action === "continue") onContinue(context, event, enqueue, self);
            // stop is llm's to act on (12): the resulting completion.progressed ends the turn here.
          }),
        },
        "completion.progressed": { actions: enqueueActions(({ context, event, enqueue, self }) => onProgress(context, event, enqueue, self)) },
        "conversation.selected": { actions: enqueueActions(({ context, event, enqueue, self }) => onSelect(context, event, enqueue, self)) },
        "conversation.discarded": { actions: enqueueActions(({ context, event, enqueue }) => onDiscard(context, event, enqueue)) },
        "tools.edited": { actions: enqueueActions(({ context, event, enqueue }) => onToolsEdited(context, event, enqueue)) },
        "subject.changed": { actions: enqueueActions(({ context, event, enqueue, self }) => onSubjectChanged(context, event, enqueue, self)) },
        // The fact's own news about who is signed in (4.3): a different user re-boots
        // the chats; signing out clears them.
        "session.changed": [
          { guard: ({ context, event }) => (event.userId ?? null) !== context.userId, target: "loading" },
        ],
        _completeReply: { actions: enqueueActions(({ context, event, enqueue, self }) => onCompleteReply(context, event, enqueue, self)) },
        _saved: { actions: enqueueActions(({ context, event, enqueue }) => onSaved(context, event, enqueue)) },
        _saveFailed: {}, // the unsent turns stay, so pending stays true; a later trigger retries
        _loaded: { actions: enqueueActions(({ context, event, enqueue }) => onLoaded(context, event, enqueue)) },
        _loadFailed: { actions: ({ context, event }) => onLoadFailed(context, event) },
        _listed: { actions: ({ context, event }) => onListed(context, event) },
        _focus: { actions: enqueueActions(({ context, enqueue, self }) => onFocus(context, enqueue, self)) },
        _online: { actions: enqueueActions(({ context, enqueue, self }) => onOnline(context, enqueue, self)) },
      },
    },
  },
});
