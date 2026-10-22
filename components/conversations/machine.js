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
// `conversation.deleted`, `conversation.opened` and `tools.changed`. It runs the tool
// loop (7.7): a tool is one of the system's own queries, opted in by its owner, so it
// asks `llm: complete`, `catalog: contracts` for the tool list, and any marked query
// through the `*: tool` wildcard. It follows `subject.changed` to open the right chat
// (12), `pins.changed` to keep a pinned chat open, and `session.changed` to sync. Everything with a side effect — the network, the
// store, the clock, the id source — arrives through `input`, so this stays a pure
// definition importable in Node.

// A chat's title is the first non-empty line of the first message, cut short (12).
const firstLine = (text) => (text.split("\n").find((l) => l.trim() !== "") || "").trim().slice(0, 60);

// A title given to a chat (12): what the chat-title generator wrote, or what the user
// typed in the list. A blank one gives back the first line of the first message.
const titled = (chat, text) => {
  const title = (text ?? "").trim();
  if (title) return title;
  const first = chat.turns.find((t) => t.role === "user" && (t.text ?? "").trim() !== "");
  return first ? firstLine(first.text) : chat.title;
};

// A chat's subtitle is the first line of its latest answer that has text, as plain
// text, so a list shows two lines like a note's (notes/machine.js subtitleOf) without
// holding the turns. The answer is markdown: a heading line ("## Summary") says little
// about the answer, so the first line that is not a heading is used when there is one,
// and the markers a line starts with and the inline emphasis and code marks are
// dropped; capped so it stays small in every event.
const HEADING = /^#{1,6}\s/;
const subtitleOf = (text) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return (lines.find((l) => !HEADING.test(l)) ?? lines[0] ?? "")
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim()
    .slice(0, 120);
};

const latestAnswer = (turns) => {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "assistant" && turns[i].text.trim() !== "") return turns[i].text;
  return "";
};

// A heading as the server lists it carries the latest answer's text, cut to size
// (server/router.py); the subtitle is derived here, in one place.
const fromServer = ({ answer, ...h }) => ({ ...h, subtitle: subtitleOf(answer ?? "") });

// A chat's place in the list is a fractional index (5, an item's place is last write
// wins), the same design as a note's (notes/machine.js): a string that sorts by plain
// code-unit comparison, so a chat moved between two others takes a key between theirs
// and no other chat changes. The digits are in ASCII order, and a key never ends in the
// smallest digit, so there is always room before it.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
export const isPosition = (value) => typeof value === "string" && value.length <= 200 && KEY.test(value);

// The key between a and b (a < b); "" stands for before everything, null for after.
function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

// A key strictly between `after` and `before`, either null for the list's end. Out of
// order neighbours (a move computed against a list that changed meanwhile) place the
// chat just after `after`.
export function between(after, before) {
  const a = isPosition(after) ? after : "";
  const b = isPosition(before) && before > a ? before : null;
  return midpoint(a, b);
}

// A chat from before places has no key and keeps today's order, newest first: its key
// is read from when it last changed, "z" and eight digits counting down from the largest
// time, then its id, so it sorts after every key `between` makes for a new chat and among
// its kind by time, newest first. The time and id come from the server, so it is the same
// on every device. The key is written down before the chat next changes (settle), so a
// new message never moves it.
const LATEST = 62 ** 8 - 1;
function countdown(at) {
  let n = Math.max(0, LATEST - Math.floor(at));
  let text = "";
  for (let i = 0; i < 8; i += 1) {
    text = DIGITS[n % 62] + text;
    n = Math.floor(n / 62);
  }
  return text;
}
export const positionOf = (chat) => (isPosition(chat.position) ? chat.position : `z${countdown(chat.updatedAt ?? 0)}${chat.id}V`);

// List order: by key, then by id where two keys are equal.
export const byPosition = (a, b) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// A new chat sorts first (5): a key before every chat's.
const firstPosition = (context) => {
  let min = null;
  for (const h of context.headings) {
    const p = positionOf(h);
    if (min === null || p < min) min = p;
  }
  return between(null, min);
};

// A chat about to change writes down the place it shows in now, so the change does not
// move it (5); the place then rides the chat's next save.
const settle = (context, chat) => {
  if (isPosition(chat.position)) return;
  chat.position = positionOf(chat);
  context.unsentPosition.add(chat.id);
  const index = context.headings.findIndex((h) => h.id === chat.id);
  if (index >= 0) context.headings = context.headings.map((h) => (h.id === chat.id ? { ...h, position: chat.position } : h));
};

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

// Python's whitespace (str.isspace), so a word here is a word of Python's `str.split()`
// and a script outside the browser can reproduce an excerpt exactly (7.2).
const SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const words = (text) => text.split(SPACE).filter((w) => w !== "");
const EXCERPT_WORDS = 30;

// A JSON pointer (RFC 6901) followed into a value; undefined when it leads nowhere.
export const pointAt = (value, pointer) => {
  if (pointer === "") return value;
  let at = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      at = at[Number(key)];
    } else if (at && typeof at === "object" && Object.prototype.hasOwnProperty.call(at, key)) at = at[key];
    else return undefined;
  }
  return at;
};

// The reply a stored result was made from, as far as its content still holds it: the
// compact JSON most replies become, or, for a reply whose one HTML field became
// markdown (convertReply), that field with its one other string field (a chapter's
// title) read back from the head before the first blank line. A result cut short of
// valid JSON gives nothing.
const replyOf = (content, replySchema) => {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // not JSON: perhaps a converted HTML reply
  }
  const htmlFields = [...htmlFieldNames(replySchema)];
  if (htmlFields.length !== 1) return null;
  const field = htmlFields[0];
  const branches = replySchema ? [replySchema, ...(replySchema.oneOf || []), ...(replySchema.anyOf || [])] : [];
  const branch = branches.find((b) => b && b.properties && b.properties[field]);
  const heads = Object.entries((branch && branch.properties) || {}).filter(([k, sub]) => k !== field && sub && sub.type === "string").map(([k]) => k);
  const gap = content.indexOf("\n\n");
  if (heads.length === 0) return { [field]: content };
  if (heads.length === 1 && gap >= 0) return { [heads[0]]: content.slice(0, gap), [field]: content.slice(gap + 2) };
  return null;
};

// What a lookup read, named from its result (7.2, 7.7): the string the tool entry's
// `name` points at, and the first 30 words of the one `excerpt` points at, each only
// when it holds a word. Computed whenever a result is announced, never stored, so a
// chat from before this still gets them; an error and a listing get neither.
export const lookupName = (result, entry) => {
  if (!entry || !entry.name || result.isError || typeof result.content !== "string") return {};
  const reply = replyOf(result.content, entry.reply);
  if (!reply) return {};
  const out = {};
  const name = pointAt(reply, entry.name);
  if (typeof name !== "string" || words(name).length === 0) return {};
  out.name = name;
  const text = entry.excerpt ? pointAt(reply, entry.excerpt) : undefined;
  if (typeof text === "string") {
    const first = words(text).slice(0, EXCERPT_WORDS);
    if (first.length) out.excerpt = first.join(" ");
  }
  return out;
};

