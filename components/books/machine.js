import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { ulid } from "ulid";

// The fact component that owns the books (3.1), replicated (5): local-first, the
// single place a book's metadata and reading position live in the browser. Unlike
// notes, a book is only ever created signed in — the source epub lives nowhere but
// the server, so an import is an upload, not a local mint. The row
// carries what rides the bus; the chapters and images are files the reader fetches
// by URL (Decision 2), so this fact never holds a blob. A reading position is last
// write wins: it queues in the outbox and drains like a note, but the server never
// refuses it (Decision 4). Everything with a side effect — the store, the clock,
// the network, the ask — arrives through input, so this stays a pure definition
// importable in Node.

// A tombstone is kept for the pull (5) but is not a book anyone reads or lists; the
// deleted flag never rides book.changed or a reply (all additionalProperties:false).
const visible = (record) => record && !record.deleted;

// The journal, owned by `journal`, presented as one more book under a fixed id. This
// fact stores nothing for it: the record is derived from journal: read and followed
// through journal.changed, the way `subject` derives what it shows (3.1). Its chapters
// are the days oldest first, so a chapter's number never shifts as days are added, and
// one more empty chapter at the end is today's page while no day is open. It is the
// same whether signed in or out; the views decide what to show signed out (14). Each chapter names
// its day, so a view can join what other facts keep by day to the contents.
export const JOURNAL = "00000000000000000000000JRN";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD, the form a journal day carries.
const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A day as a chapter title, "Tuesday 13 October", with the year only when it is not
// this year's.
export const dayTitle = (day, now) => {
  const [y, m, d] = day.split("-").map(Number);
  const title = `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${d} ${MONTHS[m - 1]}`;
  return y === new Date(now).getFullYear() ? title : `${title} ${y}`;
};

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A day's text as the chapter's HTML, so the chat reads the journal like any book. The
// levels ride the text as `# `, `## ` and `### ` line prefixes, the wire format of a note
// body, and a heading is a block of its own. Paragraphs are apart by a blank line and a
// single newline breaks the line inside one, the editor kit's text rule (10).
export function htmlOf(text) {
  const blocks = [];
  let lines = [];
  const close = () => {
    if (lines.length) blocks.push(`<p>${lines.map(escape).join("<br>")}</p>`);
    lines = [];
  };
  for (const line of text.split("\n")) {
    const level = /^(#{1,3}) /.exec(line);
    if (line.trim() === "") close();
    else if (level) {
      close();
      const n = level[1].length;
      blocks.push(`<h${n}>${escape(line.slice(level[0].length))}</h${n}>`);
    } else lines.push(line);
  }
  close();
  return blocks.join("");
}

// A book's place on the shelf is a fractional index (5, an item's place is last write
// wins): a string that sorts by plain code-unit comparison, so a book placed between two
// others takes a key between theirs and no other book changes. The digits are in ASCII
// order, and a key never ends in the smallest digit, so there is always room before it.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
const isShelfPlace = (value) => typeof value === "string" && value.length <= 200 && KEY.test(value);

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

// A key strictly between `after` and `before`, either null for the shelf's end. Out of
// order neighbours (a place computed against a shelf that changed meanwhile) place the
// book just after `after`.
function between(after, before) {
  const a = isShelfPlace(after) ? after : "";
  const b = isShelfPlace(before) && before > a ? before : null;
  return midpoint(a, b);
}

// A book never placed keeps the order it had, newest first: its key is read from when it
// was added, "z" and eight digits counting down from the largest time, then its id, so it
// sorts after every key `between` makes for a new book and among its kind by time. It is
// the same on every device, because the time and id come from the server.
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
const placeOf = (record) =>
  isShelfPlace(record.shelfPlace) ? record.shelfPlace : `z${countdown(record.addedAt ?? 0)}${record.id}V`;

// The journal book from journal: read's picture, or null when there is no journal to
// show (no `journal` on the page answers no-answerer). texts holds each chapter's day
// text for chapter?; it never rides book.changed or a reply. Versions are added by
// applyJournal, which alone knows whether anything changed.
function journalBook(picture, now) {
  if (!picture || !Array.isArray(picture.days)) return null;
  const days = picture.days.map((d) => ({ day: d.day, text: d.text }));
  // Today is the journal's to say (13, Journal); the device's date stands in for an older answer.
  if (picture.open == null) days.push({ day: picture.today ?? dateOf(now), text: "" });
  const chapters = days.map((d) => ({ title: dayTitle(d.day, now), day: d.day }));
  return {
    id: JOURNAL,
    title: "Journal",
    author: "You",
    cover: null,
    chapters,
    toc: chapters.map((c, i) => ({ title: c.title, chapter: i, block: 0, children: [] })).reverse(),
    position: { chapter: chapters.length - 1, block: 0 },
    addedAt: 0,
    updatedAt: picture.days.reduce((latest, d) => Math.max(latest, d.editedAt), 0),
    written: true,
    texts: days.map((d) => d.text),
  };
}

// The journal now looks like `picture`: announce the book only when what it shows
// changed, with a version one higher so a view following versions takes it. A journal
// that appears for the first time while it is the open book is announced open too, since
// an open? answered before it arrived said nothing was open.
function applyJournal(context, picture, enqueue) {
  const next = journalBook(picture, context.now());
  if (!next) return;
  const held = context.journal;
  if (held) {
    const { version: _v, contentVersion: _c, ...base } = held;
    if (JSON.stringify(base) === JSON.stringify(next)) return;
  }
  const version = (held?.version ?? 0) + 1;
  const record = { ...next, version, contentVersion: version };
  context.journal = record;
  enqueue.assign({ journal: record });
  enqueue.emit(changed(record, false));
  if (!held && context.open.id === JOURNAL) enqueue.emit({ type: "book.opened", id: JOURNAL });
}

// journal: read has answered, whatever it said: every list that waited for it is answered.
function answerWaitingLists(context, enqueue) {
  context.journalAnswered = true;
  enqueue.assign({ journalAnswered: true });
  for (const reply of context.listsWaiting.splice(0)) replyList(context, reply);
}

// The book a reader can open under `id`: the journal, or a visible imported book.
const bookFor = (context, id) => (id === JOURNAL ? context.journal : visible(context.books.get(id)) ? context.books.get(id) : null);

// The record kept in the cache, from a server row: the book.changed shape plus the
// tombstone flag, built field by field so nothing stray is stored or later emitted.
// title is the display title (the user's when set, else the file's); fileTitle is the
// file's own, kept only so an empty rename can restore it locally at once (D11); it
// never rides book.changed or a reply. author and fileAuthor follow the same rule.
const serverRecord = (b) => ({
  id: b.id,
  title: b.title,
  fileTitle: b.fileTitle ?? b.title,
  author: b.author,
  fileAuthor: b.fileAuthor ?? b.author,
  cover: b.cover ?? null,
  chapters: b.chapters,
  toc: b.toc,
  position: b.position,
  version: b.version,
  contentVersion: b.contentVersion,
  addedAt: b.addedAt,
  updatedAt: b.updatedAt,
  deleted: Boolean(b.deleted),
  shelfPlace: b.shelfPlace ?? null,
});

// The steps that last wrote a book in this browser (12, Undo): `step` whether it is on
// the shelf, `nameStep` its title and author; the server never has them. The server's
// answer to this browser's own write keeps both, and so does a pulled write that leaves
// either as it was, so a page turn never refuses an Undo; anything else that changed it does.
function carry(context, held, record, own = false) {
  if (!held) return record;
  const kept = { ...record };
  if (held.step && (own || Boolean(held.deleted) === Boolean(record.deleted))) kept.step = held.step;
  if (held.nameStep && (own || (held.title === record.title && held.author === record.author))) kept.nameStep = held.nameStep;
  // A place of this browser still on its way stands over what the server answered (5);
  // otherwise the server's stands, since a pull skips a row no newer than this one.
  if (context.outbox.has(`shelf:${record.id}`)) kept.shelfPlace = held.shelfPlace;
  return kept;
}

// The book.changed payload, built once so its shape (7.1) is in one place. pending
// reports a local change the server has not acknowledged (5).
const bookOf = (record, pending) => ({
  id: record.id,
  title: record.title,
  author: record.author,
  cover: record.cover,
  chapters: record.chapters,
  toc: record.toc,
  position: record.position,
  version: record.version,
  contentVersion: record.contentVersion,
  pending,
  addedAt: record.addedAt,
  updatedAt: record.updatedAt,
  ...(record.written ? { written: true } : {}),
});

// The place rides only here and on a tile: the closed `read` reply does not name it, and
// the journal has none, since it is always first.
const changed = (record, pending) => ({
  type: "book.changed",
  ...bookOf(record, pending),
  ...(record.written ? {} : { shelfPlace: placeOf(record) }),
});

// A book has a local change not yet acknowledged when it has an outbox row — a
// position or delete keyed by the book id, or a title keyed under `title:<id>` (kept
// apart so a rename never overwrites a pending page turn, D11).
const pendingFor = (context, id) =>
  context.outbox.has(id) ||
  context.outbox.has(`title:${id}`) ||
  context.outbox.has(`adopt:${id}`) ||
  context.outbox.has(`restore:${id}`) ||
  context.outbox.has(`shelf:${id}`);

const tile = (context, r) => ({
  id: r.id,
  title: r.title,
  author: r.author,
  cover: r.cover,
  position: r.position,
  chapterCount: r.chapters.length,
  pending: pendingFor(context, r.id),
  addedAt: r.addedAt,
  ...(r.written ? { written: true } : { shelfPlace: placeOf(r) }),
});

// List order: by key, then by id where two keys are equal.
const byPlace = (a, b) =>
  a.shelfPlace < b.shelfPlace ? -1 : a.shelfPlace > b.shelfPlace ? 1 : a.id.localeCompare(b.id);

// The journal first, then the imported books in the order the user set.
function replyList(context, reply) {
  // An answer without the journal would tell the stage its tab is gone (book-stage), so a
  // list asked before journal: read has answered waits for that answer.
  if (!context.journalAnswered) {
    context.listsWaiting.push(reply);
    return;
  }
  const books = [...context.books.values()]
    .filter(visible)
    .map((r) => tile(context, r))
    .sort(byPlace);
  reply({ books: context.journal ? [tile(context, context.journal), ...books] : books });
}

function replyRead(context, id, reply) {
  const record = bookFor(context, id);
  reply(record ? { book: bookOf(record, pendingFor(context, id)) } : { error: "not-found" });
}

// The open book (4.3): the id only when that book is still one this device can read, so
// a tombstoned or pulled-away book never opens; null otherwise.
function replyOpen(context, reply) {
  const id = context.open.id;
  reply({ id: bookFor(context, id) ? id : null });
}

// A chapter's HTML, or an honest error: the journal's from the day's text without the
// network, an imported book's by a fetch the browser's HTTP cache answers on repeat
// (Decision 2). A 401 is not the server being down, it is the session being gone: the
// machine is told to sign out, so the views hide and the notice says so (14), and the
// answer is unavailable, so the reader offers to try again once the user has signed in.
function htmlFor(context, id, record, chapter, self) {
  if (record.written) return Promise.resolve({ html: htmlOf(record.texts[chapter]) });
  // A book still on its way to the account (adopt), or brought back by an Undo whose
  // restore write is not answered yet, has no chapters there yet.
  if (context.api == null || context.outbox.has(`adopt:${id}`) || context.outbox.has(`restore:${id}`))
    return Promise.resolve({ error: "unavailable" });
  return Promise.resolve(context.api.chapter(id, record.contentVersion, chapter))
    .then((res) => {
      if (res && res.error === "unauthorized") {
        self?.send({ type: "_sessionEnded", id });
        return { error: "unavailable" };
      }
      return res && res.error ? { error: res.error } : { html: res.html };
    })
    .catch(() => ({ error: "unavailable" }));
}

// A chapter is a file, so answering is a fetch. The reply is a callback, so the fetch
// runs fire-and-forget alongside the machine rather than in a state: two chapters in
// flight never wait on each other, and the machine's own flow is untouched. A missing
// book or an index past the end is not-found without a round trip.
function answerChapter(context, event, self) {
  const { id, chapter } = event.payload;
  const record = bookFor(context, id);
  if (!record || chapter < 0 || chapter >= record.chapters.length) {
    event.reply({ error: "not-found" });
    return;
  }
  htmlFor(context, id, record, chapter, self).then((res) =>
    event.reply(res.error ? { error: res.error } : { title: record.chapters[chapter].title, html: res.html }),
  );
}

// Elements that hold nothing, so they close themselves (the HTML parser's void elements).
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) =>
    name[0] === "#"
      ? String.fromCodePoint(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
      : ENTITIES[name.toLowerCase()] ?? whole,
  );

