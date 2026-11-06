import { setup, assign, emit, enqueueActions, fromPromise, fromCallback, spawnChild, stopChild } from "xstate";

// The view component where the user writes the journal (6.4). It owns only UI state —
// which day is shown, the text being typed as a draft, whether typing is waiting to be
// saved, whether the box has the keyboard, and a conflict the user has not settled — and
// points at three facts: it asks journal: read, settings: read and session: read for the
// starting picture and follows journal.changed, settings.changed and session.changed after
// (4.3, fourth rule); settings only for the "Vim keys" preference (12), session only for
// whether anyone is signed in, and books: read only to learn whether an opened book is the
// journal (written); notes: list, notes: read and notes: open, following note.changed,
// note.deleted and note.opened, for which highlights the day's source links point at still
// exist and where they are, for the highlights of an earlier day, and for Add to note;
// evaluators: list, following evaluator.changed and evaluator.deleted, only for the names
// the "#" picker offers. Writing leaves as day.saved, at a throttle while
// typing and at once on blur with `left` (4.3, third rule); whether a save lands is the
// journal's to decide, because the "today only" rule lives there. The ask, the id
// minting, the clock and the throttle arrive through input, so the machine is
// importable in Node.

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD, as the journal dates a day.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const calendar = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// A day's title, "Monday 12 October".
export const longDate = (day) =>
  calendar(day).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).replace(",", "");

// The wire form of a day's text is the note's (note-editor/machine.js, copied because
// components never import each other, 11.2): a line prefixed "# ", "## " or "### " is a
// Title, Heading or Subheading, an unprefixed line is Body. The document the user edits
// is marker-free, and parseBody/serialize are the one place the two forms meet.
const PREFIX = { title: "# ", heading: "## ", subheading: "### ", body: "" };

export function parseBody(md) {
  if (md === "") return { doc: "", levels: ["body"] };
  const doc = [];
  const levels = [];
  for (const line of md.split("\n")) {
    if (line.startsWith("### ")) { levels.push("subheading"); doc.push(line.slice(4)); }
    else if (line.startsWith("## ")) { levels.push("heading"); doc.push(line.slice(3)); }
    else if (line.startsWith("# ")) { levels.push("title"); doc.push(line.slice(2)); }
    else { levels.push("body"); doc.push(line); }
  }
  return { doc: doc.join("\n"), levels };
}

export function serialize(doc, levels) {
  if (doc === "") return "";
  // A blank line is a paragraph gap, always Body (architecture.md 10), so it never
  // carries a marker.
  return doc
    .split("\n")
    .map((text, i) => (text === "" ? "" : (PREFIX[levels[i]] ?? "") + text))
    .join("\n");
}

// The journal as `books` presents it (books' journalBook): chapter i is the i-th day
// of journal: read, oldest first, and one chapter past the last day is today's empty
// page when no day is open. So a chapter maps to its day's id, and the last chapter to
// the open day or to null, today's page. The followed chapter wins over the Days list's
// pick while it is set.
export const selectedOf = (context) =>
  context.chapter === null ? context.selected : (context.picture.days[context.chapter]?.id ?? null);

// The day the entry shows: the earlier day picked in the Days list, read only; else the
// open day; else a new page for today under a fresh id, which becomes a day at its
// first character. Today is the journal's to say (13, Journal); the device's date stands
// in only before it has said.
export const shown = (picture, selected, fresh, now) => {
  const open = picture.days.find((d) => d.id === picture.open);
  const picked = selected && selected !== picture.open ? picture.days.find((d) => d.id === selected) : null;
  if (picked) return { day: picked, editable: false };
  if (open) return { day: open, editable: true };
  return { day: { id: fresh, day: picture.today ?? dateOf(now), text: "", editedAt: now, version: 1, waiting: [], unanswered: [] }, editable: true };
};

// A conflict on the shown day, or null. Either copy can be kept, on any day: the journal
// takes a kept copy as a save to the day the conflict named, also once it has closed.
export const conflictOn = (conflict, day) =>
  conflict && conflict.id === day.id ? { mine: conflict.mine.text, theirs: conflict.theirs.text, ...labels(conflict) } : null;

const clock = (ms, seconds = false) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}` + (seconds ? `:${pad(d.getSeconds())}` : "");
};

// What each copy is called. Two records of one date (the journal sends the other copy's
// time of last edit) are told apart by when each was last written, with the date when
// the two differ and the seconds when both fall in one minute, so the two never read the
// same; a day saved on two devices by whose it is.
export function labels({ mine, theirs }) {
  if (!Number.isInteger(mine.editedAt)) return { twice: false, mineLabel: "Yours", theirsLabel: "The other device's" };
  const dated = dateOf(mine.editedAt) !== dateOf(theirs.editedAt);
  const seconds = Math.floor(mine.editedAt / 60000) === Math.floor(theirs.editedAt / 60000);
  const written = (ms) =>
    dated
      ? `Written on ${new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long" })} at ${clock(ms)}`
      : `Written at ${clock(ms, seconds)}`;
  return { twice: true, mineLabel: written(mine.editedAt), theirsLabel: written(theirs.editedAt) };
}

const EMPTY = { days: [], open: null, today: null };

// What the entry reads of the journal: its days, which one is open, and today's date.
const picture = (event) => ({ days: event.days, open: event.open, today: event.today ?? null });

const isPicture = (r) => Array.isArray(r?.days);

// The draft follows the day the box edits. While typing waits to be saved, the same day
// keeps what is on screen; another day starts from what the journal holds. A fresh id
// that has become a day is replaced, so the next new page is a new day.
const settle = (context, next, dirty) => {
  const fresh = next.days.some((d) => d.id === context.fresh) ? context.mint() : context.fresh;
  const view = shown(next, selectedOf(context), fresh, context.now());
  const editable = view.editable ? view.day : null;
  const same = Boolean(editable) && context.draft?.id === editable.id;
  return {
    picture: next,
    fresh,
    draft: dirty && same ? context.draft : editable ? { id: editable.id, text: editable.text } : null,
    // The box is still being typed in until it is left, whatever the journal echoes.
    ...(same ? {} : { editing: false }),
  };
};

// A save the journal can use: an existing day's, or a new page with something written.
const savable = (context) =>
  Boolean(context.draft) && (context.picture.days.some((d) => d.id === context.draft.id) || context.draft.text !== "");

// The shown day's date, and whether it can still be written, leave as day.shown, once
// when the page has loaded and again only when either changes, so a view about one day
// (nested under the text) needs no copy of the rule above or of the journal's "today
// only" rule, which keeps yesterday open until 2:00. Every transition that can move them
// ends with this; the journal's announcement at 2:00 is one.
const announce = enqueueActions(({ context, enqueue }) => {
  const view = shown(context.picture, selectedOf(context), context.fresh, context.now());
  const { day } = view.day;
  if (day === context.shownDay && view.editable === context.shownWritable) return;
  enqueue.assign({ shownDay: day, shownWritable: view.editable });
  enqueue.emit({ type: "day.shown", day, writable: view.editable });
});