// A tool result rides to views as its size, not its content (4.3): the content can
// be very large and conversation.changed is announced many times a second, so
// `conversations` keeps the content and sends only its length, with the name of what
// it read (lookupName). `targets` maps a call id to its "target: query".
const stripTurn = (turn, targets, entries) => {
  if (turn.role !== "user" || !turn.results) return turn;
  return {
    ...turn,
    results: turn.results.map((r) => {
      const out = { callId: r.callId, size: r.content != null ? r.content.length : r.size ?? 0 };
      if (r.isError !== undefined) out.isError = r.isError;
      return { ...out, ...lookupName(r, entries[targets.get(r.callId)]) };
    }),
  };
};

const callTargets = (turns) => {
  const targets = new Map();
  for (const t of turns) if (t.calls) for (const c of t.calls) targets.set(c.id, `${c.target}: ${c.name}`);
  return targets;
};

// Unsent comments are tracked apart from unsent turns: they are not a finished turn, so
// they do not make the chat pending, but a reload must still not replace them.
const hasUnsentMarks = (context, id) => context.unsentMarks.has(id);

const hasUnsent = (context, id) => {
  const chat = context.chats.get(id);
  return chat ? chat.turns.some((t) => context.unsent.has(t.id)) : false;
};

// The whole conversation as it rides the bus (4.3, third rule): results without
// their content, and pending while a finished turn is not yet on the server (5).
// The unsent comments are left out when there are none, as the schema has no null.
const changedPayload = (context, chat) => {
  const targets = callTargets(chat.turns);
  const payload = {
    type: "conversation.changed",
    id: chat.id,
    title: chat.title,
    about: chat.about,
    start: chat.start,
    turns: chat.turns.map((t) => stripTurn(t, targets, context.toolEntries)),
    pending: hasUnsent(context, chat.id),
    updatedAt: chat.updatedAt,
    subtitle: subtitleOf(latestAnswer(chat.turns)),
    position: positionOf(chat),
  };
  if (chat.marks) payload.marks = chat.marks;
  return payload;
};

// The read reply's conversation, shaped like the event minus the `type`.
const readShape = (context, chat) => {
  const { type, subtitle, position, ...rest } = changedPayload(context, chat);
  return rest;
};

const heading = (chat) => {
  const h = { id: chat.id, title: chat.title, about: chat.about, updatedAt: chat.updatedAt, subtitle: subtitleOf(latestAnswer(chat.turns)) };
  if (isPosition(chat.position)) h.position = chat.position;
  return h;
};

const emptyChat = (id) => ({ id, title: "", about: [], start: "", turns: [], updatedAt: 0, marks: null });

// The one answer the user may comment on: the chat's last turn when it is a finished
// answer with text and no lookups. Only this one, so everything sent before the next
// message stays byte for byte what the provider has cached (7.7).
export const lastAnswer = (chat) => {
  const last = chat && chat.turns[chat.turns.length - 1];
  if (!last || last.role !== "assistant" || last.status !== "done" || last.text.trim() === "") return null;
  if (last.calls && last.calls.length) return null;
  return last;
};

// What the model reads before a message that carries comments. The note is fixed text
// so the same comments always produce the same bytes and the cache holds; it says the
// numbers are the interface's, so the model does not start numbering its own answers.
const COMMENTS_OPEN = "<comments_on_your_last_answer>";
const COMMENTS_CLOSE = "</comments_on_your_last_answer>";
const COMMENTS_NOTE =
  "The user selected passages of your previous answer and commented on them. The\n" +
  "numbers were added by the interface to tie each comment to its passage. They are\n" +
  "not in your answer, you did not write them, and you should not number passages or\n" +
  "add notes like these in your own answers. Answer the comments as part of your reply.";
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const superscript = (n) => [...String(n)].map((d) => SUPERSCRIPT[Number(d)]).join("");

const occurrences = (text, quote) => {
  if (!quote) return 0;
  let count = 0;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + quote.length)) count += 1;
  return count;
};

// A quote that appears more than once does not say which place was meant, so the
// sentence around it is added: from the previous . ! ? or line break to the next one.
const sentenceAround = (text, start, end) => {
  let from = start;
  while (from > 0 && !/[.!?\n]/.test(text[from - 1])) from -= 1;
  let to = end;
  while (to < text.length && !/[.!?\n]/.test(text[to])) to += 1;
  if (to < text.length && text[to] !== "\n") to += 1;
  return text.slice(from, to).trim();
};

export const commentsBlock = (answerText, marks) => {
  if (!marks || !marks.length) return "";
  const ordered = [...marks].sort((a, b) => a.start - b.start || a.end - b.end);
  const entries = ordered.map((mark, i) => {
    const lines = [superscript(i + 1) + ' "' + mark.quote + '"'];
    if (occurrences(answerText, mark.quote) > 1) lines.push('In: "' + sentenceAround(answerText, mark.start, mark.end) + '"');
    lines.push("Comment: " + mark.comment);
    return lines.join("\n");
  });
  return COMMENTS_OPEN + "\n" + COMMENTS_NOTE + "\n\n" + entries.join("\n\n") + "\n" + COMMENTS_CLOSE;
};

// A completion.progressed `status` mapped to how the turn stores its end: a turn knows
// only done, stopped and failed, so refused and truncated are kept as failed with the
// reason in `error`.
const END_STATUS = { done: "done", stopped: "stopped", failed: "failed", refused: "failed", truncated: "failed" };

// Guards on the loop (7.7): a tool result is cut so one lookup cannot fill the
// request, and a question runs at most this many rounds of lookups.
const RESULT_CUT = 120000;
const MAX_ROUNDS = 8;

const cut = (text) => (text.length > RESULT_CUT ? text.slice(0, RESULT_CUT) + "\n\n[This result was cut off at 120,000 characters.]" : text);

// The five XML entities plus numeric character references, decoded for the markdown a
// chapter is converted to (below).
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });

// Convert a chapter's strict-XHTML fragment to plain markdown, so the model reads clean
// text rather than markup (7.7). Small on purpose: headings, paragraphs,
// emphasis, lists, block quotes, line breaks; a link becomes its text, an image its alt.
// Chapter files are strict XHTML, so tags are well formed and a light tokenizer suffices.
export const toMarkdown = (xhtml) => {
  const tokens = String(xhtml).split(/(<[^>]+>)/);
  const out = [];
  let buf = "";
  const list = []; // stack of { ordered, count } for nested lists
  let quoteDepth = 0;
  let headingLevel = 0;

  const flush = () => {
    // A <br/> was kept as a sentinel so it survives whitespace collapsing; it becomes a
    // hard line break, with the spaces around it dropped.
    const text = buf.replace(/[ \t\r\n]+/g, " ").replace(/ ?\u0000 ?/g, "\n").trim();
    buf = "";
    if (!text) return;
    let line;
    if (headingLevel) line = "#".repeat(headingLevel) + " " + text;
    else if (list.length) {
      const top = list[list.length - 1];
      line = "  ".repeat(list.length - 1) + (top.ordered ? `${top.count}. ` : "- ") + text;
    } else line = text;
    out.push((quoteDepth ? "> ".repeat(quoteDepth) : "") + line);
  };

  for (const tok of tokens) {
    if (!tok) continue;
    if (tok[0] !== "<") {
      buf += decodeEntities(tok);
      continue;
    }
    const match = /^<\s*(\/?)\s*([a-zA-Z0-9]+)/.exec(tok);
    if (!match) continue; // a comment, doctype or processing instruction
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    switch (tag) {
      case "br":
        buf += "\u0000";
        break;
      case "img":
        if (!closing) buf += `[image: ${/alt\s*=\s*"([^"]*)"/.exec(tok)?.[1] ?? /alt\s*=\s*'([^']*)'/.exec(tok)?.[1] ?? ""}]`;
        break;
      case "em":
      case "i":
        buf += "*";
        break;
      case "strong":
      case "b":
        buf += "**";
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        flush();
        headingLevel = closing ? 0 : Number(tag[1]);
        break;
      case "p":
      case "div":
        flush();
        break;
      case "blockquote":
        flush();
        quoteDepth = Math.max(0, quoteDepth + (closing ? -1 : 1));
        break;
      case "ul":
      case "ol":
        flush();
        if (closing) list.pop();
        else list.push({ ordered: tag === "ol", count: 1 });
        break;
      case "li":
        flush();
        if (closing && list.length) list[list.length - 1].count += 1;
        break;
      default:
        break; // a, span, code and the rest are transparent: their text stays, a link's target drops
    }
  }
  flush();
  return out.join("\n\n");
};

