import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

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

// The journal book from journal: read's picture, or null when there is no journal to
// show (no `journal` on the page answers no-answerer). texts holds each chapter's day
// text for chapter?; it never rides book.changed or a reply. Versions are added by
// applyJournal, which alone knows whether anything changed.
function journalBook(picture, now) {
  if (!picture || !Array.isArray(picture.days)) return null;
  const days = picture.days.map((d) => ({ day: d.day, text: d.text }));
  if (picture.open == null) days.push({ day: dateOf(now), text: "" });
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

// The book a reader can open under `id`: the journal, or a visible imported book.
const bookFor = (context, id) => (id === JOURNAL ? context.journal : visible(context.books.get(id)) ? context.books.get(id) : null);

// The record kept in the cache, from a server row: the book.changed shape plus the
// tombstone flag, built field by field so nothing stray is stored or later emitted.
// title is the display title (the user's when set, else the file's); fileTitle is the
// file's own, kept only so an empty rename can restore it locally at once (D11); it
// never rides book.changed or a reply.
const serverRecord = (b) => ({
  id: b.id,
  title: b.title,
  fileTitle: b.fileTitle ?? b.title,
  author: b.author,
  cover: b.cover ?? null,
  chapters: b.chapters,
  toc: b.toc,
  position: b.position,
  version: b.version,
  contentVersion: b.contentVersion,
  addedAt: b.addedAt,
  updatedAt: b.updatedAt,
  deleted: Boolean(b.deleted),
});

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

const changed = (record, pending) => ({ type: "book.changed", ...bookOf(record, pending) });

// A book has a local change not yet acknowledged when it has an outbox row — a
// position or delete keyed by the book id, or a title keyed under `title:<id>` (kept
// apart so a rename never overwrites a pending page turn, D11).
const pendingFor = (context, id) => context.outbox.has(id) || context.outbox.has(`title:${id}`);

const tile = (context, r) => ({
  id: r.id,
  title: r.title,
  author: r.author,
  cover: r.cover,
  position: r.position,
  chapterCount: r.chapters.length,
  pending: pendingFor(context, r.id),
  addedAt: r.addedAt,
  ...(r.written ? { written: true } : {}),
});

// The journal first, then the imported books newest first.
function replyList(context, reply) {
  const books = [...context.books.values()]
    .filter(visible)
    .map((r) => tile(context, r))
    .sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id));
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