const save = (left) =>
  enqueueActions(({ context, enqueue }) => {
    if (!savable(context)) return;
    const { id, text } = context.draft;
    const finished = context.finished.length ? { finished: context.finished } : {};
    enqueue.assign({ finished: [], ...(id === context.checkedId ? { checkedText: text } : {}) });
    enqueue.emit(left ? { type: "day.saved", id, text, left: true, ...finished } : { type: "day.saved", id, text, ...finished });
  });

const edit = assign(({ context, event }) => ({ draft: { ...context.draft, text: event.text }, editing: true }));

// A choice is one step the journal records, taken back with the global Undo (12, Undo),
// after which the journal tells the conflict again.
const keep = (side) =>
  enqueueActions(({ context, enqueue }) => {
    const { id, mine, theirs } = context.conflict;
    enqueue.emit({ type: "day.saved", id, text: side === "mine" ? mine.text : theirs.text });
  });

// A change that settled the conflict shown (journal.changed's `settled`), as a Redo of
// keeping one copy does, hides the two copies at once.
const settledConflict = assign(({ context, event }) => (context.conflict && event.settled === context.conflict.id ? { conflict: null } : {}));

const follow = (dirty) => [assign(({ context, event }) => settle(context, picture(event), dirty)), settledConflict, announce];

// What a pick asks the entry to show: a day from the Days list, or a chapter of the
// journal book (null is today's page).
const pickOf = (event) => (event.type === "day.selected" ? { selected: event.id, chapter: null, dayPicked: true } : { selected: null, chapter: event.chapter });

// Another day picked: what is being typed is saved first, then the entry follows.
const select = (dirty) => ({
  target: "clean",
  actions: [
    ...(dirty ? [save(false)] : []),
    assign(({ context, event }) => {
      const pick = pickOf(event);
      return { ...settle({ ...context, ...pick }, context.picture, false), ...pick };
    }),
    announce,
  ],
});

// A book opened or a chapter picked in the contents: followed only for a book whose
// books: read reply says it is written, the journal. Whether a book is written is
// cached by id and kept current by book.changed and book.deleted (4.3, fourth rule); an
// unknown book is asked about once, and the answer applies to the latest pick, if that
// pick is still in this book. book.opened shows today's page, the last chapter.
//
// A pick can arrive just before the open it causes (a lookup's link in the chat names a
// day or a chapter of the journal while another book is open, and `books` opens the
// journal for it): then that open keeps the pick rather than showing today's page.
const followBook = enqueueActions(({ context, event, enqueue, self }) => {
  const opened = event.type === "book.opened";
  enqueue.assign({ dayPicked: false });
  if (event.id == null) {
    enqueue.assign({ want: null });
    return;
  }
  const keepChapter = opened && context.want?.id === event.id && context.want.chapter != null;
  const keep = opened && context.dayPicked;
  const want = keepChapter ? context.want : { id: event.id, chapter: opened ? null : event.chapter, ...(keep ? { keep: true } : {}) };
  enqueue.assign({ want });
  const known = context.written[event.id];
  if (known === true && !want.keep) enqueue.raise({ type: "_show", chapter: want.chapter });
  if (known !== undefined || context.asking.includes(event.id)) return;
  const { id } = want;
  enqueue.assign({ asking: [...context.asking, id] });
  Promise.resolve(context.ask("books", "read", { id }))
    .then((r) => self.send({ type: "_book", id, written: r?.book?.written === true, known: Boolean(r?.book) }))
    .catch(() => self.send({ type: "_book", id, written: false, known: false }));
});

// The journal's book id, as books reported it: the book being followed when it is the
// journal, else any book books said is written. Null while no book has been seen as the
// journal, as on a page without books.
export const journalId = (context) =>
  context.want && context.written[context.want.id] === true
    ? context.want.id
    : (Object.keys(context.written).find((id) => context.written[id] === true) ?? null);

// :q in the editor (the editor kit's quit, Vim keys on) closes the journal's book.
const quit = enqueueActions(({ context, enqueue }) => {
  const id = journalId(context);
  if (id) enqueue.emit({ type: "book.closed", id });
});

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the journal.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the page shows of the account (14, signed out): "wait" until session answers, so
// neither the day nor the sign-in line flashes; "sign-in" signed out, since the days kept
// in this browser are the account's; "show" otherwise. A try page (8) shows the journal to
// a visitor who is not yet a guest.
// Where following a source link goes (note-editor/machine.js, copied because components
// never import each other, 11.2): the book and the passage the highlight's link to its
// book carries, from a notes: read reply. Null when the highlight is gone (a tombstone
// reads not-found) or the note marks no passage, so nothing opens.
export function passageOf(reply, id) {
  const about = Array.isArray(reply?.note?.about) ? reply.note.about : [];
  const link = about.find((l) => l.kind === "book" && l.place);
  return link ? { book: link.id, id, place: link.place } : null;
}

// Whether the highlight a source link names is gone, so its tag is drawn grey: a note
// notes no longer lists, once it has answered, or one a follow found gone. While notes has
// not answered (a page without it), only a follow can tell.
export const linkMissing = ({ notes, removed }) => (id) => removed.includes(id) || (notes !== null && !notes.includes(id));

const without = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : list);

// Vim keys on a journal day (12, "Vim keys"): j in normal mode on the text's last line
// moves the keyboard down onto the views nested under the text, and k on a nested view's
// first row, which that view leaves unused, moves it back up. `vim` is the Vim plugin's
// state of the editor; a count, an operator or a half-typed command keeps the key Vim's.
const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
export function textEdge(e, vim, line, { last }) {
  if (!vim || vim.insertMode || vim.visualMode || !plain(e)) return null;
  const s = vim.inputState;
  if (s && (s.operator || s.keyBuffer?.length || s.prefixRepeat?.length || s.motionRepeat?.length)) return null;
  return e.key === "j" && line >= last ? "down" : null;
}

// A j or k a nested view let bubble out unused: the next or the previous stop in the
// order shown, the text being the stop above the first nested view.
export const nestedStep = (e, vimKeys) => (vimKeys && plain(e) ? { j: "down", k: "up" }[e.key] ?? null : null);

export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

// Whether a nested view is shown (8): one with no `flag`, or whose feature `flags`
// reports not hidden. Until `flags` answers (`hidden` is null) a flagged view is hidden,
// the same as `flags` itself with no answer yet (3.1).
export const flagShown = (flag, hidden) => !flag || (hidden !== null && !hidden.includes(flag));

// The hidden features from a `flags: read` reply; a page without `flags` (the reply is
// an error) hides nothing.
const hiddenOf = (reply) => (Array.isArray(reply?.hidden) ? reply.hidden : []);