// A chapter's blocks as the reader counts them (12): each element at the top of the
// chapter's HTML is one block, and its text is the text of everything inside it, joined
// as it stands, so a block's number here is the number a reading place carries. The
// server writes each chapter as strict blocks (books/server/importer.py `_blocks_of`) and
// the reader parses it with the browser (book-reader `#blockTexts`); text between blocks
// is not a block, as the reader counts only elements.
export function blockTexts(html) {
  const texts = [];
  let depth = 0;
  for (const m of String(html ?? "").matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|<[^>]*>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      if (depth > 0) texts[texts.length - 1] += decode(m[4]);
    } else if (m[2] === undefined) {
      continue;
    } else if (m[1] === "/") {
      depth = Math.max(0, depth - 1);
    } else {
      if (depth === 0) texts.push("");
      if (!VOID.has(m[2].toLowerCase()) && !m[3].trimEnd().endsWith("/")) depth += 1;
    }
  }
  return texts;
}

// books: place takes the paragraph at the reading place whole, and then the next ones
// while the text stays within PLACE_WORDS words; a first paragraph longer than that is
// cut at it. Blocks with no text (a picture) are passed over.
export const PLACE_WORDS = 300;
export function placeFrom(texts, block) {
  const at = Math.min(Math.max(0, block), Math.max(0, texts.length - 1));
  const taken = [];
  let words = 0;
  for (let b = at; b < texts.length; b += 1) {
    const w = texts[b].split(/\s+/).filter(Boolean);
    if (w.length === 0) continue;
    if (taken.length === 0 && w.length > PLACE_WORDS) {
      taken.push(`${w.slice(0, PLACE_WORDS).join(" ")}…`);
      words = PLACE_WORDS;
      break;
    }
    if (taken.length > 0 && words + w.length > PLACE_WORDS) break;
    taken.push(w.join(" "));
    words += w.length;
  }
  return { block: at, text: taken.join("\n\n"), words };
}

// books: place, where the reader is in the open book: its chapter, by number and title,
// and the text at the reading place. Nothing open answers { id: null }.
function answerPlace(context, event, self) {
  const id = context.open.id;
  const record = bookFor(context, id);
  if (!record) {
    event.reply({ id: null });
    return;
  }
  if (record.chapters.length === 0) {
    event.reply({ error: "not-found" });
    return;
  }
  const { chapter = 0, block = 0 } = record.position ?? {};
  const at = Math.min(Math.max(0, chapter), record.chapters.length - 1);
  htmlFor(context, id, record, at, self).then((res) =>
    event.reply(
      res.error
        ? { error: res.error }
        : { id, title: record.title, author: record.author, chapter: at, chapterTitle: record.chapters[at].title, ...placeFrom(blockTexts(res.html), block) },
    ),
  );
}

// A chapter asked for while the cache could not load: the journal still answers, an
// imported book's chapter is honestly unavailable.
const answerUnloaded = (context, event) =>
  event.payload.id === JOURNAL ? answerChapter(context, event) : event.reply({ error: "unavailable" });