// The names of a reply's string fields marked as HTML (7.2), so the loop converts them
// to markdown (7.7). It looks at the top-level properties and inside each oneOf
// or anyOf branch, because a reply is often one of an answer or an error.
const htmlFieldNames = (schema) => {
  const names = new Set();
  const scan = (props) => {
    if (props) for (const [key, sub] of Object.entries(props)) if (sub && sub.contentMediaType === "text/html") names.add(key);
  };
  if (schema) {
    scan(schema.properties);
    for (const key of ["oneOf", "anyOf"]) if (Array.isArray(schema[key])) for (const branch of schema[key]) scan(branch.properties);
  }
  return names;
};

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
};

// What one tool result becomes for the model: an error reply as one plain line; a reply
// whose only large field is HTML sent as that markdown under its other short fields; any
// other reply as compact JSON with sorted keys (7.7), so the same bytes go back
// each round and the provider's cache holds (7.7).
const convertReply = (reply, replySchema) => {
  if (reply && reply.error !== undefined) return `This lookup returned an error: ${reply.error}.`;
  const htmlFields = htmlFieldNames(replySchema);
  const converted = {};
  const convertedKeys = [];
  for (const [key, value] of Object.entries(reply || {})) {
    if (htmlFields.has(key) && typeof value === "string") {
      converted[key] = toMarkdown(value);
      convertedKeys.push(key);
    } else converted[key] = value;
  }
  if (convertedKeys.length === 1) {
    const only = convertedKeys[0];
    const heads = Object.entries(converted)
      .filter(([k]) => k !== only)
      .map(([, v]) => v)
      .filter((v) => typeof v === "string");
    return (heads.length ? heads.join(" — ") + "\n\n" : "") + converted[only];
  }
  return JSON.stringify(sortKeys(converted));
};

// The tool list a question is asked with, and the per-tool metadata the loop keeps: the
// queries the owners marked as tools (7.7), sorted by name so the provider caches a
// stable order, each carrying its payload schema (sent to the model) and its reply
// schema and label (kept for converting results and naming the lookup). A tool the user
// keeps off (7.7) is kept in the metadata but left out of what is offered.
const buildTools = (context, reply) => {
  const queries = (reply && reply.queries) || [];
  const meta = {};
  const offered = [];
  for (const q of queries) {
    if (!q.tool) continue;
    const key = `${q.target}: ${q.name}`;
    meta[key] = { label: q.tool.label, reply: q.reply, name: q.tool.name, excerpt: q.tool.excerpt };
    if (context.tools[key] === false) continue;
    offered.push({ key, target: q.target, name: q.name, description: q.tool.description, payload: q.payload });
  }
  offered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { tools: offered.map(({ target, name, description, payload }) => ({ target, name, description, payload })), meta };
};

// A stored call always carries a label (the turn shape requires it). A recognised tool
// gets its owner's label; a call the catalog does not list (the server marked it invalid)
// gets the literal tool name the model asked for — a fact, not a made-up activity — and
// the view does not show it as a lookup in progress.
const withLabel = (call, meta) => {
  const key = `${call.target}: ${call.name}`;
  const entry = meta && meta[key];
  const out = { id: call.id, target: call.target, name: call.name, payload: call.payload, label: (entry && entry.label) || key };
  if (call.invalid !== undefined) out.invalid = call.invalid;
  return out;
};

// The finished assistant turn from the final completion.progressed: `raw` and the tool
// calls only on done (raw is kept so the same model is replayed what it produced, and a
// call must not run when the answer did not truly finish), the reason in `error` for
// refused and truncated, and a truncated turn's calls dropped, because a cut-off call
// must never run.
const finalize = (turn, e, meta) => {
  const t = { id: turn.id, role: "assistant", text: e.text, status: END_STATUS[e.status] || "failed" };
  if (turn.at !== undefined) t.at = turn.at;
  if (e.thinking) t.thinking = e.thinking;
  else if (turn.thinking) t.thinking = turn.thinking;
  if (e.status === "done") {
    if (e.raw !== undefined) t.raw = e.raw;
    for (const field of ["provider", "model", "usage"]) if (e[field] !== undefined) t[field] = e[field];
    if (e.calls && e.calls.length) t.calls = e.calls.map((c) => withLabel(c, meta));
  }
  if (e.status === "refused") t.error = "refused";
  else if (e.status === "truncated") t.error = "truncated";
  else if (e.error !== undefined) t.error = e.error;
  return t;
};