// --- Hashtag checks (line-checks) ------------------------------------------------------
// line-checks owns Jev's answers about the lines a hashtag line names (13, Hashtag check);
// the entry asks it for the day it shows, follows text.checked for that day, and turns the
// report into what the view draws. Copied from note-editor/machine.js, because components
// never import each other (11.2).

// Why a line could not be checked, in one plain sentence, shown as the mark's tooltip.
export const CHECK_ERRORS = {
  "signed-out": "Could not check: sign in to have your lines checked.",
  "no-key": "Could not check: add your Jev key in Settings.",
  "bad-key": "Could not check: your Jev key was refused. Check it in Settings.",
  "rate-limited": "Could not check: too many requests. It tries again when you next finish a line.",
  overloaded: "Could not check: busy right now. It tries again when you next finish a line.",
  busy: "Could not check: busy right now. It tries again when you next finish a line.",
  invalid: "Could not check: the evaluator's questions could not be asked.",
  unavailable: "Could not check right now. It tries again when you next finish a line.",
  "local-off": "Could not check: Ollama isn't running on this Mac. Open Ollama; it tries again when you next finish a line.",
  "no-model": "Could not check: Kev isn't downloaded. In Terminal, run ollama pull kev:0.8b-mlx-bf16; it tries again when you next finish a line.",
};

// The hashtags of the report that name one of the account's evaluators, drawn in the
// accent colour; any other is drawn muted.
export const knownTags = (checks) => new Set((checks?.tags ?? []).filter((t) => t.evaluator != null).map((t) => t.tag));