// The user picked a file (book-shelf emits book.picked, 4.3 fifth rule). Signed out
// it is refused and the object URL revoked, since the file lives only on the server;
// nothing is minted anonymously.
// Signed in the upload runs fire-and-forget so a long upload never blocks a position
// drain, and its result returns as _uploaded, which the machine turns into news.
function applyPick(context, event, enqueue, self) {
  const { id, url } = event;
  if (context.userId == null) {
    enqueue.emit({ type: "book.refused", id, reason: "signed-out" });
    enqueue(() => {
      if (context.revoke) context.revoke(url);
    });
    return;
  }
  enqueue(() => {
    Promise.resolve(context.api.upload(id, url))
      .then((res) => self.send({ type: "_uploaded", id, res: res || { error: "unavailable" } }))
      .catch(() => self.send({ type: "_uploaded", id, res: { error: "unavailable" } }));
  });
}

// A key before every book on the shelf.
function firstPlace(context) {
  let min = null;
  for (const record of context.books.values()) {
    if (!visible(record)) continue;
    const p = placeOf(record);
    if (min === null || p < min) min = p;
  }
  return between(null, min);
}

// The row that sends a book's place, kept apart from a pending position or delete, so each
// reaches the server; a newer place replaces one still waiting.
function queuePlace(context, enqueue, record) {
  const row = { id: `shelf:${record.id}`, kind: "shelf", book: record.id, shelfPlace: record.shelfPlace };
  context.outbox.set(row.id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
}

// An upload finished. 200 caches the row and announces it; 422 (not an epub) and a
// network or server error are refusals a view shows; a 401 also drops the session.
function applyUploaded(context, event, enqueue) {
  const { id, res } = event;
  if (res.error === "unauthorized") {
    signOut(context, enqueue, { notifyId: id, sawReject: true });
    return;
  }
  if (res.error) {
    enqueue.emit({ type: "book.refused", id, reason: res.error });
    return;
  }
  // Adding a book is one step (12, Undo): its Undo deletes the book again and its Redo
  // brings it back with a restore write, so the file is never imported twice.
  const step = context.mint();
  // A new book goes first among the books (5), also ahead of one moved to the top.
  const record = { ...serverRecord(res.row), step, shelfPlace: firstPlace(context) };
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  queuePlace(context, enqueue, record);
  enqueue.emit(changed(record, true));
  enqueue.raise({ type: "_drain" });
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "books",
    label: `add ${nameOf(record)}`,
    undo: { kind: "book", id, deleted: true },
    redo: { kind: "book", id, deleted: false },
  });
}

// The user turned to a new place (book-reader emits book.progressed). The position
// changes locally at the held version, queues coalesced by id, is announced pending,
// and a drain is asked for; the server never refuses it (Decision 4). A missing or
// tombstoned book, or an unchanged place, is ignored; so is the journal, whose place is
// always today.
function applyProgress(context, event, enqueue) {
  const { id, chapter, block } = event;
  const current = context.books.get(id);
  if (!current || current.deleted) return;
  if (current.position.chapter === chapter && current.position.block === block) return;
  const record = { ...current, position: { chapter, block }, updatedAt: context.now() };
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const row = { id, kind: "position", chapter, block };
  context.outbox.set(id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit(changed(record, true));
  enqueue.raise({ type: "_drain" });
}

// The user renamed a book (book-shelf emits book.renamed, 4.3 fifth rule): give it a
// user title and author at once, announce it pending, and queue the write, last write
// wins and never refused like a position (D11). A trimmed empty string restores the
// file's title or author, which the cache keeps as fileTitle and fileAuthor so the
// change shows without a round trip. The row is keyed under `title:<id>`, apart from a
// pending position or delete, so a rename and a page turn for the same book both reach
// the server; it carries only the fields that changed, merged into a row still waiting,
// so a later author change never drops an unsent title. A missing or tombstoned book,
// or a rename that changes nothing, is ignored, and so is the journal, which is never
// in the cache. An event without an author leaves the author as it is. Every rename is
// one step (12, Undo), whose Undo gives back the title and author the book showed.
function applyRename(context, event, enqueue) {
  const { id } = event;
  const current = context.books.get(id);
  if (!current || current.deleted) return;
  const before = givenName(current);
  const after = {
    title: (event.title || "").trim(),
    author: typeof event.author === "string" ? event.author.trim() : before.author,
  };
  const step = context.mint();
  if (!writeName(context, enqueue, current, after, step)) return;
  const prior = current.nameStep ? { prior: current.nameStep } : {};
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "books",
    label: `rename ${nameOf(current)}`,
    undo: { kind: "name", id, ...before, ...prior },
    redo: { kind: "name", id, ...after, ...prior },
  });
}

// The title and author as a rename sends them: what the user gave, or an empty string
// where the book shows what its file says.
const givenName = (r) => ({
  title: r.title === (r.fileTitle ?? r.title) ? "" : r.title,
  author: r.author === (r.fileAuthor ?? r.author) ? "" : r.author,
});

// What a step is about, as people read it after "Undo:".
const NAME_MAX = 40;
function nameOf(record) {
  const title = String(record.title ?? "").trim();
  if (!title) return "a book";
  return `book ${title.length > NAME_MAX ? `${title.slice(0, NAME_MAX).trimEnd()}…` : title}`;
}

// Give a book a title and author in the shape a rename sends, stamped with the step that
// wrote it; false when that changes nothing, and then nothing is written.
function writeName(context, enqueue, current, name, nameStep) {
  const { id } = current;
  const fields = {};
  const title = name.title || current.fileTitle || current.title;
  if (title !== current.title) fields.title = name.title;
  const author = name.author || (current.fileAuthor ?? current.author);
  if (author !== current.author) fields.author = name.author;
  if (Object.keys(fields).length === 0) return false;
  const record = { ...current, title, author, nameStep, updatedAt: context.now() };
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const row = { ...context.outbox.get(`title:${id}`), id: `title:${id}`, kind: "title", book: id, ...fields };
  context.outbox.set(row.id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit(changed(record, true));
  enqueue.raise({ type: "_drain" });
  return true;
}

// The user opened a book (book-shelf emits book.selected, book-stage book.switched; 4.3 fifth rule): record it
// as the open book, announce it (book.opened), and queue the single last-write-wins
// outbox row so a reload or another device opens it too (5). An unknown or tombstoned
// id, or the already-open one, is ignored. The book's own version is untouched. The
// journal opens like any book and is kept open the same way.
function applySelect(context, event, enqueue) {
  const { id } = event;
  if (!bookFor(context, id) || context.open.id === id) return;
  const open = { id, at: context.now() };
  context.open = open;
  enqueue(() => context.store.metaPut("open", open).catch(() => {}));
  const row = { id: "open", kind: "open", book: id };
  context.outbox.set("open", row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit({ type: "book.opened", id });
  enqueue.raise({ type: "_drain" });
}

// The user deleted a book (book-shelf emits book.discarded, 4.3 fifth rule): it happens
// at once and is one step, shown with the short notice (12, Undo). The journal is never in
// the cache, so it is never deleted here.
function applyDiscard(context, event, enqueue) {
  const { id } = event;
  const current = context.books.get(id);
  if (!current || current.deleted) return;
  const step = context.mint();
  tombstone(context, enqueue, current, step);
  const prior = current.step ? { prior: current.step } : {};
  // The place the book stood at is written down, so an Undo brings it back there even after
  // a p put it elsewhere and that p was undone.
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "books",
    label: `delete ${nameOf(current)}`,
    undo: { kind: "book", id, deleted: false, shelfPlace: placeOf(current), ...prior },
    redo: { kind: "book", id, deleted: true, ...prior },
    notice: true,
  });
}

// The user brought back the book they deleted (book-shelf emits book.restored on Vim's p
// or P, 12): the restore write an Undo of its delete uses, as one step after the delete's,
// so its Undo deletes the book again and the delete's own Undo then brings it back. It comes
// back between the neighbours the shelf names; an event that names none leaves its place. A
// book that is not a tombstone, or whose files went when its delete step left the undo list
// (purge), is left as it is.
function applyRestore(context, event, enqueue) {
  const { id } = event;
  const current = context.books.get(id);
  if (!current?.deleted || current.purged) return;
  const step = context.mint();
  const neighbour = (other) => {
    const record = other ? context.books.get(other) : null;
    return visible(record) && other !== id ? placeOf(record) : null;
  };
  const shelfPlace = "after" in event || "before" in event ? between(neighbour(event.after), neighbour(event.before)) : placeOf(current);
  restore(context, enqueue, current, step, shelfPlace);
  const prior = current.step ? { prior: current.step } : {};
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "books",
    label: `restore ${nameOf(current)}`,
    undo: { kind: "book", id, deleted: true, ...prior },
    redo: { kind: "book", id, deleted: false, shelfPlace, ...prior },
  });
}