// What is sent to the model: an empty or still pending assistant turn is left out. A done
// answer keeps its `raw` (so the same model replays its own content, thinking blocks
// unchanged) unless it carries tool calls nobody answered — those `raw` and `calls` hold
// tool_use blocks that demand results, so an unanswered round is sent as text alone; the
// calls go back only when the next turn holds their results. User turns carry their
// results with content. A user turn with comments is sent as the comments block, then its
// own text; the stored turn keeps the two apart and the answer they are about is sent
// unchanged, so the provider's cache still holds everything before this turn.
export const forModel = (turns) => {
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === "user") {
      let text = turn.text;
      if (turn.marks && turn.marks.length) {
        let prev = null;
        for (let j = i - 1; j >= 0 && !prev; j--) if (turns[j].role === "assistant") prev = turns[j];
        const block = commentsBlock(prev ? prev.text : "", turn.marks);
        text = block + (turn.text ? "\n\n" + turn.text : "");
      }
      const u = { id: turn.id, role: "user", text };
      if (turn.at !== undefined) u.at = turn.at;
      if (turn.results && turn.results.length)
        u.results = turn.results.map((r) => {
          const rr = { callId: r.callId, content: r.content ?? "" };
          if (r.isError !== undefined) rr.isError = r.isError;
          return rr;
        });
      out.push(u);
    } else {
      if (turn.status === "pending") continue;
      const next = turns[i + 1];
      const hasCalls = Boolean(turn.calls && turn.calls.length);
      const answeredCalls = Boolean(hasCalls && next && next.role === "user" && next.results && next.results.length);
      const unansweredCalls = hasCalls && !answeredCalls;
      if (!turn.text && !answeredCalls) continue;
      const a = { id: turn.id, role: "assistant", text: turn.text, status: turn.status };
      if (turn.at !== undefined) a.at = turn.at;
      if (answeredCalls) a.calls = turn.calls;
      if (!unansweredCalls) {
        if (turn.raw !== undefined) a.raw = turn.raw;
        for (const field of ["provider", "model", "usage"]) if (turn[field] !== undefined) a[field] = turn[field];
      }
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
  for (const chat of context.chats.values()) if (chat.turns.some((t) => context.unsent.has(t.id)) || hasUnsentMarks(context, chat.id)) ids.add(chat.id);
  for (const id of context.unsentPosition) ids.add(id);
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

// The comments are last write wins on the server, so only one save carrying them is in
// flight per chat: two could land out of order and leave the older list stored. A change
// made meanwhile is sent when that save comes back (onSaved).
// A place is last write wins too, so it follows the same rule: one save carrying it in
// flight per chat. A chat not in memory (moved from the list) is sent its place alone.
const fireSave = (context, self, chatId) => {
  const chat = context.chats.get(chatId);
  const turns = chat ? chat.turns.filter((t) => context.unsent.has(t.id)) : [];
  const sendMarks = Boolean(chat) && hasUnsentMarks(context, chatId) && !context.marksInFlight.has(chatId);
  // A save that changes the chat bumps its time on the server, so its place is written
  // down first (settle).
  if (chat && (turns.length || sendMarks)) settle(context, chat);
  const sendPosition = context.unsentPosition.has(chatId) && !context.positionInFlight.has(chatId);
  if (!turns.length && !sendMarks && !sendPosition) return;
  const body = chat && (turns.length || sendMarks) ? { title: chat.title, about: chat.about, start: chat.start, turns } : {};
  const marks = sendMarks ? chat.marks ?? null : undefined;
  if (sendMarks) {
    body.marks = chat.marks ?? null;
    context.marksInFlight.add(chatId);
  }
  const position = sendPosition ? context.headings.find((h) => h.id === chatId)?.position ?? chat?.position : undefined;
  if (sendPosition && isPosition(position)) {
    body.position = position;
    context.positionInFlight.add(chatId);
  } else if (!turns.length && !sendMarks) {
    context.unsentPosition.delete(chatId);
    return;
  }
  const sentPosition = body.position !== undefined;
  const turnIds = turns.map((t) => t.id);
  context
    .saveChat(chatId, body)
    .then((r) =>
      self.send({ type: "_saved", chatId, turnIds, sendMarks, marks, sendPosition: sentPosition, position, missing: Boolean(r && r.missing), updatedAt: r ? r.updatedAt : undefined }),
    )
    .catch(() => self.send({ type: "_saveFailed", chatId, sendMarks, sendPosition: sentPosition }));
};

// A title is last write wins (5), so one rename is in flight per chat; a title changed
// meanwhile is sent when it comes back (_renamed). The links ride along, because a save
// that names a chat without them would leave it with none.
const fireRename = (context, self, id) => {
  if (context.titleInFlight.has(id) || !context.renaming.has(id)) return;
  const title = context.renaming.get(id);
  const about = context.chats.get(id)?.about ?? context.headings.find((h) => h.id === id)?.about ?? [];
  context.titleInFlight.add(id);
  context
    .saveChat(id, { rename: true, title, about })
    .then((r) => self.send({ type: "_renamed", id, title, missing: Boolean(r && r.missing) }))
    .catch(() => self.send({ type: "_renameFailed", id }));
};

const onRenamed = (context, event, enqueue, self) => {
  context.titleInFlight.delete(event.id);
  // A chat the server does not have yet gets its title with its first turns (fireSave).
  if (event.missing || context.renaming.get(event.id) === event.title) context.renaming.delete(event.id);
  else enqueue(() => fireRename(context, self, event.id));
};

// The comments go away when a new answer starts: sent with the message, or dropped by
// Continue. The server is told too, so a reload does not bring them back.
const clearMarks = (context, chat) => {
  if (!chat.marks) return;
  chat.marks = null;
  context.unsentMarks.add(chat.id);
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

// The tool list is gathered once per question (7.7) from the catalog, then reused for
// every round, because the tools are part of what the provider caches.
const fireContracts = (context, self, turnId) => {
  context
    .contracts()
    .then((reply) => self.send({ type: "_contracts", turnId, reply }))
    .catch(() => self.send({ type: "_contracts", turnId, reply: {} }));
};

// Run one round of lookups: a tool is one of the system's own queries (7.7), so each
// call asks that query through the bus, all together. A call the server marked invalid
// is not asked; it is answered with an error result. Each reply is converted to what the
// model reads and cut to the guard length.
const runCall = async (context, call, meta) => {
  if (call.invalid) return { callId: call.id, content: `This tool could not be used: ${call.invalid}.`, isError: true };
  let reply;
  try {
    reply = await context.askTool(call.target, call.name, call.payload);
  } catch {
    reply = { error: "unavailable" };
  }
  const entry = meta && meta[`${call.target}: ${call.name}`];
  const result = { callId: call.id, content: cut(convertReply(reply, entry && entry.reply)) };
  if (reply && reply.error !== undefined) result.isError = true;
  return result;
};

const fireLookups = (context, self, chatId, calls, meta) => {
  Promise.all(calls.map((call) => runCall(context, call, meta)))
    .then((results) => self.send({ type: "_lookups", chatId, results }))
    .catch(() => self.send({ type: "_lookups", chatId, results: calls.map((c) => ({ callId: c.id, content: "This lookup failed.", isError: true })) }));
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
    // A new chat goes first (5); a listed chat not yet read keeps its place. The place
    // rides the first save.
    const listed = context.headings.find((h) => h.id === conversationId);
    chat = { id: conversationId, title: firstLine(turn.text), about: about ?? [], start: start ?? "", turns: [], updatedAt: context.now(), marks: null, position: listed ? positionOf(listed) : firstPosition(context) };
    if (!listed || !isPosition(listed.position)) context.unsentPosition.add(conversationId);
    context.chats.set(conversationId, chat);
  }
  const userTurn = { id: turn.id, role: "user", text: turn.text, at: context.now() };
  const answered = lastAnswer(chat);
  if (answered && chat.marks && chat.marks.answerId === answered.id && chat.marks.marks.length) userTurn.marks = chat.marks.marks;
  clearMarks(context, chat);
  chat.turns.push(userTurn);
  const answerId = context.ulid();
  chat.turns.push({ id: answerId, role: "assistant", text: "", status: "pending", at: context.now() });
  context.running = { chatId: conversationId, turnId: answerId, phase: "contracts", tools: [], meta: {}, rounds: 0 };
  setOpen(context, enqueue, conversationId);
  context.unsent.add(turn.id); // the user turn is finished the moment it is sent (5)
  upsertHeading(context, chat);
  enqueue(() => fireSave(context, self, conversationId));
  enqueue(() => fireContracts(context, self, answerId)); // gather the tool list, then ask the model
  enqueue.emit(changedPayload(context, chat));
};

// Continue after an interruption, losing nothing that was completed (5). Two endings ask
// the model again: the chat ends at the reader's question (case a), or it ends at a done
// answer that carries lookups nobody ran yet (case b, after a reload or a Stop during a
// round). Both append the pending answer and gather the tool list; `proceed` then runs
// the pending lookups or asks the model.
const onContinue = (context, event, enqueue, self) => {
  const chat = context.chats.get(event.conversationId);
  if (!chat) return;
  const last = chat.turns[chat.turns.length - 1];
  if (!last) return;
  const endsAtQuestion = last.role === "user";
  const endsAtUnrunCalls = last.role === "assistant" && last.status === "done" && Boolean(last.calls && last.calls.length);
  if (!endsAtQuestion && !endsAtUnrunCalls) return;
  clearMarks(context, chat);
  if (hasUnsentMarks(context, chat.id)) enqueue(() => fireSave(context, self, chat.id));
  const answerId = context.ulid();
  chat.turns.push({ id: answerId, role: "assistant", text: "", status: "pending", at: context.now() });
  context.running = { chatId: chat.id, turnId: answerId, phase: "contracts", tools: [], meta: {}, rounds: 0 };
  enqueue(() => fireContracts(context, self, answerId));
  enqueue.emit(changedPayload(context, chat));
};

// The tool list has arrived (or the catalog was unavailable, so there are no tools). With
// it in hand, either run the lookups the answer before the pending turn is waiting on
// (Continue, case b) or ask the model.
const onContracts = (context, event, enqueue, self) => {
  if (!context.running || context.running.turnId !== event.turnId) return; // stale: stopped or superseded
  const chat = context.chats.get(context.running.chatId);
  if (!chat) return;
  const { tools, meta } = buildTools(context, event.reply);
  context.running.tools = tools;
  context.running.meta = meta;
  if (Object.keys(meta).length) context.toolEntries = meta;
  const answerId = context.running.turnId;
  const prior = chat.turns[chat.turns.length - 2]; // the turn before the pending answer
  if (prior && prior.role === "assistant" && prior.calls && prior.calls.length) {
    context.running.phase = "lookups";
    enqueue(() => fireLookups(context, self, chat.id, prior.calls, meta));
  } else {
    context.running.phase = "model";
    enqueue(() => fireComplete(context, self, answerId, { id: answerId, start: chat.start, turns: forModel(chat.turns), tools }));
  }
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
  const running = context.running && context.running.turnId === event.id ? context.running : null;
  const finished = finalize(chat.turns[index], event, running ? running.meta : {});
  chat.turns[index] = finished;
  context.unsent.add(finished.id);
  settle(context, chat);
  chat.updatedAt = context.now();
  upsertHeading(context, chat);

  const calls = running && finished.status === "done" && finished.calls ? finished.calls : null;
  if (calls && calls.length) {
    if (running.rounds >= MAX_ROUNDS) {
      // Too many rounds for this question (7.7): keep the answer and its calls, run nothing,
      // and end the chat with a short failed turn the view names in plain words. The count
      // lives on `running` and resets each question, so a long chat is never cut short for
      // lookups an earlier question made.
      const failId = context.ulid();
      chat.turns.push({ id: failId, role: "assistant", text: "", status: "failed", error: "too-many-lookups", at: context.now() });
      context.unsent.add(failId);
      context.running = null;
      enqueue(() => fireSave(context, self, chat.id));
      enqueue.emit(changedPayload(context, chat));
      return;
    }
    // Run a round: save the done answer, append the next pending answer, keep `running`
    // set for the whole round (so the focus reload does not replace memory mid-round) and
    // count the round, and ask the lookups. Send stays Stop for the reader with no change
    // to `chat-input`.
    const nextId = context.ulid();
    chat.turns.push({ id: nextId, role: "assistant", text: "", status: "pending", at: context.now() });
    context.running = { ...running, turnId: nextId, phase: "lookups", rounds: running.rounds + 1 };
    enqueue(() => fireSave(context, self, chat.id));
    enqueue(() => fireLookups(context, self, chat.id, finished.calls, context.running.meta));
    enqueue.emit(changedPayload(context, chat));
    return;
  }
  // A plain end: the answer is finished.
  if (running) context.running = null;
  enqueue(() => fireSave(context, self, chat.id));
  enqueue.emit(changedPayload(context, chat));
};

// A round's lookups have all replied. Insert the user turn holding their results before
// the pending answer (so memory reads answer, results, pending answer, which is also the
// order the three are saved in), save it, and ask the model again.
const onLookups = (context, event, enqueue, self) => {
  const chat = context.chats.get(event.chatId);
  const running = context.running;
  if (!chat || !running || running.chatId !== event.chatId || running.phase !== "lookups") return; // stale: stopped
  const pendingIndex = chat.turns.length - 1;
  const pending = chat.turns[pendingIndex];
  if (!pending || pending.id !== running.turnId) return;
  const userTurn = { id: context.ulid(), role: "user", text: "", results: event.results, at: context.now() };
  chat.turns.splice(pendingIndex, 0, userTurn);
  context.unsent.add(userTurn.id);
  settle(context, chat);
  chat.updatedAt = context.now();
  upsertHeading(context, chat);
  running.phase = "model";
  enqueue(() => fireSave(context, self, chat.id));
  enqueue(() => fireComplete(context, self, running.turnId, { id: running.turnId, start: chat.start, turns: forModel(chat.turns), tools: running.tools }));
  enqueue.emit(changedPayload(context, chat));
};

// Stop (12). While the model streams, `llm` owns Stop and its completion.progressed
// (status stopped) ends the turn above, so `conversations` leaves that alone. Between
// rounds — while a lookup runs or the tool list is being gathered — `llm` is not
// running, so `conversations` ends the round itself: forget it (late replies are then
// ignored) and drop the never-saved pending turn. The chat rests at the done answer with
// its unrun calls, which Continue resumes (case b), the same state a reload would leave.
const onStop = (context, event, enqueue) => {
  const running = context.running;
  if (!running || running.turnId !== event.turnId || running.phase === "model") return;
  const chat = context.chats.get(running.chatId);
  context.running = null;
  if (!chat) return;
  const last = chat.turns[chat.turns.length - 1];
  if (last && last.role === "assistant" && last.status === "pending" && last.id === event.turnId) {
    chat.turns.pop();
    enqueue.emit(changedPayload(context, chat));
  }
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
  if (context.running && context.running.turnId === event.turnId) context.running = null;
  context.unsent.add(chat.turns[index].id);
  settle(context, chat);
  chat.updatedAt = context.now();
  upsertHeading(context, chat);
  enqueue(() => fireSave(context, self, chat.id));
  enqueue.emit(changedPayload(context, chat));
};

// Give a chat in memory its new title, list it under it and send it; false when the
// title is the one it has.
const retitle = (context, chat, text, enqueue, self) => {
  const title = titled(chat, text);
  if (title === chat.title) return false;
  chat.title = title;
  context.headings = context.headings.map((h) => (h.id === chat.id ? { ...h, title } : h));
  context.renaming.set(chat.id, title);
  enqueue(() => fireRename(context, self, chat.id));
  return true;
};

// A chat's title from the chat-title generator (generation.changed) or from the user
// (conversation.renamed). A chat only listed is read first, so a blank title can find the
// first message and the change is announced with the whole chat (4.3, third rule). A
// title it already has changes nothing, so a result pulled from another device that
// already named the chat costs no read.
const onTitle = (context, id, text, enqueue, self) => {
  const chat = context.chats.get(id);
  if (chat) {
    if (retitle(context, chat, text, enqueue, self)) enqueue.emit(changedPayload(context, chat));
    return;
  }
  const listed = context.headings.find((h) => h.id === id);
  if (!listed || ((text ?? "").trim() !== "" && listed.title === text.trim())) return;
  context.retitle.set(id, text);
  enqueue(() => fireLoad(context, self, id));
};

const onSelect = (context, event, enqueue, self) => {
  setOpen(context, enqueue, event.id);
  if (event.id != null && !context.chats.has(event.id) && context.headings.some((h) => h.id === event.id))
    enqueue(() => fireLoad(context, self, event.id));
};

// The user's comments on the last answer (marks.edited carries the whole list). A list for
// any other answer is ignored, since only the last one may be commented on (lastAnswer).
const onMarksEdited = (context, event, enqueue, self) => {
  const chat = context.chats.get(event.conversationId);
  const answered = lastAnswer(chat);
  if (!answered || answered.id !== event.answerId) return;
  chat.marks = event.marks.length ? { answerId: event.answerId, marks: event.marks } : null;
  context.unsentMarks.add(chat.id);
  enqueue(() => fireSave(context, self, chat.id));
  enqueue.emit(changedPayload(context, chat));
};

const onDiscard = (context, event, enqueue) => {
  const { id } = event;
  const chat = context.chats.get(id);
  context.unsentMarks.delete(id);
  context.unsentPosition.delete(id);
  if (chat) for (const turn of chat.turns) context.unsent.delete(turn.id);
  context.chats.delete(id);
  context.headings = context.headings.filter((h) => h.id !== id);
  if (context.openId === id) setOpen(context, enqueue, null);
  enqueue(() => context.deleteChat(id).catch(() => {}));
  enqueue.emit({ type: "conversation.deleted", id });
};

// The user moved a chat in the list (conversation-list emits conversation.moved, 4.3
// fifth rule): it takes a key between its new neighbours'. A place is last write wins (5):
// it is saved alone, changes no time, and never conflicts. A chat in memory is announced
// with its new place; one that is not is only listed in it, since its turns are not here
// to announce.
const onMoved = (context, event, enqueue, self) => {
  const current = context.headings.find((h) => h.id === event.id);
  if (!current) return;
  const neighbour = (id) => {
    const h = id && id !== event.id ? context.headings.find((x) => x.id === id) : null;
    return h ? positionOf(h) : null;
  };
  const position = between(neighbour(event.after), neighbour(event.before));
  if (position === current.position) return;
  context.headings = context.headings.map((h) => (h.id === event.id ? { ...h, position } : h));
  const chat = context.chats.get(event.id);
  if (chat) chat.position = position;
  context.unsentPosition.add(event.id);
  enqueue(() => fireSave(context, self, event.id));
  if (chat) enqueue.emit(changedPayload(context, chat));
};

const onToolsEdited = (context, event, enqueue) => {
  if (event.tools) context.tools = { ...context.tools, ...event.tools };
  if (event.approval) context.approval = event.approval;
  const value = { tools: context.tools, approval: context.approval };
  enqueue(() => context.saveTools(value).catch(() => {}));
  enqueue.emit({ type: "tools.changed", ...value });
};

// A chat has a message once it is listed or holds a turn; a new chat's id has neither
// until its first message is sent (onSubmit adds both).
const hasMessages = (context, id) =>
  context.headings.some((h) => h.id === id) || (context.chats.get(id)?.turns.length ?? 0) > 0;

const onSubjectChanged = (context, event, enqueue, self) => {
  const sub = event.subject ? { kind: event.subject.kind, id: event.subject.id } : null;
  if (sameSubject(sub, context.lastSubject)) return;
  const settling = context.lastSubject == null;
  context.lastSubject = sub;
  // A pinned open chat stays whatever comes on the stage (12); the chat learns of it only
  // from what is added later, never from a change to its start (14). A chat with no
  // message yet is not kept by its pin, which is unavailable: it follows the stage, except
  // while the subject first settles after a reload, so the new chat the reader had open
  // is still the one shown.
  if (context.pin != null && context.pin === context.openId && hasMessages(context, context.openId)) return;
  if (settling && context.openId != null && !hasMessages(context, context.openId)) return;
  // The chat already open, if it is about the new subject, stays open (12): a reader who
  // picked an older chat about the book must not have it replaced by the newest one when
  // the subject settles after a reload (the subject can arrive as a late change from none
  // to the book). Only when the open chat is not about the new subject does the open chat
  // become the most recent chat about it, or none.
  const openHeading = context.headings.find((h) => h.id === context.openId);
  if (openHeading && aboutMatch(openHeading.about, sub)) return;
  const next = mostRecentAbout(context.headings, sub);
  if (next === context.openId) return;
  setOpen(context, enqueue, next);
  if (next != null && !context.chats.has(next)) enqueue(() => fireLoad(context, self, next));
};

const answerList = (context, reply) => {
  if (context.unavailable) return reply({ error: "unavailable" });
  const conversations = context.headings
    .map((h) => ({ id: h.id, title: h.title, about: h.about, updatedAt: h.updatedAt, pending: hasUnsent(context, h.id), subtitle: h.subtitle ?? "", position: positionOf(h) }))
    .sort(byPosition);
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

const onLoaded = (context, event, enqueue, self) => {
  context.loading.delete(event.id);
  const c = event.conversation;
  const chat = { id: c.id, title: c.title, about: c.about ?? [], start: c.start ?? "", turns: c.turns ?? [], updatedAt: c.updatedAt ?? 0, marks: c.marks ?? null };
  // The place this device holds wins over the server's while a move is unsent (5).
  const held = context.headings.find((h) => h.id === event.id)?.position;
  const position = context.unsentPosition.has(event.id) || !isPosition(c.position) ? held : c.position;
  if (isPosition(position)) chat.position = position;
  // A title not yet on the server is the latest write; one waiting for this read is given now.
  if (context.renaming.has(event.id)) chat.title = context.renaming.get(event.id);
  context.chats.set(event.id, chat);
  if (context.retitle.has(event.id)) {
    const text = context.retitle.get(event.id);
    context.retitle.delete(event.id);
    retitle(context, chat, text, enqueue, self);
  }
  upsertHeading(context, chat);
  const waiting = context.reading.get(event.id);
  if (waiting) {
    for (const reply of waiting) reply({ conversation: readShape(context, chat) });
    context.reading.delete(event.id);
  }
  enqueue.emit(changedPayload(context, chat));
  if (!context.entriesAsked && !Object.keys(context.toolEntries).length && hasResults(chat)) {
    context.entriesAsked = true;
    enqueue(() => fireToolEntries(context, self));
  }
};

// A chat from before this page's first question is announced with what its lookups
// read (lookupName), which needs the tool entries; they come from the catalog with the
// tool list, so the first chat loaded with results asks for them once, and the loaded
// chats are announced again when they arrive.
const hasResults = (chat) => chat.turns.some((t) => t.results && t.results.length);

const fireToolEntries = (context, self) => {
  if (!context.contracts) return;
  context
    .contracts()
    .then((reply) => self.send({ type: "_toolEntries", reply }))
    .catch(() => self.send({ type: "_toolEntries", reply: {} }));
};

const onToolEntries = (context, event, enqueue) => {
  const { meta } = buildTools(context, event.reply);
  if (!Object.keys(meta).length) {
    context.entriesAsked = false; // the catalog was unavailable: ask again with the next chat
    return;
  }
  context.toolEntries = meta;
  for (const chat of context.chats.values()) if (hasResults(chat)) enqueue.emit(changedPayload(context, chat));
};

const onLoadFailed = (context, event) => {
  context.loading.delete(event.id);
  context.retitle.delete(event.id);
  const held = context.reading.get(event.id);
  if (held) {
    for (const reply of held) reply({ error: "unavailable" });
    context.reading.delete(event.id);
  }
};

const onSaved = (context, event, enqueue, self) => {
  for (const turnId of event.turnIds) context.unsent.delete(turnId);
  const chat = context.chats.get(event.chatId);
  if (event.sendPosition) {
    context.positionInFlight.delete(event.chatId);
    // Only the place that was sent is now on the server; one moved meanwhile goes next.
    // A chat the server never had has nothing to place.
    const now = context.headings.find((h) => h.id === event.chatId)?.position ?? chat?.position;
    if (event.missing || !context.unsentPosition.has(event.chatId) || now === event.position) context.unsentPosition.delete(event.chatId);
    else enqueue(() => fireSave(context, self, event.chatId));
  }
  if (event.sendMarks) {
    context.marksInFlight.delete(event.chatId);
    // Only the list that was sent is now on the server; one changed meanwhile goes next.
    if (!chat || (chat.marks ?? null) === event.marks) context.unsentMarks.delete(event.chatId);
    else enqueue(() => fireSave(context, self, chat.id));
  }
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
  // A place this device moved and has not sent yet is the latest write (5).
  const local = new Map(context.headings.map((h) => [h.id, h]));
  const placed = (h) => {
    const mine = local.get(h.id);
    const kept = mine && context.unsentPosition.has(h.id) && isPosition(mine.position) ? { ...h, position: mine.position } : h;
    return context.renaming.has(h.id) ? { ...kept, title: context.renaming.get(h.id) } : kept;
  };
  context.headings = [...result.conversations.map(fromServer).map(placed), ...keptLocal];
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
  // never be sent (5: nothing that was completed is lost). A round in flight (running) is
  // not reloaded either, so it is not replaced under itself. Retry the save instead.
  if (context.openId != null && !context.running && !hasUnsent(context, context.openId) && !hasUnsentMarks(context, context.openId) && context.headings.some((h) => h.id === context.openId))
    enqueue(() => fireLoad(context, self, context.openId));
  for (const chatId of chatsWithUnsent(context)) enqueue(() => fireSave(context, self, chatId));
  for (const id of context.renaming.keys()) enqueue(() => fireRename(context, self, id));
};

const onOnline = (context, enqueue, self) => {
  for (const chatId of chatsWithUnsent(context)) enqueue(() => fireSave(context, self, chatId));
  for (const id of context.renaming.keys()) enqueue(() => fireRename(context, self, id));
};

// The boot picture: who is signed in decides whether the server is read at all (3.4);
// signed in, the chats and the tool preferences are loaded and the subject read for
// the starting open chat (12). A failed list is reported so `list`/`read` answer
// unavailable. Missing session or subject askers (a Node test) are treated as absent.
// A re-boot that changes which chat is open announces it, as setOpen does, so the views
// let go of the last account's chat (12); the first boot is the starting picture the
// views ask for (4.3), so it announces nothing.
const applyBoot = (context, out, enqueue, self) => {
  const before = context.openId;
  const base = { chats: new Map(), unsent: new Set(), unsentMarks: new Set(), marksInFlight: new Set(), unsentPosition: new Set(), positionInFlight: new Set(), renaming: new Map(), titleInFlight: new Set(), retitle: new Map(), reading: new Map(), loading: new Set(), running: null };
  if (out.userId == null) {
    Object.assign(context, base, { userId: null, signedIn: false, unavailable: false, headings: [], openId: null, lastSubject: null, tools: {}, approval: "auto" });
  } else if (out.failed) {
    Object.assign(context, base, { userId: out.userId, signedIn: true, unavailable: true, headings: [], openId: context.store.read(), lastSubject: null, tools: {}, approval: "auto" });
  } else {
    const headings = (out.list.conversations || []).map(fromServer);
    const toolsValue = out.list.tools || {};
    const sub = out.subject ? { kind: out.subject.kind, id: out.subject.id } : null;
    const stored = context.store.read();
    const openId = stored != null ? stored : mostRecentAbout(headings, sub);
    Object.assign(context, base, { userId: out.userId, signedIn: true, unavailable: false, headings, openId, lastSubject: sub, tools: toolsValue.tools || {}, approval: toolsValue.approval || "auto" });
  }
  if (context.booted && context.openId !== before) enqueue.emit({ type: "conversation.opened", id: context.openId });
  context.booted = true;
  if (!context.pinsObserved) context.pin = out.pin ?? null;
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
    // The pinned chat is asked beside them; pins.changed is held for us until that reply
    // lands (pins: read supersededBy).
    boot: fromPromise(async ({ input }) => {
      const pinsReply = input.pins ? input.pins().catch(() => ({})) : Promise.resolve({});
      const pinOf = async () => {
        const pins = await pinsReply;
        return typeof pins?.chat === "string" ? pins.chat : null;
      };
      const session = await input.session();
      const userId = session ? session.userId ?? null : null;
      if (userId == null) return { userId: null, pin: await pinOf() };
      let list;
      try {
        list = await input.list();
      } catch {
        return { userId, failed: true, pin: await pinOf() };
      }
      const subjectReply = await input.subject().catch(() => ({}));
      return { userId, list, subject: subjectReply && subjectReply.subject ? subjectReply.subject : null, pin: await pinOf() };
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
    description:
      "Owns the chats: each chat's links, its start, its turns, which chat is open on this " +
      "device, and which lookups the model may use. Every turn needs the model, so a chat " +
      "cannot be written offline; each finished turn goes to the server at once and the server " +
      "adds turns by id, so a resend is harmless and another device sees every turn, while an " +
      "answer still arriving when the page closes is lost and Continue asks again. It runs the " +
      "lookup loop (7.7): when an answer asks to look something up it asks that query, stores " +
      "the result, and asks the model again, at most eight rounds per question, each result cut " +
      "at 120,000 characters. A chat's start is written once, by the view where the chat was " +
      "created, and never changes. When the subject changes the open chat becomes the most " +
      "recently updated chat about it, or none, so the panel shows an empty new chat; while " +
      "the open chat is pinned, as `pins` says, it stays open whatever the subject, once it has " +
      "its first message; a new chat with none follows the subject like an unpinned one. " +
      "The user's comments on the last finished answer are kept with the chat until the next " +
      "message, which carries them; the model gets them as quotes before the message, and the " +
      "answer itself is never changed, so the provider's cache holds. Each chat has a place " +
      "in the list, kept on the account and the same on every device: a new chat goes first, " +
      "a new message never moves a chat, and a move from the list puts it between its new " +
      "neighbours. A place is last write wins and changes nothing else. A chat from before " +
      "places keeps the order it had, newest first, until it changes or is moved. A delete " +
      "handed to the corner notice happens when that notice's undo window ends. A chat is " +
      "titled at first with the first line of its first message; the chat-title generator's " +
      "text replaces it, and so does a title the user types in the list, where an empty one " +
      "gives the first line back. A rename keeps the chat's links and its place and does not " +
      "count as news, so it never makes a chat the latest about its subject.",
    kind: "fact",
    shape: "remote-only",
    owns: "the chats",
    emits: ["conversation.changed", "conversation.deleted", "conversation.opened", "tools.changed"],
    // `*: tool` lets the loop ask any query its owner marked as a tool (7.7).
    asks: ["session: read", "subject: read", "pins: read", "llm: complete", "catalog: contracts", "*: tool"],
  },
  context: ({ input }) => ({
    session: input.session,
    subject: input.subject,
    pins: input.pins,
    complete: input.complete,
    contracts: input.contracts,
    askTool: input.askTool,
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
    unsentMarks: new Set(), // chat ids whose comments the server does not have yet
    marksInFlight: new Set(), // chat ids with a save carrying comments on its way
    unsentPosition: new Set(), // chat ids whose place the server does not have yet (5)
    positionInFlight: new Set(), // chat ids with a save carrying a place on its way
    renaming: new Map(), // chat id -> a title the server does not have yet (5)
    titleInFlight: new Set(), // chat ids with a rename on its way
    retitle: new Map(), // chat id -> a title waiting for the chat to be read
    reading: new Map(), // id -> [reply]; read replies held while a chat loads
    loading: new Set(),
    openId: null,
    booted: false,
    lastSubject: null,
    // The chat `pins` holds pinned, and whether pins.changed came before the boot reply,
    // which is then the older picture.
    pin: null,
    pinsObserved: false,
    tools: {},
    approval: "auto",
    toolEntries: {}, // "target: query" -> { label, reply, name, excerpt }, from the catalog (7.7)
    entriesAsked: false,
    running: null, // { chatId, turnId, phase, tools, meta, rounds } while a question is being answered
    queued: [],
  }),
  initial: "loading",
  // `pins`' news (4.3, fourth rule), in any state.
  on: {
    "pins.changed": {
      actions: ({ context, event }) => {
        context.pin = event.chat ?? null;
        context.pinsObserved = true;
      },
    },
    _toolEntries: { actions: enqueueActions(({ context, event, enqueue }) => onToolEntries(context, event, enqueue)) },
  },
  states: {
    loading: {
      invoke: {
        src: "boot",
        input: ({ context }) => ({ session: context.session, list: context.list, subject: context.subject, pins: context.pins }),
        onDone: { target: "ready", actions: enqueueActions(({ context, event, enqueue, self }) => applyBoot(context, event.output, enqueue, self)) },
        onError: { target: "ready", actions: enqueueActions(({ context, enqueue, self }) => applyBoot(context, { userId: null }, enqueue, self)) },
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
        "conversation.moved": { actions: queue },
        "removal.settled": { guard: ({ event }) => event.kind === "conversation", actions: queue },
        "tools.edited": { actions: queue },
        "marks.edited": { actions: queue },
        "generation.changed": { guard: ({ event }) => event.result.generator === "chat-title", actions: queue },
        "conversation.renamed": { actions: queue },
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
            else if (event.action === "stop") onStop(context, event, enqueue);
          }),
        },
        "completion.progressed": { actions: enqueueActions(({ context, event, enqueue, self }) => onProgress(context, event, enqueue, self)) },
        "conversation.selected": { actions: enqueueActions(({ context, event, enqueue, self }) => onSelect(context, event, enqueue, self)) },
        "conversation.discarded": { actions: enqueueActions(({ context, event, enqueue }) => onDiscard(context, event, enqueue)) },
        "conversation.moved": { actions: enqueueActions(({ context, event, enqueue, self }) => onMoved(context, event, enqueue, self)) },
        // A delete the list handed to the corner notice when the keyboard left it: the
        // notice's undo window ran out, so the chat goes, as on conversation.discarded.
        "removal.settled": {
          guard: ({ event }) => event.kind === "conversation",
          actions: enqueueActions(({ context, event, enqueue }) => onDiscard(context, event, enqueue)),
        },
        "tools.edited": { actions: enqueueActions(({ context, event, enqueue }) => onToolsEdited(context, event, enqueue)) },
        "marks.edited": { actions: enqueueActions(({ context, event, enqueue, self }) => onMarksEdited(context, event, enqueue, self)) },
        "subject.changed": { actions: enqueueActions(({ context, event, enqueue, self }) => onSubjectChanged(context, event, enqueue, self)) },
        // A chat's title (12): written by the chat-title generator, or by the user in the list.
        "generation.changed": {
          guard: ({ event }) => event.result.generator === "chat-title",
          actions: enqueueActions(({ context, event, enqueue, self }) => onTitle(context, event.result.item, event.result.text, enqueue, self)),
        },
        "conversation.renamed": { actions: enqueueActions(({ context, event, enqueue, self }) => onTitle(context, event.id, event.title, enqueue, self)) },
        // The fact's own news about who is signed in (4.3): a different user re-boots
        // the chats; signing out clears them.
        "session.changed": [
          { guard: ({ context, event }) => (event.userId ?? null) !== context.userId, target: "loading" },
        ],
        _contracts: { actions: enqueueActions(({ context, event, enqueue, self }) => onContracts(context, event, enqueue, self)) },
        _lookups: { actions: enqueueActions(({ context, event, enqueue, self }) => onLookups(context, event, enqueue, self)) },
        _completeReply: { actions: enqueueActions(({ context, event, enqueue, self }) => onCompleteReply(context, event, enqueue, self)) },
        _saved: { actions: enqueueActions(({ context, event, enqueue, self }) => onSaved(context, event, enqueue, self)) },
        // The unsent turns and comments stay, so pending stays true; a later trigger retries.
        _saveFailed: {
          actions: ({ context, event }) => {
            if (event.sendMarks) context.marksInFlight.delete(event.chatId);
            if (event.sendPosition) context.positionInFlight.delete(event.chatId);
          },
        },
        _renamed: { actions: enqueueActions(({ context, event, enqueue, self }) => onRenamed(context, event, enqueue, self)) },
        // The title stays waiting, and the next focus or connection sends it again.
        _renameFailed: { actions: ({ context, event }) => context.titleInFlight.delete(event.id) },
        _loaded: { actions: enqueueActions(({ context, event, enqueue, self }) => onLoaded(context, event, enqueue, self)) },
        _loadFailed: { actions: ({ context, event }) => onLoadFailed(context, event) },
        _listed: { actions: ({ context, event }) => onListed(context, event) },
        _focus: { actions: enqueueActions(({ context, enqueue, self }) => onFocus(context, enqueue, self)) },
        _online: { actions: enqueueActions(({ context, enqueue, self }) => onOnline(context, enqueue, self)) },
      },
    },
  },
});
