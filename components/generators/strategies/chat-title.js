// The chat-title strategy (13): a chat is ready once its first answer has finished,
// and the model reads its first message, what was looked up for it and that answer.
// A plain object imported only by this component's machine.js (11.1).

// Python's str.isspace, so a turn counts as having text exactly when the backfill
// script's strip() says so.
const PY_SPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
const hasText = (t) => typeof t?.text === "string" && !PY_SPACE.test(t.text);
// Cut by characters as Python counts them (code points), not UTF-16 units.
const cut = (s, n) => (s.length <= n ? s : Array.from(s).slice(0, n).join(""));

// A chat's first round: the first user turn with text, every turn up to the next user
// turn with text, the last finished answer with text in it, and the lookups made before
// that answer that name what they read, each matched to its result anywhere in the
// round (a stored result can sort after the next answer). A lookup is its call's label
// with the `name` and `excerpt` conversation.changed carries on its result (7.2, 7.7),
// the excerpt "" when the result has none; an error, or a result without a name (a
// listing), is left out. Null when there is no answer yet.
export function firstRound(turns) {
  const isQuestion = (t) => t.role === "user" && hasText(t);
  const q = turns.findIndex(isQuestion);
  if (q < 0) return null;
  let end = turns.findIndex((t, i) => i > q && isQuestion(t));
  if (end < 0) end = turns.length;
  const round = turns.slice(q + 1, end);
  let at = -1;
  round.forEach((t, i) => {
    if (t.role === "assistant" && t.status === "done" && hasText(t)) at = i;
  });
  if (at < 0) return null;
  const results = new Map();
  for (const t of round) if (t.role === "user") for (const r of t.results ?? []) results.set(r.callId, r);
  const lookups = [];
  for (const t of round.slice(0, at)) {
    if (t.role !== "assistant") continue;
    for (const call of t.calls ?? []) {
      const r = results.get(call.id);
      if (!r || r.isError || typeof r.name !== "string" || r.name === "") continue;
      lookups.push({ label: call.label ?? "", name: r.name, excerpt: typeof r.excerpt === "string" ? r.excerpt : "" });
    }
  }
  return { question: turns[q].text, lookups, answer: cut(round[at].text, 8000) };
}

export const chatTitle = {
  generator: "chat-title",
  start: () => ({ chats: new Map(), opened: null }),
  follows: ["conversation.changed", "conversation.opened"],
  follow(seen, event) {
    if (event.type === "conversation.opened") {
      seen.opened = event.id ?? null;
      return;
    }
    const turns = Array.isArray(event.turns) ? event.turns : [];
    const last = turns.at(-1);
    seen.chats.set(event.id, {
      source: firstRound(turns),
      at: event.updatedAt ?? 0,
      // Ready: one question so far, and the answer to it finished with no lookup pending.
      ready:
        turns.filter((t) => t.role === "user" && hasText(t)).length === 1 &&
        last?.role === "assistant" &&
        last.status === "done" &&
        !(last.calls?.length > 0),
    });
  },
  items(seen) {
    const items = [];
    for (const [item, chat] of seen.chats) if (chat.ready && chat.source) items.push({ item, at: chat.at, source: chat.source });
    return items;
  },
  target(seen) {
    const chat = seen.chats.get(seen.opened);
    return chat?.source ? { item: seen.opened, at: chat.at, source: chat.source } : null;
  },
  // A chat is named once (the plan's "no result yet for that chat"); Run names it again.
  done: (result) => result != null,
  input: ({ question, lookups, answer }) =>
    `First message:\n${question}\n\n` +
    (lookups.length ? `Looked up:\n${lookups.map((l) => `- ${l.label}: ${l.name}` + (l.excerpt ? `\n  ${l.excerpt}` : "")).join("\n")}\n\n` : "") +
    `First answer:\n${answer}`,
};