// What each checked line shows at its end, by its text as the editor shows it (a level's
// marker off): a dot while Jev is asked, a warning with the reason when it could not be,
// and otherwise each answer's icon and name, a check where the option has no icon.
export function lineMarksOf(checks) {
  const out = new Map();
  for (const line of checks?.lines ?? []) {
    const text = line.text.trim().replace(/^#{1,3} /, "");
    if (line.status === "pending") out.set(text, [{ pending: true }]);
    else if (line.status === "failed") out.set(text, [{ failed: true, error: CHECK_ERRORS[checks.error] ?? CHECK_ERRORS.unavailable }]);
    else if (line.marks.length) out.set(text, line.marks.map((m) => ({ name: m.name, icon: m.icon ?? "check", ...(m.tone ? { tone: m.tone } : {}) })));
  }
  return out;
}

const union = (a, b) => [...new Set([...(a ?? []), ...(Array.isArray(b) ? b : [])])];

// The day shown and the text the box holds; `kept` when that text is what the journal
// holds for the day (nothing typed waits to be saved). A partner's test mounts the entry
// without a clock; the clock only dates a new page, which no check reads.
const checkSource = (context) => {
  const view = shown(context.picture, selectedOf(context), context.fresh, context.now?.() ?? 0);
  const text = view.editable && context.draft?.id === view.day.id ? context.draft.text : view.day.text;
  return { id: view.day.id, text, kept: text === view.day.text, editable: view.editable };
};

// When to ask line-checks for the day shown: when another day is shown, and when its text
// changed other than by typing here (another device, an Undo), which line-checks learns
// from no save. While the user types, the save tells it. Null when nothing needs asking.
export function checksDue(context) {
  const source = checkSource(context);
  if (source.id !== context.checkedId) return { id: source.id, text: source.text, reset: true };
  if (source.kept && source.text !== context.checkedText) return { id: source.id, text: source.text, reset: false };
  return null;
}

// A finished line that nothing would save soon goes to line-checks at once, in a save of
// the text the journal already holds, which it takes as no change; never while two copies
// wait to be settled, where a save of one copy keeps it. Otherwise it waits for the next
// save. An earlier day takes no typing and checks nothing.
function finish(context, enqueue, lines) {
  const source = checkSource(context);
  if (!source.editable || !context.draft || context.draft.id !== source.id) return;
  const finished = union(context.finished, lines);
  if (finished.length === context.finished.length) return;
  const known = context.picture.days.some((d) => d.id === source.id);
  if (known && source.kept && !context.conflict) {
    enqueue.assign({ finished: [] });
    enqueue.emit({ type: "day.saved", id: source.id, text: source.text, finished });
  } else enqueue.assign({ finished });
}

// The account's evaluators as the "#" picker offers them, { id, name, description } each,
// in the order evaluators lists them; a reply that is not a list (offline, no-answerer)
// offers none. Copied in note-editor/machine.js, because components never import each
// other (11.2).
export const evaluatorsOf = (reply) =>
  Array.isArray(reply?.evaluators) ? reply.evaluators.map(pickable) : [];
const pickable = (e) => ({ id: e.id, name: e.name, description: e.description ?? "" });
// evaluator.changed replaces the one it names in its place, or adds a new one at the end.
export const withEvaluator = (list, evaluator) =>
  list.some((e) => e.id === evaluator.id)
    ? list.map((e) => (e.id === evaluator.id ? pickable(evaluator) : e))
    : [...list, pickable(evaluator)];

// --- Highlights on an earlier day (13, Highlight) ---------------------------------------
// Copied from book-reader/machine.js, and the finger's passage from chat-thread/machine.js,
// because components never import each other (11.2). A highlight is an ordinary note whose
// link to the Journal names the day. Its place counts by the lines of the text the editor
// shows (parseBody's doc): `block` is a line and `offset` a place in it, since a day has
// no book page to count by. Today's page takes no highlights, because its text still changes.

// `books` presents the journal under this fixed id (books/machine.js).
export const JOURNAL = "00000000000000000000000JRN";
const isDay = (chapter) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(chapter ?? "");

const before = (a, b) => a.block < b.block || (a.block === b.block && a.offset < b.offset);
const WORD = /[\p{L}\p{N}\p{M}'’]/u;
const isWord = (ch) => ch != null && WORD.test(ch);
const isSpace = (ch) => ch != null && /\s/u.test(ch);
const forward = (texts, p) => {
  if (p.offset < texts[p.block].length) return { block: p.block, offset: p.offset + 1 };
  if (p.block + 1 < texts.length) return { block: p.block + 1, offset: 0 };
  return null;
};
const charAfter = (texts, p) => (p.offset < texts[p.block].length ? texts[p.block][p.offset] : null);
const charBefore = (texts, p) => (p.offset > 0 ? texts[p.block][p.offset - 1] : null);

export const snapToWords = (texts, range, { grow = true } = {}) => {
  let start = { ...range.start };
  let end = { ...range.end };
  while (grow && start.offset > 0 && isWord(texts[start.block][start.offset]) && isWord(texts[start.block][start.offset - 1])) start.offset -= 1;
  while (grow && end.offset < texts[end.block].length && isWord(texts[end.block][end.offset]) && isWord(texts[end.block][end.offset - 1])) end.offset += 1;
  while (before(start, end) && isSpace(charAfter(texts, start))) start = forward(texts, start);
  while (before(start, end) && isSpace(charBefore(texts, end))) end = { block: end.block, offset: end.offset - 1 };
  while (before(start, end) && end.offset === 0 && end.block > start.block) {
    end = { block: end.block - 1, offset: texts[end.block - 1].length };
    while (before(start, end) && isSpace(charBefore(texts, end))) end = { block: end.block, offset: end.offset - 1 };
  }
  return before(start, end) ? { start, end } : null;
};

const CONTEXT = 32;
export const quoteOf = (texts, { start, end }) => {
  const parts = [];
  if (start.block === end.block) parts.push(texts[start.block].slice(start.offset, end.offset));
  else {
    parts.push(texts[start.block].slice(start.offset));
    for (let b = start.block + 1; b < end.block; b += 1) parts.push(texts[b]);
    parts.push(texts[end.block].slice(0, end.offset));
  }
  return {
    exact: parts.join("\n"),
    prefix: texts[start.block].slice(Math.max(0, start.offset - CONTEXT), start.offset),
    suffix: texts[end.block].slice(end.offset, end.offset + CONTEXT),
  };
};

const overlaps = (a, b) => !(before(a.end, b.start) || before(b.end, a.start));
const contains = (outer, inner) => !before(inner.start, outer.start) && !before(outer.end, inner.end);
const rangeOf = (place) => ({ start: place.start, end: place.end });
const covering = (ranges) =>
  ranges.reduce((u, r) => ({ start: before(r.start, u.start) ? r.start : u.start, end: before(u.end, r.end) ? r.end : u.end }));
const joined = (bodies) => bodies.filter((b) => b.trim() !== "").join("\n\n");

// A highlight's title is its comment's first line that says anything, so a list row, which
// carries no body, can still tell a commented highlight from a bare one (12).
export const titleOf = (body) => body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

const LABEL_MAX = 40;
export const linkLabel = (exact) => {
  const words = String(exact ?? "").trim().split(/\s+/u).filter(Boolean);
  let label = "";
  for (const w of words) {
    const next = label ? `${label} ${w}` : w;
    if (next.length > LABEL_MAX) break;
    label = next;
  }
  if (!label && words.length) label = words[0].slice(0, LABEL_MAX);
  const cut = label.length < words.join(" ").length;
  return (cut ? `${label}…` : label).replace(/[\\[\]]/g, "\\$&");
};
export const sourceLink = (id, quote) => `[${linkLabel(quote?.exact)}](note:${id})`;

const notesLinks = (note) => (Array.isArray(note.about) ? note.about : []);

// The notes that are highlights of a journal day, reduced to what the entry paints.
export const highlightsOf = (notes) =>
  notes
    .map((note) => {
      const link = notesLinks(note).find((l) => l.kind === "book" && l.id === JOURNAL && l.place && isDay(l.chapter));
      return link ? { id: note.id, day: link.chapter, place: link.place, quote: link.quote, commented: Boolean(note.title) } : null;
    })
    .filter(Boolean);

const foldHighlight = (highlights, note) => [...highlights.filter((h) => h.id !== note.id), ...highlightsOf([note])];

const heldBy = (note) => notesLinks(note).filter((l) => l.kind === "highlight").map((l) => l.id);
export const holdingOf = (notes) => Object.fromEntries(notes.map((n) => [n.id, heldBy(n)]).filter(([, ids]) => ids.length > 0));
const foldHolding = (holding, note) => {
  const { [note.id]: _, ...rest } = holding;
  const ids = heldBy(note);
  return ids.length ? { ...rest, [note.id]: ids } : rest;
};

// The bubble's Add to note: null while Slip-Box is hidden, so the button is not drawn;
// otherwise whether it can be pressed and, when not, why.
export const addToNote = (context, id) => {
  if (!(Array.isArray(context.hidden) && !context.hidden.includes("slip-box"))) return null;
  if (context.opened == null) return { enabled: false, why: "Open a note first" };
  if (context.opened === id || (context.holding[context.opened] ?? []).includes(id)) return { enabled: false, why: "Already in this note" };
  return { enabled: true, why: null };
};

// A place in the doc as a line and an offset, and back.
export const pointOf = (doc, pos) => {
  const lines = doc.slice(0, pos).split("\n");
  return { block: lines.length - 1, offset: lines.at(-1).length };
};
export const posOf = (doc, { block, offset }) => {
  const lines = doc.split("\n");
  if (block >= lines.length || offset > lines[block].length) return null;
  return lines.slice(0, block).reduce((sum, l) => sum + l.length + 1, 0) + offset;
};

// What the editor paints for one day, in order, as [from, to) in its doc. An earlier day's
// text changes only when the user keeps the other copy of a conflict, so a place whose text
// no longer reads as its quote is looked for by the quote, and left unpainted when it is gone.
export function marksOf(highlights, day, doc) {
  return highlights
    .filter((h) => h.day === day)
    .map((h) => {
      const exact = h.quote?.exact ?? "";
      let from = posOf(doc, h.place.start);
      if (from == null || doc.slice(from, from + exact.length) !== exact) from = exact ? doc.indexOf(exact) : -1;
      return from == null || from < 0 ? null : { id: h.id, from, to: from + exact.length, commented: h.commented, exact };
    })
    .filter(Boolean)
    .sort((a, b) => a.from - b.from);
}

// The highlight holding a position (the cursor): start inclusive, end exclusive.
export const markAt = (marks, pos) => marks.find((m) => pos >= m.from && pos < m.to) ?? null;

// A finger's passage on the doc. The word holding an index, between blanks; on a blank, the
// word before it, or with none before it, the one after.
const blank = (c) => /\s/u.test(c);
export const wordAround = (flat, i) => {
  let at = Math.min(i, flat.length - 1);
  while (at > 0 && blank(flat[at])) at -= 1;
  while (at < flat.length - 1 && blank(flat[at])) at += 1;
  let from = at;
  let to = at + 1;
  while (from > 0 && !blank(flat[from - 1])) from -= 1;
  while (to < flat.length && !blank(flat[to])) to += 1;
  return [from, to];
};

// The passage with the finger over index `i`, from the fixed `word` the hold started on.
// Which way it runs depends only on where the finger is against that word.
export const fingerPassage = (flat, [from, to], i) => {
  if (i >= from) return [from, Math.max(wordAround(flat, Math.max(from, i))[1], to)];
  let at = i;
  while (at < from && blank(flat[at])) at += 1;
  return [wordAround(flat, at)[0], to];
};

// What a key does on an earlier day with Vim keys on. Vim's edits would change the document
// even in a read-only editor, so they stop here (`block`); Undo and Redo stay the global ones
// (12, "Vim keys"), which Vim would swallow (`global`); the motions and v are Vim's own; the
// rest is the reader's keys. A half-typed Vim command (gx, gg, fa) stays Vim's.
const NORMAL_EDITS = new Set([..."iIAoOcCsSrRxXDpPJ~.Y"]);
const VISUAL_EDITS = new Set([..."dDxXcCsSrRJ~uUpPYAI"]);
export function pastKey(e, vim) {
  if (!vim || vim.insertMode || e.altKey || e.metaKey || e.isComposing) return "vim";
  if (e.ctrlKey) {
    if (e.key === "r" && !vim.visualMode) return "global";
    return e.key === "a" || e.key === "x" ? "block" : "vim";
  }
  const s = vim.inputState;
  if (s && (s.operator || s.keyBuffer?.length)) return "vim";
  if (vim.visualMode) {
    if (e.key === "y") return "yank";
    if (e.key === "Enter") return "make";
    return VISUAL_EDITS.has(e.key) ? "block" : "vim";
  }
  if (e.key === "u") return "global";
  if (e.key === "y" || e.key === "a" || e.key === "d") return e.key;
  if (e.key === "Enter") return "enter";
  return NORMAL_EDITS.has(e.key) ? "block" : "vim";
}

// The day shown when it can take a highlight, or null: an earlier day with no two copies
// waiting to be settled, since keeping the other copy may remove the passage.
const markable = (context) => {
  const view = shown(context.picture, selectedOf(context), context.fresh, context.now?.() ?? 0);
  return !view.editable && !conflictOn(context.conflict, view.day) ? view.day : null;
};

const opening = (context, id) => ({ id, n: (context.reveal?.n ?? 0) + 1 });

// A range wholly inside one highlight makes nothing and opens that highlight's bubble; a
// range clear of them all is a new note; one that overlaps or touches others merges them
// into one, the same as in a book. `open` asks for the bubble of what was made: the mouse and
// the finger make at once and offer the comment next, and the keyboard stays where it is.
const makeHighlight = enqueueActions(({ context, event, enqueue }) => {
  const day = markable(context);
  if (!day) return;
  const { doc } = parseBody(day.text);
  const texts = doc.split("\n");
  const range = snapToWords(texts, { start: pointOf(doc, event.from), end: pointOf(doc, event.to) }, { grow: !event.exact });
  if (!range) return;
  const hit = context.highlights.filter((h) => h.day === day.day && overlaps(rangeOf(h.place), range));
  if (hit.length === 1 && contains(rangeOf(hit[0].place), range)) {
    enqueue.assign({ reveal: opening(context, hit[0].id) });
    return;
  }
  const chapter = context.picture.days.findIndex((d) => d.id === day.id);
  // The journal has no re-imports to tell apart, so its places carry no content version.
  const placeOf = (r) => ({ chapter, contentVersion: 0, start: r.start, end: r.end });
  if (hit.length === 0) {
    const id = context.mint();
    enqueue.emit({
      type: "note.saved",
      id,
      title: "",
      body: "",
      baseVersion: null,
      about: [{ kind: "book", id: JOURNAL, chapter: day.day, chapterTitle: longDate(day.day), place: placeOf(range), quote: quoteOf(texts, range) }],
      // One finished gesture, so one step of its own (12, Undo).
      left: true,
    });
    if (event.open) enqueue.assign({ reveal: opening(context, id) });
    return;
  }
  const involved = [...hit].sort((a, b) => (before(a.place.start, b.place.start) ? -1 : 1));
  const u = covering([range, ...involved.map((h) => rangeOf(h.place))]);
  enqueue.assign({ merge: { ids: involved.map((h) => h.id), place: placeOf(u), quote: quoteOf(texts, u), open: event.open === true } });
  enqueue.stopChild("merging");
  enqueue.spawnChild("readNotes", { id: "merging", input: { ask: context.ask, ids: involved.map((h) => h.id) } });
});

// The earliest overlapping note survives, grown to the union, with the comments stacked; the
// rest are discarded.
const finishMerge = enqueueActions(({ context, event, enqueue }) => {
  const { merge } = context;
  if (!merge) return;
  enqueue.assign({ merge: null });
  const notes = new Map(event.notes.map((n) => [n.id, n]));
  const [survivorId, ...others] = merge.ids;
  const survivor = notes.get(survivorId);
  if (!survivor) return;
  const body = joined(merge.ids.map((id) => notes.get(id)?.body ?? ""));
  const about = notesLinks(survivor).map((l) => (l.kind === "book" && l.id === JOURNAL && l.place ? { ...l, place: merge.place, quote: merge.quote } : l));
  enqueue.emit({ type: "note.saved", id: survivorId, title: titleOf(body), body, baseVersion: survivor.version, about, left: true });
  for (const id of others) enqueue.emit({ type: "note.discarded", id });
  if (merge.open) enqueue.assign({ reveal: opening(context, survivorId) });
});

// A followed link to a journal highlight: that day shows and the passage glows. A book the
// followed link opens keeps this pick (followBook).
const toPassage = enqueueActions(({ context, event, enqueue }) => {
  if (event.book !== JOURNAL) return;
  enqueue.assign({
    want: { id: JOURNAL, chapter: event.place.chapter },
    dayPicked: false,
    written: { ...context.written, [JOURNAL]: true },
    glow: { id: event.id, n: (context.glow?.n ?? 0) + 1 },
  });
  enqueue.raise({ type: "_show", chapter: event.place.chapter });
});

export const machine = setup({
  actors: {
    // The notes a merge combines, for their comments and versions.
    readNotes: fromCallback(({ input, sendBack }) => {
      Promise.all(input.ids.map((id) => input.ask("notes", "read", { id }))).then(
        (replies) => sendBack({ type: "_merged", notes: replies.filter((r) => r && "note" in r).map((r) => r.note) }),
        () => sendBack({ type: "_merged", notes: [] }),
      );
    }),
    // The highlight's comment and version, for the comment box.
    readComment: fromCallback(({ input, sendBack }) => {
      Promise.resolve(input.ask("notes", "read", { id: input.id })).then(
        (reply) => sendBack({ type: "_commentRead", id: input.id, note: reply?.note ?? null }),
        () => sendBack({ type: "_commentRead", id: input.id, note: null }),
      );
    }),
    // The note open in the Notes panel, announced before this entry was mounted.
    openNote: fromPromise(({ input }) => input.ask("notes", "open", {})),
    flags: fromPromise(({ input }) => input.ask("flags", "read", {})),
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // Which notes exist, for the day's source links; note.changed and note.deleted are held
    // for this ask until its reply lands.
    notes: fromPromise(({ input }) => input.ask("notes", "list", {})),
    // Every evaluator of the account, for the "#" picker: no book is named, so none is
    // left out; evaluator.changed and evaluator.deleted are held until the reply lands.
    evaluators: fromPromise(({ input }) => input.ask("evaluators", "list", {})),
    // line-checks' report for the day shown, from the answers it keeps (it never asks Jev
    // for a read); text.checked is held for us until the reply lands (read supersededBy).
    checks: fromCallback(({ input, sendBack }) => {
      Promise.resolve(input.ask("line-checks", "read", { kind: "day", id: input.id, text: input.text })).then(
        (reply) => sendBack({ type: "_checks", id: input.id, reply }),
        () => {},
      );
    }),
    // Following a source link asks notes for the highlight beside whatever the entry is
    // doing, so the draft is untouched; the reply comes back as _followed.
    follow: fromCallback(({ input, sendBack }) => {
      Promise.resolve(input.ask("notes", "read", { id: input.id })).then(
        (reply) => sendBack({ type: "_followed", id: input.id, reply }),
        () => sendBack({ type: "_followed", id: input.id, reply: null }),
      );
    }),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
  actions: {
    // Ask line-checks for the day shown (checksDue); a text without a "#" has no hashtag
    // line, so there is nothing to ask and nothing to show.
    readChecks: enqueueActions(({ context, enqueue }) => {
      const due = checksDue(context);
      const hashed = due.text.includes("#");
      enqueue.assign({ checkedId: due.id, checkedText: due.text, ...(due.reset || !hashed ? { checks: null } : {}) });
      enqueue.stopChild("checks");
      if (hashed) enqueue.spawnChild("checks", { id: "checks", input: { ask: context.ask, id: due.id, text: due.text } });
    }),
  },
}).createMachine({
  id: "journal-entry",
  meta: {
    description:
      "The journal's page: the day picked in the Days list or in the journal book's contents, " +
      "or the day that can still be edited, or an empty page for today. It follows the open book " +
      "only while that book is the journal: opening the journal, or its last chapter, shows " +
      "today's page, and an earlier chapter shows that day; other books are ignored. The day's " +
      "text is shown once, in one editor, read only on an earlier day, with Vim when the Vim " +
      "keys setting is on. Each line is Title, Heading, Subheading or Body, like a note: the four " +
      "buttons under the text set the level of the lines the cursor spans, show the cursor " +
      "line's level, and name the Vim keys \\1, \\2, \\3 and \\0 while Vim is on; an earlier " +
      "day shows its levels but offers no buttons. The text is saved a short time into " +
      "typing and when the box loses focus. When a day was saved on two devices at once, or the " +
      "journal holds two records of the shown date, the entry shows both copies, also on an " +
      "earlier day, labelled Yours and The other device's, or for two records of a date by when " +
      "each was last written (Written at 09:14, with the date when the two differ and the seconds when both fall in one minute), and the user keeps one; the journal makes that one " +
      "step, so Undo brings both copies back, and a Redo hides them again at once. It announces which day it shows and whether " +
      "it can still be written, when the page has loaded and whenever either changes, also at " +
      "2:00, when the journal's day ends, and it holds a view a page nests in it under the day's text, which scrolls with " +
      "the text and follows the announced day. With Vim keys on, typing :q or :quit in the " +
      "editor, on any day, closes the journal's book. With Vim keys on, p pastes text or a link copied in the reader with Vim keys, paragraphs kept. A source link to a highlight, pasted " +
      "from the reader's Copy link (or with p after the reader's y while Vim keys is on), is " +
      "drawn as one tag, the link icon and the start of the quote, that the cursor steps over " +
      "and Backspace or x removes whole, while the day's saved text keeps the link as it was " +
      "pasted; a click on it, or Enter on it in Vim's normal mode, opens the book at the " +
      "passage, also on an earlier day, and a tag whose highlight is gone turns grey and " +
      "struck through and opens nothing. Signed out it shows no day, no level " +
      "buttons and nothing nested under the text, only \"Sign in to write in your journal.\"; " +
      "the days stay kept in this browser and come back when the user signs in, without a " +
      "reload. On a try page a visitor not yet signed in still writes." +
      " A web address, bare or written as [label](https://…), is drawn as an underlined link in " +
      "the accent color, a markdown link showing only its label except on the line being " +
      "edited; a click on it, or gx with Vim keys on, opens it in a new browser tab, on an " +
      "earlier day too. With Vim keys on, j in normal mode on the text's last line, a blank one too, so empty lines at the end are reached and dd removes them, moves the " +
      "keyboard down onto the views nested under the text, in the order they are shown, and " +
      "j or k on one of them that it does not use itself (j on its last row, k on its first) " +
      "moves to the next one or back up, the text being the stop above the first; the keyboard " +
      "comes back to the start of the text's last line, on an earlier day too. A nested view the page " +
      "gives `flag` naming a feature is not shown while `flags` reports the feature hidden, " +
      "and until `flags` answers; a page without `flags` hides nothing. A hashtag, such as " +
      "#in-my-control, is drawn in the accent color when it names one of the account's " +
      "evaluators and muted when it names none; each line it names (the lines after it in the " +
      "same paragraph or list) is checked by line-checks once the user finishes it on today's " +
      "page (moves off it, presses Enter, pastes, or leaves the box), and its answer shows at " +
      "the line's end as the option's icon and name, several joined in one row: a pulsing dot " +
      "while Jev is asked, and a warning whose tooltip says why when it could not be. Your " +
      "values gets one compass per line, whose name says which values: red when it goes against " +
      "any, green when it serves one, uncolored when Jev can't tell. An " +
      "earlier day shows the answers already kept and asks nothing." +
      " Typing # at the start of a word opens a list of the account's evaluators by their " +
      "short names, each with its description on a line under it, narrowed as the name is " +
      "typed; the arrow keys (or Ctrl+N and Ctrl+P) choose, Enter, Tab, a click or a tap " +
      "writes the name and a space, and Escape or moving away closes it. Enter at the end of " +
      "a hashtag line starts a bullet directly below it, so the lines written next are the " +
      "ones it checks. An earlier day never opens the list." +
      " An earlier day's text can hold the keyboard and is read only: Vim's motions and v work " +
      "there, and Vim's edits do nothing. A mouse selection makes a highlight at once, grown to " +
      "whole words, and opens its bubble, and the selection stays, so the browser's copy still " +
      "copies it. On a touch screen a finger never uses the browser's selection: pressing and " +
      "holding for about 0.4 seconds paints the word under it, a drag grows the passage from " +
      "that fixed word, and lifting (or iOS ending the touch) makes the highlight and opens its " +
      "bubble; a finger that moves first scrolls the day. Enter on a passage marked with v, or " +
      "on a selection made without Vim, makes a highlight and leaves the bubble closed; y on a " +
      "passage marked with v copies it and makes no highlight, with Copied shown for a moment. A " +
      "selection that touches another highlight merges with it, comments stacked; one wholly " +
      "inside a highlight only opens that highlight's bubble. A highlight is painted in the " +
      "marker color, with an accent line under it once it has a comment, and a press on it, or " +
      "Enter with the cursor inside it, opens its bubble: Copy, Copy link, Add to note while " +
      "Slip-Box is shown, greyed with its reason when it cannot be pressed, Remove with the short " +
      "notice and Undo, and Comment, a small box that saves the highlight's title and body when " +
      "it is left. Enter gives the bubble the keyboard: h and l or the arrows move along it, and " +
      "Escape goes back to the text. With Vim keys on and the cursor inside a highlight, a does " +
      "Add to note, y Copy link, y y Copy and d d Remove, and u stays the global Undo. Following " +
      "a link to a journal highlight shows that day, scrolls to the passage and makes it glow " +
      "for about a second. Today's page takes no highlights.",
    kind: "view",
    emits: ["day.saved", "day.shown", "book.closed", "passage.selected", "note.saved", "note.discarded", "passage.added", "link.copied", "text.copied"],
    attributes: ["height"],
    asks: ["journal: read", "settings: read", "books: read", "session: read", "notes: list", "notes: read", "notes: open", "flags: read", "line-checks: read", "evaluators: list"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    now: input.now,
    throttleMs: input.throttleMs ?? 200,
    picture: EMPTY,
    // The id a new page for today is saved under, once something is written on it.
    fresh: input.mint(),
    // The day picked in the Days list; null follows the open day.
    selected: null,
    // The journal book's chapter being followed (selectedOf); null follows the Days list.
    chapter: null,
    // Whether each book seen is written (the journal), by id, from books.
    written: {},
    // The latest book pick, {id, chapter}, and the books being asked about.
    want: null,
    // Whether a day was picked since the last book opened or chapter was picked (followBook).
    dayPicked: false,
    asking: [],
    // The date, and whether it could be written, last announced as day.shown; null until
    // the page has loaded.
    shownDay: null,
    shownWritable: null,
    draft: null,
    editing: false,
    conflict: null,
    // The "Vim keys" device preference (12), owned by `settings`: off until it says
    // otherwise, and off on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
    // The ids of every note notes lists, for the source links' tags; null until it answers.
    notes: null,
    // Source links a follow found gone (UI state): their tags are drawn grey.
    removed: [],
    // Puts text or a source link copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    // The features `flags` reports hidden, for the nested views' `flag` (8); null until it
    // answers.
    hidden: null,
    // line-checks' report for the day shown (text.checked's shape), null while there is none.
    checks: null,
    // The day and the text line-checks last learned from this entry, by a read or a save.
    checkedId: null,
    checkedText: null,
    // The lines the user finished that no save has carried yet (day.saved's finished).
    finished: [],
    // The account's evaluators the "#" picker offers (evaluatorsOf); none until evaluators
    // answers.
    evaluators: [],
    // The journal's highlights (highlightsOf), which notes hold which passages, and the note
    // open in the Notes panel; `openSeen` says a note.opened came before the starting ask's
    // reply, which is then stale.
    highlights: [],
    holding: {},
    opened: null,
    openSeen: false,
    // One-shots for the view, each with a nonce: the highlight whose bubble opens, and the
    // one a followed link makes glow.
    reveal: null,
    glow: null,
    // A merge waiting for the notes it combines, and the comment box's starting text.
    merge: null,
    comment: null,
  }),
  // Asked after any change that shows another day or another text (checksDue), so no
  // state can forget it.
  always: { guard: ({ context }) => checksDue(context) != null, actions: "readChecks" },
  // Each fact's starting picture is asked on its own, so an event that follows one
  // reply is never overwritten by that reply arriving with the other.
  invoke: [
    {
      src: "flags",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ hidden: ({ event }) => hiddenOf(event.output) }) },
      onError: { actions: assign({ hidden: [] }) },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
    {
      src: "notes",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ event }) => Array.isArray(event.output?.notes),
        actions: assign({
          notes: ({ event }) => event.output.notes.map((n) => n.id),
          highlights: ({ event }) => highlightsOf(event.output.notes),
          holding: ({ event }) => holdingOf(event.output.notes),
        }),
      },
    },
    {
      src: "openNote",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ context }) => !context.openSeen,
        actions: assign({ opened: ({ event }) => event.output?.note?.id ?? null }),
      },
      onError: { actions: [] },
    },
    {
      src: "evaluators",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ evaluators: ({ event }) => evaluatorsOf(event.output) }) },
      onError: { actions: assign({ evaluators: [] }) },
    },
  ],
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => isPicture(event.output),
            target: "ready",
            actions: [assign(({ context, event }) => settle(context, picture(event.output), false)), announce],
          },
          // The journal could not answer: an honest failure rather than an empty page.
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
            _edit: { guard: ({ context }) => Boolean(context.draft), target: "dirty", actions: edit },
            _blur: { guard: ({ context }) => context.editing, actions: [save(true), assign({ editing: false })] },
            "journal.changed": { actions: follow(false) },
            "day.selected": select(false),
            _show: select(false),
          },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        dirty: {
          on: {
            _edit: { actions: edit },
            _blur: { target: "clean", actions: [save(true), assign({ editing: false })] },
            "journal.changed": { actions: follow(true) },
            "day.selected": select(true),
            _show: select(true),
          },
          after: { throttle: { target: "clean", actions: save(false) } },
        },
      },
      on: {
        // A conflict is settled in one step: the kept copy leaves as a save of its exact
        // text to the day the conflict named, which tells the journal which copy stays
        // (journal's kept). Keeping the copy the journal holds changes no text, yet still
        // lets the journal delete the other record when the two were two records of one date.
        _keepMine: {
          guard: ({ context }) => Boolean(context.conflict),
          target: ".clean",
          actions: [
            keep("mine"),
            assign(({ context }) => ({
              ...(context.picture.open === context.conflict.id ? { draft: { id: context.conflict.id, text: context.conflict.mine.text } } : {}),
              conflict: null,
              editing: false,
            })),
          ],
        },
        _keepTheirs: {
          guard: ({ context }) => Boolean(context.conflict),
          actions: [keep("theirs"), assign({ conflict: null })],
        },
      },
    },
    failed: {},
  },
  // The facts' news (4.3, fourth rule). Each read is superseded by its fact's event (4.2),
  // so none arrives before the starting picture it updates.
  on: {
    // Lines the user finished (the view sends them before the blur that also finishes them).
    _finished: { actions: enqueueActions(({ context, event, enqueue }) => finish(context, enqueue, event.lines)) },
    // line-checks' report for the day shown: from the read, or announced after a check.
    _checks: {
      guard: ({ context, event }) => event.id === context.checkedId && event.reply?.source != null,
      actions: assign({ checks: ({ event }) => event.reply }),
    },
    "text.checked": {
      guard: ({ context, event }) => event.source.kind === "day" && event.source.id === context.checkedId,
      actions: assign({ checks: ({ event }) => event }),
    },
    "journal.changed": { actions: assign(({ event }) => ({ picture: picture(event) })) },
    "journal.conflicted": { actions: assign(({ event }) => ({ conflict: { id: event.id, mine: event.mine, theirs: event.theirs } })) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null }) },
    "day.selected": { actions: assign(({ event }) => ({ selected: event.id, chapter: null, dayPicked: true })) },
    _show: { actions: assign(({ event }) => ({ selected: null, chapter: event.chapter })) },
    _quit: { actions: quit },
    "book.opened": { actions: followBook },
    "chapter.selected": { actions: followBook },
    _book: {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ asking: context.asking.filter((x) => x !== event.id) });
        if (event.known) enqueue.assign({ written: { ...context.written, [event.id]: event.written } });
        if (event.written && context.want?.id === event.id && !context.want.keep) enqueue.raise({ type: "_show", chapter: context.want.chapter });
      }),
    },
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, blocks a blank line apart as paragraphs are.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    // A click on a source link, or Enter on it in Vim's normal mode, on any day: ask notes
    // for the highlight. A second follow replaces one still waiting.
    _follow: {
      actions: [
        stopChild("follow"),
        spawnChild("follow", { id: "follow", input: ({ context, event }) => ({ ask: context.ask, id: event.id }) }),
      ],
    },
    // The highlight's reply: the book opens at the passage (passage.selected), or the
    // highlight is gone and its tag turns grey.
    _followed: [
      {
        guard: ({ event }) => passageOf(event.reply, event.id) != null,
        actions: [
          assign({ removed: ({ context, event }) => without(context.removed, event.id) }),
          emit(({ event }) => ({ type: "passage.selected", ...passageOf(event.reply, event.id) })),
          // The bus never hands an emitter its own event (4.1), so a link to another journal
          // day is shown from here.
          enqueueActions(({ event, enqueue }) => enqueue.raise({ type: "_passage", ...passageOf(event.reply, event.id) })),
        ],
      },
      {
        guard: ({ event }) => event.reply?.error === "not-found",
        actions: assign({ removed: ({ context, event }) => [...without(context.removed, event.id), event.id] }),
      },
    ],
    // Following a link, from here or from another view, to a highlight on a journal day.
    "passage.selected": { actions: toPassage },
    _passage: { actions: toPassage },
    // The note the Notes panel shows, which Add to note adds a passage to.
    "note.opened": { actions: assign({ opened: ({ event }) => event.id, openSeen: true }) },
    _highlight: { actions: makeHighlight },
    _merged: { actions: finishMerge },
    // Add to note: the user's gesture, which notes records as one step (4.3, fifth rule; 12).
    _addToNote: {
      guard: ({ context, event }) => context.highlights.some((h) => h.id === event.id) && addToNote(context, event.id)?.enabled === true,
      actions: emit(({ context, event }) => ({ type: "passage.added", note: context.opened, highlight: event.id })),
    },
    // A highlight is a note (13), deleted at once, one step with the short notice (12, Undo).
    _remove: {
      guard: ({ context, event }) => context.highlights.some((h) => h.id === event.id),
      actions: emit(({ event }) => ({ type: "note.discarded", id: event.id })),
    },
    // Announced whether or not the clipboard took it, so an editor's Vim register still gets
    // it. The bus never hands an emitter its own event (4.1), so this editor's register is
    // filled here, for a p on today's page.
    _copyText: {
      guard: ({ event }) => typeof event.text === "string" && event.text.trim() !== "",
      actions: [({ context, event }) => context.pushRegister?.(event.text), emit(({ event }) => ({ type: "text.copied", text: event.text }))],
    },
    _copyLink: {
      guard: ({ context, event }) => context.highlights.some((h) => h.id === event.id),
      actions: [
        ({ context, event }) => context.pushRegister?.(sourceLink(event.id, context.highlights.find((h) => h.id === event.id).quote)),
        emit(({ context, event }) => ({ type: "link.copied", id: event.id, text: sourceLink(event.id, context.highlights.find((h) => h.id === event.id).quote) })),
      ],
    },
    // The comment box: its text comes from notes, and leaving it saves the highlight's title
    // and body, one step (12, Undo). A comment left as it was saves nothing.
    _commentOpen: {
      actions: [
        stopChild("comment"),
        spawnChild("readComment", { id: "comment", input: ({ context, event }) => ({ ask: context.ask, id: event.id }) }),
      ],
    },
    _commentRead: {
      guard: ({ event }) => event.note != null,
      actions: assign({ comment: ({ event }) => ({ id: event.id, body: event.note.body ?? "", version: event.note.version }) }),
    },
    _commentSave: {
      guard: ({ context, event }) => context.comment != null && event.body !== context.comment.body,
      actions: [
        emit(({ context, event }) => ({ type: "note.saved", id: context.comment.id, title: titleOf(event.body), body: event.body, baseVersion: context.comment.version, left: true })),
        assign({ comment: ({ context, event }) => ({ ...context.comment, body: event.body }) }),
      ],
    },
    _commentClose: { actions: [stopChild("comment"), assign({ comment: null })] },
    // notes' news (4.3, fourth rule): a note made, changed or brought back exists; a
    // deleted one does not.
    "note.changed": {
      actions: assign(({ context, event }) => ({
        notes: context.notes === null || context.notes.includes(event.id) ? context.notes : [...context.notes, event.id],
        removed: without(context.removed, event.id),
        highlights: foldHighlight(context.highlights, event),
        holding: foldHolding(context.holding, event),
        comment: context.comment?.id === event.id && Number.isInteger(event.version) ? { ...context.comment, version: event.version } : context.comment,
      })),
    },
    "note.deleted": {
      actions: assign(({ context, event }) => ({
        notes: context.notes === null ? null : without(context.notes, event.id),
        removed: context.notes === null ? [...without(context.removed, event.id), event.id] : context.removed,
        highlights: context.highlights.filter((h) => h.id !== event.id),
        holding: foldHolding(context.holding, { id: event.id }),
        comment: context.comment?.id === event.id ? null : context.comment,
      })),
    },
    // evaluators' news, for the "#" picker.
    "evaluator.changed": { actions: assign({ evaluators: ({ context, event }) => withEvaluator(context.evaluators, event.evaluator) }) },
    "evaluator.deleted": { actions: assign({ evaluators: ({ context, event }) => context.evaluators.filter((e) => e.id !== event.id) }) },
    "book.changed": { actions: assign(({ context, event }) => ({ written: { ...context.written, [event.id]: event.written === true } })) },
    "book.deleted": {
      actions: assign(({ context, event }) => {
        const { [event.id]: _gone, ...written } = context.written;
        return { written };
      }),
    },
  },
});