// Mark a book a tombstone and announce it gone: queue a delete (which replaces any
// pending position, Decision 6, or a restore not yet sent) and drain. The server keeps
// the book's files, so a restore write (5) can bring it back.
function tombstone(context, enqueue, current, step) {
  const { id } = current;
  const { step: _, ...kept } = current;
  const record = { ...kept, deleted: true, updatedAt: context.now(), ...(step ? { step } : {}) };
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const row = { id, kind: "delete" };
  // A book not yet added to the account (adopt) is not uploaded only to be deleted.
  if (context.outbox.delete(`adopt:${id}`)) enqueue(() => context.store.outboxDelete(`adopt:${id}`).catch(() => {}));
  if (context.outbox.delete(`restore:${id}`)) enqueue(() => context.store.outboxDelete(`restore:${id}`).catch(() => {}));
  context.outbox.set(id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit({ type: "book.deleted", id });
  // The open book was just deleted: nothing is open. The views empty on book.deleted;
  // this keeps a later open? honest and stops a pull re-opening a tombstone.
  if (context.open.id === id) forgetOpen(context, enqueue);
  enqueue.raise({ type: "_drain" });
}

// Clear the open book locally: no book is open, and the open outbox row (if it named
// this book) goes, so a drain does not re-assert it. The server copy is left for the
// next real open to overwrite; last write wins means an old open never resurfaces.
function forgetOpen(context, enqueue) {
  context.open = { id: null, at: context.now() };
  enqueue(() => context.store.metaPut("open", context.open).catch(() => {}));
  if (context.outbox.has("open")) {
    context.outbox.delete("open");
    enqueue(() => context.store.outboxDelete("open").catch(() => {}));
  }
}

// --- Steps (12, Undo) -------------------------------------------------------------------

// A deleted book brought back. Signed in it rides a restore write (5), sent before any
// other row, naming the tombstone's version once its delete is acknowledged; a delete not
// yet sent is simply taken out of the outbox. A place given that differs is sent as well,
// after the restore write (RANK), so it never lands on the tombstone.
function restore(context, enqueue, current, step, shelfPlace) {
  const { id } = current;
  const placed = isShelfPlace(shelfPlace) && shelfPlace !== placeOf(current);
  const record = { ...current, deleted: false, step, updatedAt: context.now(), ...(placed ? { shelfPlace } : {}) };
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  if (context.outbox.get(id)?.kind === "delete") {
    context.outbox.delete(id);
    enqueue(() => context.store.outboxDelete(id).catch(() => {}));
  }
  const row = { id: `restore:${id}`, kind: "restore", book: id };
  context.outbox.set(row.id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  if (placed) queuePlace(context, enqueue, record);
  enqueue.emit(changed(record, true));
  enqueue.raise({ type: "_drain" });
}

// `prior` is the step that wrote a book before this one, so an Undo leaves it as that
// step left it and the step before can be undone next; a book no step of this browser
// wrote is left stamped with a mark of the step undone.
const priorStamp = (entry, step) => entry.prior ?? `^${step}`;

// A book whose content a step left as it was still takes that step's stamp, so the next
// step can be checked against it.
function stamp(context, enqueue, current, stamps) {
  const record = { ...current, ...stamps };
  context.books.set(record.id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
}

// An Undo or Redo of one of this fact's steps. It is applied only while what it would
// reverse is as the step left it: whether the book is on the shelf, or its title and
// author, was last written in this browser by that step. Anything written since, here,
// in another tab or on another device, refuses it.
function applyStep(context, event, enqueue) {
  if (event.owner !== "books") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "books", outcome, ...(reason ? { reason } : {}) });
  const p = event.payload ?? {};
  const current = typeof p.id === "string" ? context.books.get(p.id) : null;
  const undoing = event.type === "step.undone";
  const expected = (entry) => (undoing ? event.id : priorStamp(entry, event.id));
  const leaves = (entry) => (undoing ? priorStamp(entry, event.id) : event.id);
  if (p.kind === "book" && current && typeof p.deleted === "boolean") {
    if (current.step !== expected(p)) return settle("refused", "changed");
    if (p.deleted === Boolean(current.deleted)) stamp(context, enqueue, current, { step: leaves(p) });
    else if (p.deleted) tombstone(context, enqueue, current, leaves(p));
    else restore(context, enqueue, current, leaves(p), p.shelfPlace);
    return settle("applied");
  }
  if (p.kind === "name" && visible(current) && typeof p.title === "string" && typeof p.author === "string") {
    if (current.nameStep !== expected(p)) return settle("refused", "changed");
    if (!writeName(context, enqueue, current, { title: p.title, author: p.author }, leaves(p)))
      stamp(context, enqueue, current, { nameStep: leaves(p) });
    return settle("applied");
  }
  settle("refused", "changed");
}

// A book's delete step left the undo list (12, Undo): it can never come back now, so its
// files on the server go (5). Only while the book is still the tombstone that step made.
function purge(context, event) {
  const p = event.payload ?? {};
  if (event.owner !== "books" || p.kind !== "book" || p.deleted !== true || typeof p.id !== "string") return;
  const current = context.books.get(p.id);
  if (!current?.deleted || current.step !== event.id || context.userId == null || !context.api?.purge) return;
  // Marked, so the shelf's p (applyRestore) no longer offers a book the server cannot bring back.
  const record = { ...current, purged: true };
  context.books.set(p.id, record);
  context.store.put(record).catch(() => {});
  Promise.resolve()
    .then(() => context.api.purge(p.id))
    .catch(() => {});
}

// The session ended, however it ended (a deliberate sign-out, a cookie gone across a
// restart, or a 401 from any call): the one routine every such path funnels through, so
// signed out always means the same thing. Signed out hides the account's work, it does
// not remove it (14): the views stop showing it, while the cache, the outbox and the
// open book stay, nothing is announced gone, and syncing stops until someone signs in.
// The account the copy belongs to stays in the meta, so a sign-in by another account
// still empties it first (switchAccount). notifyId names the book a user gesture was
// refused on, so a 401 the user provoked (a chapter fetch, an upload) says "signed out"
// through the notice; a background sync or a cold-load reconcile passes none. sawReject
// is set when the server rejected our cookie (a 401): session.rejected tells `session`
// to re-check and flip the auth control at once (3.4), rather than at the next focus. A
// deliberate sign-out or a cold-load reconcile does not set it — session already knows
// who is signed in in those cases.
function signOut(context, enqueue, { notifyId, sawReject } = {}) {
  context.userId = null;
  enqueue.assign({ userId: null });
  if (notifyId) enqueue.emit({ type: "book.refused", id: notifyId, reason: "signed-out" });
  if (sawReject) enqueue.emit({ type: "session.rejected" });
}

// Someone signed in without a reload. A copy kept for another account is emptied before
// it is shown or synced, outbox included, the same rule `claim` keeps at load, so one
// account's books are never shown to or sent under another; a change still waiting to be
// sent is lost, at most the last reading place. Every visible book is announced gone and
// its open book is forgotten;
// the journal is the new account's too, so it stays, and stays open if it was. The maps
// are mutated in place, as applySync does, so what follows in the same block sees the
// emptied library.
function switchAccount(context, enqueue, userId) {
  if (context.account && context.account !== userId) {
    for (const record of context.books.values())
      if (visible(record)) enqueue.emit({ type: "book.deleted", id: record.id });
    context.books.clear();
    context.outbox.clear();
    if (context.open.id !== JOURNAL) context.open = { id: null, at: 0 };
    enqueue(() => context.store.clear().catch(() => {}));
    enqueue(() => context.store.metaPut("open", context.open).catch(() => {}));
  }
  context.userId = userId;
  context.account = userId;
  enqueue.assign({ userId, account: userId, cursor: 0 });
  enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
  enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue, self) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "read?") replyRead(context, message.payload.id, message.reply);
  else if (message.type === "open?") replyOpen(context, message.reply);
  else if (message.type === "chapter?") answerChapter(context, message, self);
  else if (message.type === "place?") answerPlace(context, message, self);
  else if (message.type === "book.picked") applyPick(context, message, enqueue, self);
  else if (message.type === "book.selected" || message.type === "book.switched") applySelect(context, message, enqueue);
  else if (message.type === "passage.selected") applySelect(context, { id: message.book }, enqueue);
  else if (message.type === "chapter.selected") applySelect(context, message, enqueue);
  else if (message.type === "day.selected") applySelect(context, { id: JOURNAL }, enqueue);
  else if (message.type === "book.progressed") applyProgress(context, message, enqueue);
  else if (message.type === "book.renamed") applyRename(context, message, enqueue);
  else if (message.type === "book.discarded") applyDiscard(context, message, enqueue);
  else if (message.type === "book.restored") applyRestore(context, message, enqueue);
  else if (message.type === "step.undone" || message.type === "step.redone") applyStep(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

// The pause after a page turn the network waits for (Decision 4; 5): a further turn
// restarts this window, so a run of turns drains once, not per page. A focus, sign-in
// or hidden tab does not wait; they sync at once.
const SYNC_IDLE_MS = 2000;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The browser changed account while this fact was not on the page (12): a copy kept for
// another account is emptied before it is read, outbox included, so none of it is shown
// to the account now signed in or uploaded as its own. A copy marked to be added to the
// account (12, keep) is kept instead, and `keepFor` sends it. Whether the Mac is now
// connected says where the books' files are (3.4): connected, the change was Connect and
// they are on the Mac's own server; otherwise it was Disconnect and they are on the account.
async function claim(store, ask, api) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, from] = await Promise.all([store.metaGet("userId"), store.metaGet("adopt")]);
  if (kept && kept !== userId && !from) await store.empty();
  await keepFor(store, from, userId, api, session.connect === "on" ? "local" : "remote");
}