// A chapter is a file, so answering is a fetch; only the journal's chapters are
// answered here, from the day's text, without the network. The reply is a callback, so the fetch
// runs fire-and-forget alongside the machine rather than in a state: two chapters in
// flight never wait on each other, and the machine's own flow is untouched. The
// browser's HTTP cache answers a repeat fetch (Decision 2). A missing book or an
// index past the end is not-found without a round trip.
function answerChapter(context, event, self) {
  const { id, chapter } = event.payload;
  const record = bookFor(context, id);
  if (!record || chapter < 0 || chapter >= record.chapters.length) {
    event.reply({ error: "not-found" });
    return;
  }
  if (record.written) {
    event.reply({ title: record.chapters[chapter].title, html: htmlOf(record.texts[chapter]) });
    return;
  }
  if (context.api == null) {
    event.reply({ error: "unavailable" });
    return;
  }
  Promise.resolve(context.api.chapter(id, record.contentVersion, chapter))
    .then((res) => {
      // A 401 is not the server being down, it is the session being gone: sign out so
      // the views hide and the notice says so (14), and answer unavailable so the reader
      // offers to try again once the user has signed in.
      if (res && res.error === "unauthorized") {
        self?.send({ type: "_sessionEnded", id });
        event.reply({ error: "unavailable" });
        return;
      }
      res && res.error
        ? event.reply({ error: res.error })
        : event.reply({ title: record.chapters[chapter].title, html: res.html });
    })
    .catch(() => event.reply({ error: "unavailable" }));
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
  const record = serverRecord(res.row);
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  enqueue.emit(changed(record, false));
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
// user title at once, announce it pending, and queue the write, last write wins and
// never refused like a position (D11). A trimmed empty string restores the file's
// title, which the cache keeps as fileTitle so the change shows without a round trip.
// The row is keyed under `title:<id>`, apart from a pending position or delete, so a
// rename and a page turn for the same book both reach the server. A missing or
// tombstoned book, or a title that changes nothing, is ignored, and so is the journal,
// which is never in the cache.
function applyRename(context, event, enqueue) {
  const { id } = event;
  const current = context.books.get(id);
  if (!current || current.deleted) return;
  const sent = (event.title || "").trim();
  const next = sent || current.fileTitle || current.title;
  if (next === current.title) return;
  const record = { ...current, title: next, updatedAt: context.now() };
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const row = { id: `title:${id}`, kind: "title", book: id, title: sent };
  context.outbox.set(row.id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit(changed(record, true));
  enqueue.raise({ type: "_drain" });
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

// The user let a book's undo window run out (book-shelf emits book.discarded, 4.3
// fifth rule): tombstone it, queue a delete (which replaces any pending position,
// Decision 6), announce it gone, and drain. The server purges the directory. The
// journal is never in the cache, so it is never discarded here.
function applyDiscard(context, event, enqueue) {
  const { id } = event;
  const current = context.books.get(id);
  if (!current || current.deleted) return;
  const record = { ...current, deleted: true, updatedAt: context.now() };
  context.books.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const row = { id, kind: "delete" };
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
  else if (message.type === "book.picked") applyPick(context, message, enqueue, self);
  else if (message.type === "book.selected" || message.type === "book.switched") applySelect(context, message, enqueue);
  else if (message.type === "passage.selected") applySelect(context, { id: message.book }, enqueue);
  else if (message.type === "book.progressed") applyProgress(context, message, enqueue);
  else if (message.type === "book.renamed") applyRename(context, message, enqueue);
  else if (message.type === "book.discarded") applyDiscard(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

// The pause after a page turn the network waits for (Decision 4; 5): a further turn
// restarts this window, so a run of turns drains once, not per page. A focus, sign-in
// or hidden tab does not wait; they sync at once.
const SYNC_IDLE_MS = 2000;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The browser changed account while this fact was not on the page (12): a copy kept for
// another account is emptied before it is read, outbox included, so none of it is shown
// to the account now signed in or uploaded as its own.
async function claim(store, ask) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const kept = await store.metaGet("userId");
  if (kept && kept !== userId) await store.empty();
}

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
      const { store, ask } = input;
      await claim(store, ask);
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
    empty: fromPromise(({ input }) => input.store.empty()),
    // One sync: drain the outbox in id order, then pull what changed since the
    // cursor. Positions and deletes never conflict (Decision 4, 6), so a drained row
    // is simply acknowledged; a network error stops with what it had, a 401 reports
    // the session is gone. The store deletes happen here so a drained row is durably gone.
    sync: fromPromise(async ({ input }) => {
      const { api, store, rows, cursor, pull } = input;
      const acks = [];
      for (const row of [...rows].sort(byId)) {
        let result;
        try {
          result =
            row.kind === "delete"
              ? await api.remove(row.id)
              : row.kind === "open"
                ? await api.opened(row.book)
                : row.kind === "title"
                  ? await api.title(row.book, row.title)
                  : await api.position(row.id, row.chapter, row.block);
        } catch {
          return { acks, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, authFailed: true };
        acks.push({ id: row.id, kind: row.kind, sent: row.title, row: result });
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
      "Owns the books in the library: each book's title, chapters, table of contents, reading " +
      "position, and which book is open. A book is added only while signed in, because adding " +
      "uploads the epub file; its chapters and images are extracted once on the server and " +
      "fetched by URL, so this fact never holds the file. A book whose file holds several " +
      "chapters in one piece is cut where its contents say each chapter begins. The reading " +
      "position, a title the user gives a book, and which book is open are last write wins: " +
      "they are never refused, " +
      "and a pull brings them to every device. An empty title restores the title read from the " +
      "file, and a re-import refreshes the file's title without touching the user's. It also " +
      "presents the journal as the first book, signed in or out: its chapters are the days, " +
      "oldest first, with today's empty page last while no day has been started today, and " +
      "the contents list them newest first. Each of its chapters carries its day's date. It stores nothing for the journal, which can be " +
      "opened but never renamed or deleted here. On a try page the Journal is always the open " +
      "book, and this browser's own open book is left as it was. Following a source link in a " +
      "note opens the link's book, the same as choosing it on the shelf, and so does bringing a " +
      "book's tab to the front on the stage. Signing out keeps the library, the reading places " +
      "and the open book in this browser and stops syncing, so the views can hide them and " +
      "signing in again as the same account, with or without a reload, shows them as they " +
      "were; what was changed but not yet sent is sent then. A refused session is treated the " +
      "same way. A sign-in by a different account empties this browser's copy first, including " +
      "what was waiting to be sent, so one account's books are never shown to or sent under " +
      "another.",
    kind: "fact",
    shape: "replicated",
    emits: ["book.changed", "book.deleted", "book.refused", "book.opened", "session.rejected"],
    owns: "the books",
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
    queued: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    resync: false,
    pull: false,
  }),
  // The journal is asked for at once and followed in every state, apart from the
  // library's own load, since it lives in another fact.
  invoke: {
    src: "journal",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: enqueueActions(({ context, event, enqueue }) => applyJournal(context, event.output, enqueue)) },
  },
  on: {
    // While loading, only whether the browser is leaving is kept (12); the rest of the
    // news is read from session once the store is loaded.
    "session.changed": { actions: assign({ leaving: ({ event }) => event.leaving === true }) },
    "journal.changed": { actions: enqueueActions(({ context, event, enqueue }) => applyJournal(context, event, enqueue)) },
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask }),
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
        "book.picked": { actions: queue },
        "book.progressed": { actions: queue },
        "book.renamed": { actions: queue },
        "book.selected": { actions: queue },
        "book.switched": { actions: queue },
        "passage.selected": { actions: queue },
        "book.discarded": { actions: queue },
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
        "book.picked": { actions: queue },
        "book.progressed": { actions: queue },
        "book.renamed": { actions: queue },
        "book.selected": { actions: queue },
        "book.switched": { actions: queue },
        "passage.selected": { actions: queue },
        "book.discarded": { actions: queue },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload.id, event.reply) },
        "open?": { actions: ({ context, event }) => replyOpen(context, event.reply) },
        "chapter?": { actions: ({ context, event, self }) => answerChapter(context, event, self) },
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
        "_uploaded": { actions: enqueueActions(({ context, event, enqueue }) => applyUploaded(context, event, enqueue)) },
        "book.progressed": { actions: enqueueActions(({ context, event, enqueue }) => applyProgress(context, event, enqueue)) },
        "book.renamed": { actions: enqueueActions(({ context, event, enqueue }) => applyRename(context, event, enqueue)) },
        "book.discarded": { actions: enqueueActions(({ context, event, enqueue }) => applyDiscard(context, event, enqueue)) },
        // The fact's own news of who is signed in (4.3, fourth rule). A book is only
        // ever created signed in, so there is nothing anonymous to adopt: signing in
        // resets the pull cursor and pulls, after emptying another account's copy;
        // signing out only stops syncing (signOut).
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            // The browser is changing account (12): upload what is left, then empty the local
            // copy. Any other news ends it, and syncing goes on as before.
            if (event.leaving) {
              enqueue.assign({ leaving: true });
              enqueue.raise({ type: "_leave" });
              return;
            }
            if (context.leaving) enqueue.assign({ leaving: false });
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
            input: ({ context }) => ({ store: context.store }),
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
              rows: [...context.outbox.values()],
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
      context.outbox.delete(ack.id);
      const held = context.books.get(ack.id) || {};
      const record = { ...serverRecord(ack.row), deleted: true };
      record.position = held.position ?? record.position;
      context.books.set(ack.id, record);
      enqueue(() => context.store.put(record).catch(() => {}));
      continue;
    }
    if (ack.kind === "title") {
      // A rename was acknowledged, last write wins: adopt the server row (its title is
      // the display title, its fileTitle the file's) but keep the latest local place,
      // since a page may have turned during the sync. Only drain the row if a newer
      // rename has not queued since; the onDone re-raises a drain for one that has.
      const server = ack.row;
      const queued = context.outbox.get(ack.id);
      if (!queued || queued.title === ack.sent) {
        context.outbox.delete(ack.id);
        enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
      } else {
        enqueue(() => context.store.outboxPut(queued).catch(() => {}));
      }
      const held = context.books.get(server.id);
      const record = serverRecord(server);
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
    const record = serverRecord(server);
    if (held) record.position = held.position; // keep the latest local place
    context.books.set(ack.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit(changed(record, pendingFor(context, ack.id)));
  }

  for (const book of pulled) {
    const current = context.books.get(book.id);
    if (current && book.version <= current.version) continue;
    // A delete always wins (5): a live copy never resurrects a local tombstone.
    if (current && current.deleted && !book.deleted) continue;
    const record = serverRecord(book);
    if (book.deleted) {
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