// The first book the Mac app gives (3.4): sent with a kept copy only once it was read or
// renamed, so an account never receives the sample unasked.
const FIRST_BOOK = "0000000000000000000000MED1";
const untouched = (book) =>
  book.id === FIRST_BOOK &&
  (book.position?.chapter ?? 0) === 0 &&
  (book.position?.block ?? 0) === 0 &&
  !(book.fileTitle && book.title !== book.fileTitle) &&
  !(book.fileAuthor !== undefined && book.author !== book.fileAuthor);

// The browser joined an account keeping this copy (12, keep). The account is asked for
// every book it holds first: when it already holds one that is not deleted, this copy is
// emptied, outbox included, and the pull from 0 brings the account's books. When it holds
// none, every book gets one outbox row that adds it to the account (kind "adopt", synced
// first): its file is read from `source`, the Mac's own server ("local") or the account
// ("remote"), and imported, then its place and the user's title and author are sent. Either way the
// cursor goes back to 0 and the copy is marked as the account's, so the sign-in path
// (switchAccount) does not empty it again. A tombstone is not sent: the account never had
// the book. The mark is cleared only once every row is stored in the outbox, so a reload
// midway queues the books again (one row per book) rather than losing them; when the
// account cannot be asked (offline), the mark stays and the next load decides. A mark
// left by a change of account that was called off names the account still signed in, and
// is only cleared.
async function keepFor(store, from, userId, api, source) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!Array.isArray(held?.books)) {
      // Undecided: the copy follows the account now signed in, so the sign-in path does
      // not take it for another account's, and the mark stays for the next load.
      await store.metaPut("userId", userId);
      return;
    }
    if (held.books.some((book) => book?.id !== JOURNAL && !book?.deleted)) {
      await store.empty();
    } else {
      for (const book of await store.all()) {
        if (book.deleted || book.id === JOURNAL || untouched(book)) continue;
        const row = { id: `adopt:${book.id}`, kind: "adopt", book: book.id, position: book.position, shelfPlace: placeOf(book), from: source };
        if (book.fileTitle && book.title !== book.fileTitle) row.title = book.title;
        if (book.fileAuthor !== undefined && book.author !== book.fileAuthor) row.author = book.author;
        await store.outboxPut(row);
        // No cover is shown until the account has the file, so its image is never asked of
        // the account before it exists; the account's row brings it back.
        if (book.cover) await store.put({ ...book, cover: null });
      }
    }
    await store.metaPut("cursor", 0);
    await store.metaPut("userId", userId);
  }
  await store.metaPut("adopt", null);
}

// A book being added to the account (adopt) is sent before any other row, so a place or
// a title for it never reaches the account before the book does; a restore write comes
// next, so a place or a title for a book brought back never lands on its tombstone.
const RANK = { adopt: 0, restore: 1 };
const rank = (row) => RANK[row.kind] ?? 2;
const adoptFirst = (a, b) => rank(a) - rank(b) || byId(a, b);

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0 || context.leaving,
    // The browser is changing account (12): empty the local copy once nothing is left
    // to upload.
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store, ask, api } = input;
      await claim(store, ask, api);
      const [books, outbox, cursor, userId, open] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
        store.metaGet("open"),
      ]);
      return { books, outbox, cursor: cursor ?? 0, account: userId ?? null, open: open ?? { id: null, at: 0 } };
    }),
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    journal: fromPromise(({ input }) => (input.ask ? input.ask("journal", "read", {}) : Promise.resolve(null))),
    // Empties the local copy in one transaction, outbox and cache together (12).
    // With keep (12) the copy stays and is marked, under the account it came from, to be
    // added to the account the browser joins after the reload.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // One sync: drain the outbox in id order, then pull what changed since the
    // cursor. Positions and deletes never conflict (Decision 4, 6), so a drained row
    // is simply acknowledged; a network error stops with what it had, a 401 reports
    // the session is gone. The store deletes happen here so a drained row is durably gone.
    sync: fromPromise(async ({ input }) => {
      const { api, store, rows, cursor, pull } = input;
      const acks = [];
      // The account's books, read once before the first book is added (adopt): one it
      // already has, such as the first book with its fixed id, is not uploaded again.
      let held = null;
      for (const row of [...rows].sort(adoptFirst)) {
        let result;
        try {
          if (row.kind === "adopt") {
            if (!held) {
              const all = await api.pull(0);
              if (all.error === "unauthorized") return { acks, authFailed: true };
              held = new Map(all.books.map((b) => [b.id, b]));
            }
            result = held.has(row.book) ? { had: held.get(row.book) } : await api.adopt(row);
            if (result.error === "unauthorized") return { acks, authFailed: true };
            acks.push({ id: row.id, kind: "adopt", book: row.book, ...result });
            await store.outboxDelete(row.id).catch(() => {});
            continue;
          }
          result =
            row.kind === "delete"
              ? await api.remove(row.id)
              : row.kind === "restore"
                ? await api.restore(row.book, row.baseVersion)
              : row.kind === "open"
                ? await api.opened(row.book)
                : row.kind === "title"
                  ? await api.title(row.book, row.title, row.author)
                  : row.kind === "shelf"
                    ? await api.shelf(row.book, row.shelfPlace)
                  : await api.position(row.id, row.chapter, row.block);
        } catch {
          return { acks, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, authFailed: true };
        acks.push({ id: row.id, kind: row.kind, book: row.book, sent: { title: row.title, author: row.author, shelfPlace: row.shelfPlace }, row: result });
        await store.outboxDelete(row.id).catch(() => {});
      }
      if (!pull) return { acks };
      let pulled;
      try {
        pulled = await api.pull(cursor);
      } catch {
        return { acks, networkError: true };
      }
      if (pulled.error === "unauthorized") return { acks, authFailed: true };
      return { acks, pulled: pulled.books, newCursor: pulled.cursor, pulledOpen: pulled.open };
    }),
  },
}).createMachine({
  id: "books",
  meta: {
    description:
      "Owns the books in the library: each book's title, author, chapters, table of contents, " +
      "reading position, and which book is open. A book is added only while signed in, because adding " +
      "uploads the epub file; its chapters and images are extracted once on the server and " +
      "fetched by URL, so this fact never holds the file. The import marks a book's footnote " +
      "references, so reading aloud can leave them out: a link the book declares a reference " +
      "(epub:type noteref, role doc-noteref) or a link that is superscript, when its text is " +
      "only a number, a symbol or one letter. A book imported before this has no marks until " +
      "it is imported again. A book whose file holds several " +
      "chapters in one piece is cut where its contents say each chapter begins. The reading " +
      "position, a title and an author the user gives a book, and which book is open are last " +
      "write wins: they are never refused, and a pull brings them to every device. So is a book's place " +
      "on the shelf: a new book goes first among the books, and Vim's p on the shelf brings a deleted book " +
      "back between the neighbours it names; a book never placed keeps the newest-first order. An empty " +
      "title or author restores the one read from the file, and a re-import refreshes the " +
      "file's title and author without touching the user's. It also " +
      "presents the journal as the first book, signed in or out: its chapters are the days, " +
      "oldest first, with today's empty page last while no day has been started today, and " +
      "the contents list them newest first. Each of its chapters carries its day's date. It stores nothing for the journal, which can be " +
      "opened but never renamed or deleted here. Adding a book, renaming one and deleting one " +
      "are each a step Undo and Redo reverse (section 12); a delete happens at once and asks for " +
      "the short notice. Undo of an added book deletes it, and a deleted book comes back with a " +
      "restore write the server accepts, its files kept on the server, so nothing is imported " +
      "again. Once a delete's step leaves the undo list (`step.dropped`), the book's files on " +
      "the server are erased; a restore after that is refused and the book stays deleted. The " +
      "shelf's Vim p brings a deleted book back the same way, one step labelled restore whose " +
      "Undo deletes it again. A step is refused when the book was written since by anything else; turning a " +
      "page is not a step and refuses nothing. On a try page the Journal is always the open " +
      "book, and this browser's own open book is left as it was. Following a source link in a " +
      "note opens the link's book, the same as choosing it on the shelf, and so does bringing a " +
      "book's tab to the front on the stage, and so does picking a chapter of a book, or a day of the " +
      "journal, from a lookup in the chat. The chat may ask where the reader is in the open " +
      "book: the chapter, and the paragraph at the reading place with the next ones up to about " +
      "300 words, the paragraphs counted the way the reader counts them. Signing out keeps the library, the reading places " +
      "and the open book in this browser and stops syncing, so the views can hide them and " +
      "signing in again as the same account, with or without a reload, shows them as they " +
      "were; what was changed but not yet sent is sent then. A refused session is treated the " +
      "same way. A sign-in by a different account empties this browser's copy first, including " +
      "what was waiting to be sent, so one account's books are never shown to or sent under " +
      "another. When a connected Mac joins an account keeping its own copy, each of its books " +
      "is added to the account: the file is read from the Mac and imported, then its place and " +
      "title are sent; a book the account already has is left as the account has it, and one " +
      "whose file cannot be read is left out with a notice.",
    kind: "fact",
    shape: "replicated",
    emits: ["book.changed", "book.deleted", "book.refused", "book.opened", "session.rejected", "step.recorded", "step.settled"],
    owns: "the books",
    steps: {
      "book.picked": "step",
      "book.progressed": "navigation",
      "book.renamed": "step",
      "book.selected": "navigation",
      "book.switched": "navigation",
      "passage.selected": "navigation",
      "chapter.selected": "navigation",
      "day.selected": "navigation",
      "book.discarded": "step",
      "book.restored": "step",
    },
    asks: ["session: read", "journal: read"],
  },
  context: ({ input }) => ({
    books: new Map(),
    outbox: new Map(),
    store: input.store,
    now: input.now,
    api: input.api,
    ask: input.ask,
    revoke: input.revoke,
    mint: input.mint ?? ulid,
    // Who is signed in now, null signed out; syncing runs only while it is set.
    userId: null,
    // The account this browser's copy belongs to, kept in the meta across a sign-out.
    account: null,
    cursor: 0,
    // The book being read and when it was last set (server time once acknowledged),
    // beside the rows because it is one more last-write-wins value (5). id null when
    // none is open; at 0 so any server open wins on a fresh device.
    open: { id: null, at: 0 },
    // The journal as a book (journalBook), or null while there is none to show.
    journal: null,
    journalAnswered: false,
    listsWaiting: [],
    queued: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    // The browser joins the next account keeping this copy (12, keep).
    keep: false,
    resync: false,
    pull: false,
  }),
  // The journal is asked for at once and followed in every state, apart from the
  // library's own load, since it lives in another fact.
  invoke: {
    src: "journal",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: {
      actions: enqueueActions(({ context, event, enqueue }) => {
        applyJournal(context, event.output, enqueue);
        answerWaitingLists(context, enqueue);
      }),
    },
    onError: { actions: enqueueActions(({ context, enqueue }) => answerWaitingLists(context, enqueue)) },
  },
  on: {
    // While loading, only whether the browser is leaving is kept (12); the rest of the
    // news is read from session once the store is loaded.
    "session.changed": {
      actions: assign({ leaving: ({ event }) => event.leaving === true, keep: ({ event }) => event.leaving === true && event.keep === true }),
    },
    "journal.changed": { actions: enqueueActions(({ context, event, enqueue }) => applyJournal(context, event, enqueue)) },
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask, api: context.api }),
        onDone: {
          target: "checkingSession",
          actions: assign({
            books: ({ event }) => new Map(event.output.books.map((row) => [row.id, row])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            // Until session answers, the account last signed in counts as signed in, so a
            // page with no session answer still syncs as before.
            userId: ({ event }) => event.output.account,
            account: ({ event }) => event.output.account,
            open: ({ event }) => event.output.open,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            // The cache is empty, so only the journal can still be answered.
            for (const message of context.queued) {
              if (message.type === "list?") replyList(context, message.reply);
              else if (message.type === "read?") replyRead(context, message.payload.id, message.reply);
              else if (message.type === "open?") message.reply({ id: null });
              else if (message.type === "chapter?") answerUnloaded(context, message);
              else if (message.type === "place?") message.reply({ id: null });
            }
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "open?": { actions: queue },
        "chapter?": { actions: queue },
        "place?": { actions: queue },
        "book.picked": { actions: queue },
        "book.progressed": { actions: queue },
        "book.renamed": { actions: queue },
        "book.selected": { actions: queue },
        "book.switched": { actions: queue },
        "passage.selected": { actions: queue },
        "chapter.selected": { actions: queue },
        "day.selected": { actions: queue },
        "book.discarded": { actions: queue },
        "book.restored": { actions: queue },
        "step.undone": { actions: queue },
        "step.redone": { actions: queue },
      },
    },
    // The store is loaded; confirm who is signed in before flushing, so an early pick
    // is refused or uploaded with the right rule.
    checkingSession: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready.idle",
          actions: enqueueActions(({ context, event, enqueue, self }) => {
            // Reconcile the stored account against who the session says is signed in. A
            // session that ended while the tab was away (a cookie gone across a restart)
            // signs out exactly as a live sign-out does, keeping the library hidden (14).
            const userId = event.output?.userId ?? null;
            if (userId === null) signOut(context, enqueue);
            else if (userId !== context.account) switchAccount(context, enqueue, userId);
            else enqueue.assign({ userId });
            for (const message of context.queued) flush(context, message, enqueue, self);
            enqueue.assign({ queued: [] });
            if (userId) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
        onError: {
          target: "ready.idle",
          actions: enqueueActions(({ context, enqueue, self }) => {
            for (const message of context.queued) flush(context, message, enqueue, self);
            enqueue.assign({ queued: [] });
            if (context.userId) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "open?": { actions: queue },
        "chapter?": { actions: queue },
        "place?": { actions: queue },
        "book.picked": { actions: queue },
        "book.progressed": { actions: queue },
        "book.renamed": { actions: queue },
        "book.selected": { actions: queue },
        "book.switched": { actions: queue },
        "passage.selected": { actions: queue },
        "chapter.selected": { actions: queue },
        "day.selected": { actions: queue },
        "book.discarded": { actions: queue },
        "book.restored": { actions: queue },
        "step.undone": { actions: queue },
        "step.redone": { actions: queue },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload.id, event.reply) },
        "open?": { actions: ({ context, event }) => replyOpen(context, event.reply) },
        "chapter?": { actions: ({ context, event, self }) => answerChapter(context, event, self) },
        "place?": { actions: ({ context, event, self }) => answerPlace(context, event, self) },
        // A chapter fetch came back 401 (answerChapter, run fire-and-forget, cannot
        // enqueue): the session is gone, so sign out here where actions can run.
        "_sessionEnded": {
          actions: enqueueActions(({ context, event, enqueue }) => signOut(context, enqueue, { notifyId: event.id, sawReject: true })),
        },
        "book.picked": { actions: enqueueActions(({ context, event, enqueue, self }) => applyPick(context, event, enqueue, self)) },
        "book.selected": { actions: enqueueActions(({ context, event, enqueue }) => applySelect(context, event, enqueue)) },
        // The user brought a book's tab to the front on the stage: it opens the same way.
        "book.switched": { actions: enqueueActions(({ context, event, enqueue }) => applySelect(context, event, enqueue)) },
        // The user followed a source link in a note (note-editor emits passage.selected):
        // its book opens the same way as from the shelf; the reader goes to the passage.
        "passage.selected": { actions: enqueueActions(({ context, event, enqueue }) => applySelect(context, { id: event.book }, enqueue)) },
        // A chapter picked where its book may not be open yet (a lookup's link in the chat):
        // its book opens the same way, and the reader goes to the chapter. From the
        // contents the book is already open, so nothing changes here.
        "chapter.selected": { actions: enqueueActions(({ context, event, enqueue }) => applySelect(context, event, enqueue)) },
        // A journal day picked (a lookup's link in the chat): the journal opens, and the
        // journal's page shows the day.
        "day.selected": { actions: enqueueActions(({ context, event, enqueue }) => applySelect(context, { id: JOURNAL }, enqueue)) },
        "_uploaded": { actions: enqueueActions(({ context, event, enqueue }) => applyUploaded(context, event, enqueue)) },
        "book.progressed": { actions: enqueueActions(({ context, event, enqueue }) => applyProgress(context, event, enqueue)) },
        "book.renamed": { actions: enqueueActions(({ context, event, enqueue }) => applyRename(context, event, enqueue)) },
        "book.discarded": { actions: enqueueActions(({ context, event, enqueue }) => applyDiscard(context, event, enqueue)) },
        "book.restored": { actions: enqueueActions(({ context, event, enqueue }) => applyRestore(context, event, enqueue)) },
        "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "step.dropped": { actions: ({ context, event }) => purge(context, event) },
        // The fact's own news of who is signed in (4.3, fourth rule). A book is only
        // ever created signed in, so there is nothing anonymous to adopt: signing in
        // resets the pull cursor and pulls, after emptying another account's copy;
        // signing out only stops syncing (signOut).
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            // The browser is changing account (12): upload what is left, then empty the local
            // copy. Any other news ends it, and syncing goes on as before.
            if (event.leaving) {
              enqueue.assign({ leaving: true, keep: event.keep === true });
              enqueue.raise({ type: "_leave" });
              return;
            }
            if (context.leaving) enqueue.assign({ leaving: false, keep: false });
            // A keep called off (12): the copy stays this account's, so its mark goes.
            if (context.keep) enqueue(() => context.store.metaPut("adopt", null).catch(() => {}));
            const userId = event.userId;
            if (userId === context.userId) return;
            if (userId) {
              switchAccount(context, enqueue, userId);
              enqueue.raise({ type: "_sync", pull: true });
            } else {
              // A deliberate sign-out: silent, the auth control is the feedback.
              signOut(context, enqueue);
            }
          }),
        },
      },
      states: {
        // Leaving (12): what is left is uploaded at once, then the local copy is emptied.
        emptying: {
          invoke: {
            src: "empty",
            input: ({ context }) => ({ store: context.store, keep: context.keep, from: context.userId }),
            onDone: { target: "left" },
            onError: { target: "left" },
          },
        },
        // Emptied; a change made meanwhile is uploaded and emptied again. When the
        // change of account is called off, syncing goes on as before.
        left: {
          always: { guard: ({ context }) => !context.leaving, target: "idle" },
          on: {
            _drain: { guard: "syncable", target: "syncing" },
            _sync: { guard: "syncable", target: "syncing" },
            _leave: { guard: "syncable", target: "syncing" },
          },
        },
        idle: {
          always: { guard: "leftover", target: "emptying" },
          on: {
            _leave: { guard: "syncable", target: "syncing" },
            _drain: { guard: "syncable", target: "debouncing" },
            _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
          },
        },
        debouncing: {
          on: {
            _drain: { target: "debouncing", reenter: true },
            _leave: { guard: "syncable", target: "syncing" },
            _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
          },
          after: {
            [SYNC_IDLE_MS]: [{ guard: "syncable", target: "syncing" }, { target: "idle" }],
          },
        },
        syncing: {
          entry: assign({ resync: false, pull: false }),
          invoke: {
            src: "sync",
            input: ({ context, event }) => ({
              api: context.api,
              store: context.store,
              // A restore names the version of the tombstone it brings back (5), known only
              // once the delete was acknowledged, so it is read when the row is sent.
              rows: [...context.outbox.values()].map((row) =>
                row.kind === "restore" ? { ...row, baseVersion: context.books.get(row.book)?.version ?? 0 } : row,
              ),
              cursor: context.cursor,
              pull: Boolean(event.pull) && !context.leaving,
            }),
            onDone: {
              target: "idle",
              actions: [
                enqueueActions(({ context, event, enqueue }) => applySync(context, event.output, enqueue)),
                enqueueActions(({ context, event, enqueue }) => {
                  const { authFailed, networkError } = event.output;
                  if (authFailed || networkError) return;
                  if (context.resync) enqueue.raise({ type: "_sync", pull: context.pull });
                  else if (context.outbox.size > 0) enqueue.raise({ type: "_drain" });
                }),
              ],
            },
            onError: { target: "idle" },
          },
          on: {
            _leave: { actions: assign({ resync: true }) },
            _sync: { actions: assign({ resync: true, pull: ({ context, event }) => context.pull || Boolean(event.pull) }) },
          },
        },
      },
    },
    failed: {
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload.id, event.reply) },
        "open?": { actions: ({ event }) => event.reply({ id: null }) },
        "chapter?": { actions: ({ context, event }) => answerUnloaded(context, event) },
        "place?": { actions: ({ event }) => event.reply({ id: null }) },
      },
    },
  },
});

// Apply a sync's summary: acknowledged positions take the server's version (keeping
// the latest local place, since a turn during the sync leaves a newer outbox row),
// pulled records win only when newer, a tombstone never resurrects, the cursor
// advances, and a 401 drops the session. Kept out of the machine body so the chart
// stays readable.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    if (ack.kind === "adopt") {
      applyAdopted(context, ack, enqueue);
      continue;
    }
    if (ack.kind === "open") {
      // The open was acknowledged; adopt the server's time so a later pull's open is
      // compared fairly. Only drain the outbox row if a newer open has not queued since.
      context.open = { id: ack.row.id, at: ack.row.at };
      enqueue(() => context.store.metaPut("open", context.open).catch(() => {}));
      const queued = context.outbox.get("open");
      if (!queued || queued.book === ack.row.id) {
        context.outbox.delete("open");
        enqueue(() => context.store.outboxDelete("open").catch(() => {}));
      }
      continue;
    }
    if (ack.kind === "delete") {
      // The delete was announced already; drop the outbox row and keep the tombstone
      // at the server's version. The sync cleared the store; clear the in-memory Map too.
      // A row queued for the book since (an Undo's restore, then a page turn) stays.
      const queued = context.outbox.get(ack.id);
      if (queued?.kind === "delete") context.outbox.delete(ack.id);
      else if (queued) enqueue(() => context.store.outboxPut(queued).catch(() => {}));
      const held = context.books.get(ack.id);
      // Brought back while its delete was on the way: it stays, and its restore write
      // names this tombstone's version.
      if (visible(held)) {
        const record = { ...held, version: ack.row.version };
        context.books.set(ack.id, record);
        enqueue(() => context.store.put(record).catch(() => {}));
        continue;
      }
      const record = carry(context, held, { ...serverRecord(ack.row), deleted: true }, true);
      record.position = held?.position ?? record.position;
      context.books.set(ack.id, record);
      enqueue(() => context.store.put(record).catch(() => {}));
      continue;
    }
    if (ack.kind === "restore") {
      applyRestored(context, ack, enqueue);
      continue;
    }
    if (ack.kind === "shelf") {
      // A place was acknowledged, last write wins: only drain the row if a newer place has
      // not queued since; the onDone re-raises a drain for one that has. A book the server
      // does not have drops the row.
      const queued = context.outbox.get(ack.id);
      if (!queued || queued.shelfPlace === ack.sent.shelfPlace) {
        context.outbox.delete(ack.id);
        enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
      } else {
        enqueue(() => context.store.outboxPut(queued).catch(() => {}));
      }
      if (ack.row.error) continue;
      const held = context.books.get(ack.book);
      const record = carry(context, held, serverRecord(ack.row), true);
      // Brought back or deleted again while the place was on the way: that write stands.
      if (held) Object.assign(record, { position: held.position, deleted: Boolean(held.deleted) });
      context.books.set(ack.book, record);
      enqueue(() => context.store.put(record).catch(() => {}));
      if (visible(record)) enqueue.emit(changed(record, pendingFor(context, ack.book)));
      continue;
    }
    if (ack.kind === "title") {
      // A rename was acknowledged, last write wins: adopt the server row (its title is
      // the display title, its fileTitle the file's) but keep the latest local place,
      // since a page may have turned during the sync. Only drain the row if a newer
      // rename has not queued since; the onDone re-raises a drain for one that has.
      const server = ack.row;
      const queued = context.outbox.get(ack.id);
      if (!queued || (queued.title === ack.sent.title && queued.author === ack.sent.author)) {
        context.outbox.delete(ack.id);
        enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
      } else {
        enqueue(() => context.store.outboxPut(queued).catch(() => {}));
      }
      const held = context.books.get(server.id);
      const record = carry(context, held, serverRecord(server), true);
      if (held) record.position = held.position;
      context.books.set(server.id, record);
      enqueue(() => context.store.put(record).catch(() => {}));
      enqueue.emit(changed(record, pendingFor(context, server.id)));
      continue;
    }
    const server = ack.row;
    const queued = context.outbox.get(ack.id);
    // A page turned during the sync left a newer place in the outbox; only a row that
    // still matches what the server acknowledged is fully drained. The other stays,
    // and the onDone re-raises a drain for it.
    const drained =
      !queued ||
      (queued.kind === "position" && queued.chapter === server.position.chapter && queued.block === server.position.block);
    if (drained) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
    } else {
      enqueue(() => context.store.outboxPut(queued).catch(() => {}));
    }
    const held = context.books.get(ack.id);
    const record = carry(context, held, serverRecord(server), true);
    if (held) record.position = held.position; // keep the latest local place
    context.books.set(ack.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit(changed(record, pendingFor(context, ack.id)));
  }

  for (const book of pulled) {
    const current = context.books.get(book.id);
    if (current && book.version <= current.version) continue;
    // A delete always wins (5): a live copy never resurrects a local delete not yet sent.
    // Otherwise a live copy of a local tombstone at a higher version is a restore write
    // made elsewhere (5).
    if (current && current.deleted && !book.deleted && context.outbox.get(book.id)?.kind === "delete") continue;
    const record = carry(context, current, serverRecord(book));
    if (book.deleted) {
      if (context.outbox.delete(`restore:${book.id}`)) enqueue(() => context.store.outboxDelete(`restore:${book.id}`).catch(() => {}));
      context.books.set(book.id, record);
      enqueue(() => context.store.put(record).catch(() => {}));
      if (visible(current)) enqueue.emit({ type: "book.deleted", id: book.id });
      continue;
    }
    context.books.set(book.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit(changed(record, pendingFor(context, book.id)));
  }

  // Another device's open, brought by the pull (5): adopt it only when it is newer by
  // the server's clock and this device has no open of its own still to drain, so a
  // local open in flight is never overrun. Announce it only when the open book changed,
  // and only as an id this device can actually read (null otherwise, folded above).
  const pulledOpen = output.pulledOpen;
  if (pulledOpen && !context.outbox.has("open") && pulledOpen.at > context.open.at) {
    const wasVisible = bookFor(context, context.open.id) ? context.open.id : null;
    context.open = { id: pulledOpen.id, at: pulledOpen.at };
    enqueue(() => context.store.metaPut("open", context.open).catch(() => {}));
    const id = bookFor(context, pulledOpen.id) ? pulledOpen.id : null;
    if (id !== wasVisible) enqueue.emit({ type: "book.opened", id });
  }

  if (newCursor !== undefined) {
    enqueue.assign({ cursor: newCursor });
    enqueue(() => context.store.metaPut("cursor", newCursor).catch(() => {}));
  }
  if (authFailed) {
    // A 401 during a background sync: the session is gone. Sign out silently, but tell
    // `session` to re-check so the auth control flips too (session.rejected).
    signOut(context, enqueue, { sawReject: true });
  }
}

// A restore write was answered (5). Brought back on the server, the book takes the
// server's row and keeps its place; deleted again here meanwhile, the delete queued since
// stands. Still a tombstone there, another device deleted it later, and a delete always
// wins, so it goes here too. A book the server never had is left as it is.
function applyRestored(context, ack, enqueue) {
  context.outbox.delete(ack.id);
  const held = context.books.get(ack.book);
  // Its files went before the restore arrived (purge): the book stays deleted.
  if (visible(held) && ack.row?.error === "changed") {
    const record = { ...held, deleted: true };
    context.books.set(ack.book, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit({ type: "book.deleted", id: ack.book });
    if (context.open.id === ack.book) forgetOpen(context, enqueue);
    return;
  }
  if (!held || !ack.row || ack.row.error) return;
  if (!visible(held)) {
    context.books.set(ack.book, { ...held, version: Math.max(held.version, ack.row.version) });
    enqueue(() => context.store.put(context.books.get(ack.book)).catch(() => {}));
    return;
  }
  const record = carry(context, held, serverRecord(ack.row), true);
  record.position = held.position;
  context.books.set(ack.book, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  if (record.deleted) enqueue.emit({ type: "book.deleted", id: ack.book });
  else enqueue.emit(changed(record, pendingFor(context, ack.book)));
}

// A book of this browser's copy reached the account (adopt), or could not. Added: the
// account's row is cached and announced, keeping the place. Already the account's: the
// account's copy replaces this browser's, whose file and versions are another server's,
// and a book the account deleted goes. Its file missing or unreadable: the book cannot
// be added, so it goes from this browser's copy, which keeps it on the Mac's own server,
// and the notice says the file could not be read.
function applyAdopted(context, ack, enqueue) {
  context.outbox.delete(ack.id);
  const current = context.books.get(ack.book);
  const server = ack.row ?? ack.had;
  if (server) {
    const record = serverRecord(server);
    if (ack.row && current) record.position = current.position;
    if (ack.row && current?.shelfPlace) record.shelfPlace = current.shelfPlace;
    context.books.set(ack.book, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    if (!record.deleted) enqueue.emit(changed(record, pendingFor(context, ack.book)));
    else if (visible(current)) enqueue.emit({ type: "book.deleted", id: ack.book });
    return;
  }
  if (!current) return;
  const record = { ...current, deleted: true };
  context.books.set(ack.book, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  if (visible(current)) enqueue.emit({ type: "book.deleted", id: ack.book });
  enqueue.emit({ type: "book.refused", id: ack.book, reason: "unreadable" });
}
