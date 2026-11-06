import { setup, assign, fromPromise, fromCallback, enqueueActions, emit, spawnChild, stopChild } from "xstate";

// The view component for editing one note (3.1): owns only its own UI state — the
// draft, which state it is in — and points at `notes`, which
// owns the fact, and at `subject`, which owns what is on the stage. On start it asks
// notes: list and reopens a note, or takes a note by the load command or, when it
// carries `follows`, by note.selected from the list (both ask notes: read); it follows
// note.changed after (4.3); the same notes: list, with note.changed and note.deleted,
// also tells which notes and highlights the source links point at still exist, and the
// titles their tags show and the "[[" picker offers. It asks flags: read and follows
// flags.changed for whether Slip-Box shows (3.1). It emits
// note.saved at a short throttle while the user
// types, and on blur. With the `subject` attribute it follows the stage (12): it opens
// the newest note about the subject and re-follows when the subject changes, except while
// the device preference keepOpen (12, `settings`) is on, which keeps the note on screen
// whatever comes on the stage; a pick by the user always opens. It announces the note
// it shows with note.opened whenever its id changes (6.4). The view (view.js) is a
// CodeMirror 6 document with three levels (Title/Heading/Subheading) like Notes.app,
// and Vim when the "Vim keys" preference is on (12). A note is markdown on the wire and
// marker-free in the view; parseBody/serialize are the one place the two forms meet,
// and both are pure, so they and titleOf are tested in Node. Everything with a side
// effect — the queries, minting an id, focusing the input, the open note's store — arrives
// through input, so this stays a pure definition importable in Node; it imports no
// CodeMirror (that lives in view.js, the browser-only entry). It asks session: read and
// follows session.changed only for whether anyone is signed in, and evaluators: list,
// following evaluator.changed and evaluator.deleted, only for the names the "#" picker
// offers.

const THROTTLE_MS = 200;

// How long a note's change may wait for the server before the editor says Not synced:
// longer than notes' idle window and a round trip (5), so the words show only while the
// device is offline or the server keeps failing, never during an ordinary save.
export const NOT_SYNCED_MS = 5000;

// The wire form of a note is markdown: a line prefixed "# "/"## "/"### " is a
// Title/Heading/Subheading, an unprefixed line is Body. The CM6 document the user
// edits is marker-free (view.js), so parseBody/serialize are the one place the two
// representations meet; both are pure, so they and titleOf are tested in Node.
const PREFIX = { title: "# ", heading: "## ", subheading: "### ", body: "" };

// The note's title is its first line that says anything, with its level marker or its
// list marker off so a list row and note.saved.title never show a "#", a "- ", a
// "1. ", a box or a quote's "> ".
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim().replace(/^#{1,3} /, "").replace(/^(?:[-*] (?:\[[ xX]\] )?|\d{1,9}\. |> )/, "").trim() : "";
}

// markdown -> { doc: marker-free text, levels: one level per line }. An empty note
// starts as a single Body line: no level is imposed on the first line, the user
// raises one when they want it. Loaded content is governed by its own markers, so a
// note written without levels loads unchanged (a bare first line stays Body).
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

// (doc, levels) -> markdown, re-adding each line's marker. The inverse of parseBody.
// Edge (accepted): a Body line whose text itself begins with "# " serializes bare and
// re-parses as a heading — Markdown's own ATX ambiguity. Escaping is rejected: it
// would pollute the one plain string that note-list and every reader also read.
export function serialize(doc, levels) {
  if (doc === "") return ""; // a blank note is empty, never a lone "# " — so opening one never mints
  // A blank line is a paragraph gap, always Body (architecture.md 10), so it never
  // carries a marker.
  return doc
    .split("\n")
    .map((text, i) => (text === "" ? "" : (PREFIX[levels[i]] ?? "") + text))
    .join("\n");
}

// A note's links (12), always an array: an old cached note, or a read reply from
// before links existed, reads as none.
const links = (about) => (Array.isArray(about) ? about : []);

// A note is about the subject when one of its links matches the subject's kind and id
// (D4: a follower compares kind + id, it never learns what kinds exist).
const isAbout = (note, subject) =>
  subject != null && links(note.about).some((l) => l.kind === subject.kind && l.id === subject.id);

// A highlight of the subject: its link to the subject carries a place (12). It belongs
// to the highlights editor, never the note editor, as note-list leaves it out of the list.
const isHighlight = (note, subject) =>
  subject != null && links(note.about).some((l) => l.kind === subject.kind && l.id === subject.id && l.place);

// A note the editor may open for the subject: about it, not a highlight of it, and, while
// the subject has an open chapter, linked to that chapter. A note linked to the whole book
// is not opened for a chapter: the This chapter list shows those in a group of their own,
// and opening one would put a note of no chapter in front of every chapter.
const ofSubject = (note, subject) =>
  isAbout(note, subject) &&
  !isHighlight(note, subject) &&
  (!subject.chapter || links(note.about).some((l) => l.kind === subject.kind && l.id === subject.id && l.chapter === subject.chapter));

// Which note to open from a list reply (D7): the newest note for the subject (ofSubject;
// the reply is newest first), or — for an editor that does not follow the stage — the
// newest note overall. Null when there is none, so the editor lands on the empty page. A
// following editor with nothing on the stage opens none: the subject is often not known
// yet at a reload, and with keepOpen on a note chosen then would stay open in place of
// the subject's.
const pickId = (notes, subject, subjecting) => {
  const list = Array.isArray(notes) ? notes : [];
  if (subject == null) return subjecting ? null : list[0]?.id ?? null;
  return list.find((n) => ofSubject(n, subject))?.id ?? null;
};

// Two subjects name the same thing when their kind and id match (title aside); both
// null is the same nothing. A title-only change keeps the note on screen (D7).
const sameThing = (a, b) => (a == null && b == null) || Boolean(a && b && a.kind === b.kind && a.id === b.id);

// The same thing with another chapter open in it, which re-follows like a change of thing.
// A move into a part with no chapter (an untitled chapter) keeps the note, since there is
// no chapter to choose a note by.
const otherChapter = (a, b) => sameThing(a, b) && b?.chapter != null && b.chapter !== a?.chapter;

// Remember a subject's title so the About line can name a note's link this session
// (D7, D9): a small kind:id → title table, never a claim about kinds the editor
// understands.
const withTitle = (titles, subject) => {
  if (!subject) return titles;
  const key = `${subject.kind}:${subject.id}`;
  return titles[key] === subject.title ? titles : { ...titles, [key]: subject.title };
};

// What the About line names (12): the open note's first link, by a title this browser
// has seen; else, while following the subject, the subject on the stage while the
// editor holds a new note, because that is what the note is linked to at its first save. Never while
// a note may still arrive (starting, loading), so a kept note's line does not show
// the stage's book first. Pure, so it is tested in Node and the view only renders it.
export function aboutTitleOf(snapshot) {
  const { about, titles, subjecting, subject, baseVersion } = snapshot.context;
  const link = about?.[0];
  if (link) return titles?.[`${link.kind}:${link.id}`] ?? null;
  if (!subjecting || baseVersion !== null) return null;
  const fresh = ["empty", "blank", "refollowing", "editing"].some((state) => snapshot.matches(state));
  return fresh && newLink(snapshot.context) ? subject.title ?? null : null;
}

// A Journal chapter is a day, named by its date (13, Link); a book's never has that
// shape, so the date alone tells the Journal apart without the editor learning about books.
const isDay = (chapter) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(chapter ?? "");

// A link's chapter fields, taken from the subject when it has an open chapter.
const chapterPart = (subject) =>
  subject?.chapter ? { chapter: subject.chapter, chapterTitle: subject.chapterTitle } : {};

// What the Link or Unlink button would make of the open note's links, or null when it
// shows none: only on a saved note whose first link is to the subject, while the subject
// has an open chapter, and never on a highlight, whose place is its own kind of link.
// Linked to the open chapter, it unlinks to the whole book; otherwise it links to the open
// chapter, which also moves a note from another chapter. Pure, so it is tested in Node.
export function relinkOf(context) {
  const { about, subject, subjecting, id, baseVersion } = context;
  if (!subjecting || id == null || baseVersion === null || !subject?.chapter) return null;
  const list = links(about);
  const first = list[0];
  if (!first || first.kind !== subject.kind || first.id !== subject.id || list.some((l) => l.place)) return null;
  const { chapter, chapterTitle, ...whole } = first;
  const unlink = chapter === subject.chapter;
  const next = unlink ? whole : { ...whole, ...chapterPart(subject) };
  return {
    about: [next, ...list.slice(1)],
    label: unlink ? "Unlink" : "Link to " + subject.chapterTitle,
  };
}

// The chapter label beside the About line: the chapter the note's first link names, as
// its title read when it was linked, so it shows whichever chapter is open; or the whole
// book; and the button relinkOf offers. A new note shows the chapter it will be linked to
// at its first save, without a button, since there is no note yet to change. Null where
// the About line names nothing, and on a highlight, which keeps the About line alone.
export function chapterLabelOf(snapshot) {
  const { about, subject } = snapshot.context;
  const list = links(about);
  const whole = (journal) => (journal ? "Whole Journal" : "Whole book");
  if (aboutTitleOf(snapshot) == null || list.some((l) => l.place)) return null;
  const link = list[0];
  if (!link) return { text: subject.chapterTitle ?? whole(isDay(subject.chapter)), linked: Boolean(subject.chapter), action: null };
  const ofSubject = subject != null && link.kind === subject.kind && link.id === subject.id;
  const journal = isDay(link.chapter) || (ofSubject && isDay(subject.chapter));
  return {
    text: link.chapterTitle ?? whole(journal),
    linked: Boolean(link.chapter),
    action: relinkOf(snapshot.context)?.label ?? null,
  };
}

// A source link in a note's text, `[label](note:<id>)` (book-reader's Copy link writes
// it): every one in `text`, by its range in the text and its label with the escapes off.
// The view draws each as one tag; the text itself stays as stored.
const SOURCE_LINK = /\[((?:[^\[\]\\\n]|\\[^\n])*)\]\(note:([0-9A-HJKMNP-TV-Z]{26})\)/g;
export function sourceLinksIn(text) {
  const found = [];
  for (const m of String(text).matchAll(SOURCE_LINK)) {
    found.push({ from: m.index, to: m.index + m[0].length, id: m[2], label: m[1].replace(/\\(.)/g, "$1") });
  }
  return found;
}

// Where following a source link goes: the book and the passage the highlight's link to
// its book carries, from a notes: read reply. Null when the highlight is gone (a
// tombstone reads not-found) or the note marks no passage, so nothing opens.
export function passageOf(reply, id) {
  const link = links(reply?.note?.about).find((l) => l.kind === "book" && l.place);
  return link ? { book: link.id, id, place: link.place } : null;
}

// Whether the highlight a source link names is gone, so its tag is drawn grey: a note
// notes no longer lists, once it has answered, or one a follow found gone. While notes has
// not answered (a page without it), only a follow can tell. The same rule as the journal's
// (journal-entry/machine.js), copied because components never import each other (11.2).
// The Slip-Box is never missing: it is there before it has any text.
export const linkMissing = ({ notes, removed }) => (id) =>
  id !== SLIPBOX && (removed.includes(id) || (notes !== null && !notes.includes(id)));

// A highlight is a note whose link to its book marks a passage (13, Highlight).
const marksPassage = (about) => links(about).some((l) => l.kind === "book" && l.place);

// What the editor knows of each note a link may name, by id, from notes: list and
// note.changed: { title, about (its first line under the title), highlight, updatedAt,
// parents (the notes it is under), passage (a highlight's book, place, quote and chapter) }.
// A deleted note's entry stays, so its grey tag still says it was a note.
const passageLink = (about) => links(about).find((l) => l.kind === "book" && l.place) ?? null;
const passageOfLink = (link) =>
  link ? { book: link.id, place: link.place, quote: link.quote?.exact ?? "", chapterTitle: link.chapterTitle ?? null } : null;
// A line shown under a note's title in a list: its source links read as their labels.
const plainLinks = (text) => String(text ?? "").replace(SOURCE_LINK, (_m, label) => label.replace(/\\(.)/g, "$1"));
const entryOf = (n) => ({
  title: n.title ?? "",
  about: plainLinks(n.subtitle),
  highlight: marksPassage(n.about),
  updatedAt: n.updatedAt ?? 0,
  parents: links(n.about).filter((l) => l.kind === "note").map((l) => l.id),
  passage: passageOfLink(passageLink(n.about)),
  noteType: NOTE_TYPES.some((t) => t.value === n.noteType) ? n.noteType : "fleeting",
});
const entriesOf = (notes) => Object.fromEntries(notes.map((n) => [n.id, entryOf(n)]));

// A note's type (13), in the order the type menu lists them, each with its one line.
export const NOTE_TYPES = [
  { value: "fleeting", label: "Fleeting", says: "A quick thought, to work out or let go later" },
  { value: "literature", label: "Literature", says: "What a source says, in your own words" },
  { value: "permanent", label: "Permanent", says: "One finished idea of your own, kept in the Slip-Box" },
];

// The name a source link's tag shows (10): a note's title now, by the link's id, so a
// rename shows in every tag that links to it and no linking text is rewritten; null for
// a highlight, whose tag keeps the passage written in the link, and for an id the editor
// does not know, whose stored label shows grey. With Slip-Box hidden, every tag shows its
// stored label, as before the feature.
const nameOf = (title) => (title.trim() ? title : "Untitled");
export const linkTitleOf = ({ entries, hidden }) => (id) => {
  if (!slipBoxShown(hidden)) return null;
  if (id === SLIPBOX) return "Slip-Box";
  const entry = entries[id];
  return entry && !entry.highlight ? nameOf(entry.title) : null;
};

// A tag's tooltip: what a click does, or that its target is gone.
export const linkHintOf = ({ entries, hidden }) => (id, gone) => {
  const note = slipBoxShown(hidden) && (id === SLIPBOX || (entries[id] && !entries[id].highlight));
  if (note) return gone ? "This note was removed" : "Open the note";
  return gone ? "This highlight was removed" : "Open the passage";
};

// Whether a follow's reply is a note to open, not a highlight: only while Slip-Box shows,
// since only then are links to notes offered.
const opensNote = (context, event) => slipBoxShown(context.hidden) && event.reply?.note != null && !marksPassage(event.reply.note.about);

// Whether the Slip-Box feature shows (3.1): not until `flags` answers, and not on a page
// without it, since the feature is not released until the admin releases it.
export const slipBoxShown = (hidden) => Array.isArray(hidden) && !hidden.includes("slip-box");

// The notes the "[[" picker offers, { id, title, about } each: while Slip-Box shows, the
// Slip-Box first, then every note but the open one and the highlights, the most recently
// edited first; none otherwise, so it never opens.
export function linkableNotes(context) {
  if (!slipBoxShown(context.hidden)) return [];
  const rest = Object.entries(context.entries)
    .filter(([id, e]) => id !== SLIPBOX && id !== context.id && !e.highlight && (context.notes === null || context.notes.includes(id)))
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .map(([id, e]) => ({ id, title: nameOf(e.title), about: e.about }));
  return [...(context.id === SLIPBOX ? [] : [{ id: SLIPBOX, title: "Slip-Box", about: "" }]), ...rest];
}

const without = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : list);

// --- The home line and the footer (Slip-Box) -------------------------------------------
// While Slip-Box shows, a note says above its text where it belongs, its book and chapter
// and its places in the Slip-Box, and at its bottom what it holds and what points at it.
// All of it is worked out here from what notes reported, so it is tested in Node.

// The Journal's book id (books/machine.js), copied because components never import each
// other (11.2): its name is known before any subject has named it.
const JOURNAL = "00000000000000000000000JRN";

// Whether a note exists, as far as notes has said (all of them while it has not answered).
const exists = (context, id) => id === SLIPBOX || context.notes === null || context.notes.includes(id);

// Whether a note's chain of parents reaches the Slip-Box; a loop never does.
export function inSlipBox(entries, id, seen = new Set()) {
  if (id === SLIPBOX) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  return (entries[id]?.parents ?? []).some((p) => inSlipBox(entries, p, seen));
}

// Whether `id` is `under` or a note under it, at any depth, so a note is never put under
// itself or under a note below it.
const below = (entries, id, under, seen = new Set()) => {
  if (id === under) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  return (entries[id]?.parents ?? []).some((p) => below(entries, p, under, seen));
};

// Whether taking the open note out of `place` would leave a permanent note outside the
// Slip-Box, the open note or one under it: a permanent note stays in the Slip-Box (13).
export function strands(context, place) {
  const own = links(context.about).filter((l) => l.kind === "note" && l.id !== place).map((l) => l.id);
  const after = { ...context.entries, [context.id]: { ...(context.entries[context.id] ?? {}), parents: own } };
  const before = { ...context.entries, [context.id]: { ...(context.entries[context.id] ?? {}), parents: links(context.about).filter((l) => l.kind === "note").map((l) => l.id) } };
  return Object.entries(after).some(
    ([id, e]) => e.noteType === "permanent" && !e.highlight && exists(context, id) && inSlipBox(before, id) && !inSlipBox(after, id),
  );
}

// Whether the open note is in the Slip-Box by the links it shows now.
const placedInBox = (context) => links(context.about).some((l) => l.kind === "note" && inSlipBox(context.entries, l.id));

// The link a new note gets at its first save while following the stage, or null. Only a
// Permanent note or the Slip-Box can have notes under it (13), so a new note written while
// another note is the subject is linked to nothing. With Slip-Box hidden types do not show,
// so no note is judged by one.
const newLink = (context) => {
  const { subjecting, subject, hidden, entries } = context;
  if (!subjecting || !subject) return null;
  if (subject.kind === "note" && subject.id !== SLIPBOX && slipBoxShown(hidden) && entries?.[subject.id]?.noteType !== "permanent") return null;
  return { kind: subject.kind, id: subject.id, ...chapterPart(subject) };
};

// The type a new note is made with (13), from the link it gets, so the two never disagree:
// permanent under a note, literature beside a book, and fleeting in the Journal or with no link.
export const defaultType = (context) => {
  const link = newLink(context);
  if (link?.kind === "note") return "permanent";
  return link?.kind === "book" && link.id !== JOURNAL ? "literature" : "fleeting";
};

// The text a new literature note starts with (13, Note type), with the blank line and the
// empty line the cursor waits on, as Enter after the title would leave them.
export const LITERATURE_START = "# Literature Note\n\n";

// What a page with no note yet holds: only while types show, since the text names a type.
const startText = (context) =>
  slipBoxShown(context.hidden) && context.id !== SLIPBOX && defaultType(context) === "literature" ? LITERATURE_START : "";

// Keeps such a page's text right as flags and the subject arrive, in `empty` and `blank`,
// which any typing leaves, so what they hold is always untouched. The text is also what
// `sent` holds, so it is not a change (dirty, unchanged) until the user edits it.
const prewrite = {
  guard: ({ context }) => context.body !== startText(context),
  actions: assign(({ context }) => {
    const body = startText(context);
    return { body, sent: body === "" ? null : { body } };
  }),
};

// Whether the editor shows pre-written text nobody has touched, so the view puts the cursor
// below the title.
export const prewritten = (snapshot) => snapshot.context.body !== "" && (snapshot.matches("empty") || snapshot.matches("blank"));

// The notes under the open note, judged by each note's parents. A
// deleted note's entry stays (entries, above), so it must still exist to count.
const notesUnder = (context) =>
  Object.keys(context.entries).filter((id) => id !== context.id && context.entries[id].parents.includes(context.id) && exists(context, id) && !context.entries[id].highlight);

// Why a permanent note with notes under it keeps its type: only a Permanent note can have
// notes under it (13). The same words as the note list's greyed trash.
const KEEPS_TYPE = "Move or delete the notes under it first";

// The type label and its menu, or null when the note has no type to show (Slip-Box hidden,
// a note not yet written, the Slip-Box itself, a highlight): `value`, the note's type, and
// `options`, each type with its line. `enabled` is false, with the reason in `why`, for the
// other types of a permanent note with notes under it. `needsPlace` marks permanent on a
// note outside the Slip-Box: a Permanent note must be in it (13), so the place is picked first.
export function noteTypeOf(context) {
  if (!rehomable(context) || context.entries[context.id]?.highlight) return null;
  const value = context.entries[context.id]?.noteType ?? "fleeting";
  const locked = value === "permanent" && notesUnder(context).length > 0;
  const needsPlace = value !== "permanent" && !placedInBox(context);
  return {
    value,
    options: NOTE_TYPES.map((t) =>
      t.value === "permanent"
        ? { ...t, enabled: true, ...(needsPlace ? { needsPlace } : {}) }
        : { ...t, enabled: !locked, ...(locked ? { why: KEEPS_TYPE } : {}) },
    ),
  };
}

// A place in the Slip-Box as the home line names it.
const placeLabel = (context, id) => {
  if (id === SLIPBOX) return "Slip-Box";
  const title = nameOf(context.entries[id]?.title ?? (context.subject?.id === id ? context.subject.title : ""));
  return inSlipBox(context.entries, id) ? `Slip-Box › ${title}` : title;
};

// The links the home line reads: the open note's, or, for a new note while following the
// stage, the one it will be given at its first save (savedEvent).
const homeLinks = (snapshot) => {
  const { about, baseVersion } = snapshot.context;
  if (links(about).length) return links(about);
  const fresh = ["empty", "blank", "refollowing", "editing"].some((state) => snapshot.matches(state));
  const link = baseVersion === null && fresh ? newLink(snapshot.context) : null;
  return link ? [link] : [];
};

// Whether the open note can be given a new place or lose one: a written note, never the
// Slip-Box itself, while Slip-Box shows.
const rehomable = (context) => slipBoxShown(context.hidden) && context.id != null && context.id !== SLIPBOX && context.baseVersion !== null;

// The home line, or null while Slip-Box is hidden or no note is open: `books`, each book
// or Journal link as "<book> · <chapter>", with the chapter label's button (relinkOf) on
// the first; `places`, each note the open note is under, by id and label; and `add`,
// whether "Add to Slip-Box…" shows, only on a Permanent note, and whether it has anywhere to
// offer. A place has an × (removable) once the note is written.
export function homeOf(snapshot) {
  const { context } = snapshot;
  const list = homeLinks(snapshot);
  if (!slipBoxShown(context.hidden) || (context.id == null && list.length === 0)) return null;
  const action = relinkOf(context)?.label ?? null;
  const books = list
    .filter((l) => l.kind === "book" && !l.place)
    .map((l) => {
      const title = context.titles?.[`book:${l.id}`] ?? (l.id === JOURNAL ? "Journal" : null);
      const text = [title, l.chapterTitle].filter(Boolean).join(" · ");
      return { id: l.id, text, action: list[0] === l ? action : null };
    })
    .filter((b) => b.text);
  // A new note's place is the one it will be given at its first save, so it has no ×.
  // A place whose loss would leave a permanent note outside the Slip-Box keeps its ×,
  // disabled, so the reason can be read (13).
  const places = list
    .filter((l) => l.kind === "note")
    .map((l) => ({ id: l.id, label: placeLabel(context, l.id), removable: rehomable(context), ...(rehomable(context) && strands(context, l.id) ? { stays: true } : {}) }));
  const type = noteTypeOf(context);
  const add = type?.value === "permanent" ? { enabled: slipBoxTargets(context).length > 0 } : null;
  // Nothing to name or offer (the Slip-Box itself, a highlight, a fresh note about
  // nothing): no line, so the editor keeps the header it has without Slip-Box.
  if (!books.length && !places.length && !type) return null;
  return { type, books, places, add };
}

// The places "Add to Slip-Box…" offers, { id, title, about } each: the Slip-Box, then
// every Permanent note whose chain of parents reaches it (13), the most recently edited
// first; never the open note, a note it is already under, or a note under it, so there is
// no loop.
export function slipBoxTargets(context) {
  if (!rehomable(context)) return [];
  const own = new Set(links(context.about).filter((l) => l.kind === "note").map((l) => l.id));
  const box = Object.entries(context.entries)
    .filter(([id, e]) => id !== SLIPBOX && !e.highlight && e.noteType === "permanent" && exists(context, id) && inSlipBox(context.entries, id))
    .filter(([id]) => !own.has(id) && !below(context.entries, id, context.id))
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .map(([id, e]) => ({ id, title: placeLabel(context, id), about: e.about }));
  return [...(own.has(SLIPBOX) ? [] : [{ id: SLIPBOX, title: "Slip-Box", about: "" }]), ...box];
}

// The first words of a passage, quoted, as the footer shows it.
const PASSAGE_WORDS = 7;
const firstWords = (text) => {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return `“${words.slice(0, PASSAGE_WORDS).join(" ")}${words.length > PASSAGE_WORDS ? "…" : ""}”`;
};

// The footer, or null while Slip-Box is hidden or no written note is open: `passages`, the
// highlights the note holds (its links of kind "highlight"), each by its first words and
// chapter, `gone` once the highlight is removed; `under`, the notes under it, in the panel's
// editor only (null on the stage, where the side list shows them), and only on a note that
// can have them or already does, so none becomes unreachable (13); `linked`, the notes whose
// text links to it. Each list as { id, title } in the order shown.
export function footerOf(context) {
  // A fresh note holds nothing and nothing links to it yet; the Slip-Box always shows it.
  if (!slipBoxShown(context.hidden) || context.id == null || (context.id !== SLIPBOX && context.baseVersion === null)) return null;
  const passages = links(context.about)
    .filter((l) => l.kind === "highlight")
    .map((l) => {
      const passage = exists(context, l.id) ? context.entries[l.id]?.passage : null;
      return passage ? { id: l.id, words: firstWords(passage.quote), chapter: passage.chapterTitle, gone: false } : { id: l.id, words: "A removed passage", chapter: null, gone: true };
    });
  const notesOf = (ids) =>
    ids
      .filter((id) => id !== context.id && exists(context, id) && context.entries[id] && !context.entries[id].highlight)
      .sort((a, b) => context.entries[b].updatedAt - context.entries[a].updatedAt)
      .map((id) => ({ id, title: nameOf(context.entries[id].title) }));
  const held = notesUnder(context);
  const showsUnder = !context.staged && (context.id === SLIPBOX || context.entries[context.id]?.noteType === "permanent" || held.length > 0);
  const under = showsUnder ? notesOf(held) : null;
  return { passages, under, linked: notesOf(context.linked) };
}

// Linked from after a note's news: a note whose text holds a link to the open one's id is
// in it, any other is not. A highlight never is, as notes: find leaves them out.
const linksTo = (body, id) => typeof body === "string" && body.includes(`(note:${id})`);
const linkedAfter = (context, event) => {
  const id = context.linkedFor;
  if (id == null || event.id === id) return context.linked;
  const holds = !marksPassage(event.about) && linksTo(event.body, id);
  if (holds) return context.linked.includes(event.id) ? context.linked : [...context.linked, event.id];
  return without(context.linked, event.id);
};

// A change of the open note's links from the home line or the footer (4.3, fifth rule):
// a save like the chapter label's, with the draft as it stands, carrying the new links;
// one step (12, Undo). The links change on screen at once; the echo brings back what
// notes now holds.
const rehome = (aboutOf) =>
  enqueueActions(({ context, event, enqueue }) => {
    const about = aboutOf({ context, event });
    enqueue.assign({ about, sent: { body: context.body }, finished: [], checkedText: context.body });
    enqueue.emit({ ...savedEvent(context), about });
  });

// When to ask notes which notes link to the note shown: while Slip-Box shows, whenever
// another note is shown.
const linkedDue = (context) => slipBoxShown(context.hidden) && context.id !== context.linkedFor;

// notes' news (4.3, fourth rule) for the source links: a note made, changed or brought
// back (Undo) exists; a deleted one does not. Run on every note.changed and note.deleted,
// whatever else the editor does with it.
const trackChanged = assign(({ context, event }) => ({
  notes: context.notes === null || context.notes.includes(event.id) ? context.notes : [...context.notes, event.id],
  removed: without(context.removed, event.id),
  entries: { ...context.entries, [event.id]: entryOf(event) },
  linked: linkedAfter(context, event),
}));
const trackDeleted = assign(({ context, event }) => ({
  notes: context.notes === null ? null : without(context.notes, event.id),
  removed: context.notes === null ? [...without(context.removed, event.id), event.id] : context.removed,
  linked: without(context.linked, event.id),
}));

// Which notes exist, from a list reply (the start's or a re-follow's), so a tag whose
// highlight was already gone is grey from the start; note.changed and note.deleted are
// held for the list until its reply lands (notes: list supersededBy).
const knownOf = (output) =>
  output && "known" in output ? output.known : Array.isArray(output?.notes) ? output.notes.map((n) => n.id) : null;
const takeKnown = assign({
  notes: ({ context, event }) => knownOf(event.output) ?? context.notes,
  entries: ({ context, event }) => (knownOf(event.output) === null ? context.entries : { ...context.entries, ...entriesOf(event.output.notes) }),
});

const assignTyped = assign({ body: ({ event }) => event.body });

// notes' pending flag (5) for any note, from a note.changed or a read reply: each pending
// news restarts the wait, and the server's acknowledgement ends it. Kept per note, so a
// note left unsynced says so again at once when it is opened again.
const watchSync = (of) =>
  enqueueActions(({ context, event, enqueue }) => {
    const note = of(event);
    if (!note?.id) return;
    enqueue.cancel(`unsynced:${note.id}`);
    if (note.pending === true) enqueue.raise({ type: "_unsynced", id: note.id }, { delay: NOT_SYNCED_MS, id: `unsynced:${note.id}` });
    else if (context.unsynced.includes(note.id)) enqueue.assign({ unsynced: without(context.unsynced, note.id) });
  });
const syncOfChange = watchSync((event) => event);
const syncOfRead = watchSync((event) => event.output?.note);

// Whether the open note's change has waited too long for the server (NOT_SYNCED_MS).
export const notSynced = (context) => context.id != null && context.unsynced.includes(context.id);

// The note shown is announced (6.4) by every editor but the stage's, since a note on the
// stage is never the panel's. The panel's editor also keeps it in the browser (3.1), so
// with keepOpen on a reload reopens it.
const announceOpened = (context, enqueue, id) => {
  if (context.staged) return;
  enqueue.emit({ type: "note.opened", id });
  if (context.subjecting) enqueue(() => context.rememberOpen?.(id));
};

// Whether the open note has a tab on a stage, from the stages' tabs.shown. Ids are
// ULIDs, so a note's id never names a book's tab.
export const isStaged = (context) =>
  context.id != null && Object.values(context.stageTabs).some((ids) => ids.includes(context.id));

// The Slip-Box (13): one fixed note, opened from the shelf onto the stage. Its id is
// fixed, like the journal's.
export const SLIPBOX = "00000000000000000000000SBX";

// The muted line the stage's editor shows while the Slip-Box has no text, so the empty
// page says what it is for; null for every other note and in every other editor.
export const hintOf = (context) =>
  context.staged && context.id === SLIPBOX ? "Write how your Slip-Box is arranged. The notes under it are beside." : null;

// A first keystroke into an editor holding no note mints its id (a ULID, the
// browser's own, 5) and starts editing it. The id changed, so the note it now shows
// is announced (note.opened), the same as a load or a reopen does on entering
// `loading`.
const mintAndType = {
  target: "editing.dirty",
  actions: enqueueActions(({ context, event, enqueue }) => {
    const id = context.mint();
    enqueue.assign({ id, body: event.body });
    announceOpened(context, enqueue, id);
  }),
};

// note.saved from the current draft. A new note (baseVersion null) written while
// following the stage carries one link to the subject, with its open chapter when it
// has one (D7, D2): about is on it only then, so every other save leaves the note's
// links as they are.
const savedEvent = (context) => {
  const event = {
    type: "note.saved",
    id: context.id,
    title: titleOf(context.body),
    body: context.body,
    baseVersion: context.baseVersion,
  };
  if (context.finished?.length) event.finished = context.finished;
  if (context.subjecting && context.baseVersion === null) {
    const link = newLink(context);
    event.about = link ? [link] : [];
  }
  // A new note gets its type at its first save, only while types show (13).
  if (context.baseVersion === null && slipBoxShown(context.hidden) && context.id !== SLIPBOX) event.noteType = defaultType(context);
  return event;
};

// Is there an unsaved change to send? A note with an id whose text differs from what
// notes last acknowledged (loaded, adopted, or our own last save).
const dirty = (context) =>
  context.id != null && (context.sent == null ? context.body !== "" : context.body !== context.sent.body);

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the note.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the editor shows of the account (14, signed out): "wait" until session answers, so
// neither the note nor the sign-in line flashes; "sign-in" signed out, since the panel
// keeps the editor in front across a reload and the note it holds is the account's;
// "show" otherwise. A try page (8) shows its visitor the editor.
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

// A note picked before it is written (the list's New note row, or its o and O): with Vim
// keys on, the keyboard arriving here starts in insert mode, so the user types at once.
// Not the empty page waiting for a subject, which nobody picked, and not the stage's
// editor, which shows only notes that exist.
export const startsTyping = (snapshot) => snapshot.matches("blank") && !snapshot.context.staged;

// --- Hashtag checks (line-checks) ------------------------------------------------------
// line-checks owns Jev's answers about the lines a hashtag line names (13, Hashtag check);
// the editor asks it for the note it shows, follows text.checked for that note, and turns
// the report into what the view draws. The same functions sit in journal-entry/machine.js,
// copied because components never import each other (11.2).

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
// and otherwise each answer's icon and name, a check where the option has no icon. A line
// whose answers all say nothing (a yes / no answered no) shows nothing.
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

// The lines the user finished, gathered until a save carries them to line-checks, each once.
const union = (a, b) => [...new Set([...(a ?? []), ...(Array.isArray(b) ? b : [])])];

// When to ask line-checks for the note shown: when another note (or none) is shown, and
// when the note's text changed other than by typing here (a load, a change from another
// device, an Undo), which line-checks learns from no save. While the user types, the save
// tells it. Null when nothing needs asking.
export function checksDue(context) {
  const { id, body, sent, checkedId, checkedText } = context;
  if (id !== checkedId) return { id, text: id == null ? null : body, reset: true };
  if (id != null && sent != null && sent.body === body && body !== checkedText) return { id, text: body, reset: false };
  return null;
}

// A finished line that nothing would save soon (the cursor moved off it with nothing left
// to save) goes to line-checks at once, in a save of the text notes already holds, which
// notes takes as no change. Otherwise it waits for the next save.
function finish(context, enqueue, lines) {
  const finished = union(context.finished, lines);
  if (finished.length === context.finished.length) return;
  if (context.id != null && context.baseVersion !== null && !dirty(context)) {
    enqueue.assign({ finished: [] });
    enqueue.emit(savedEvent({ ...context, finished }));
  } else enqueue.assign({ finished });
}

// The account's evaluators as the "#" picker offers them, { id, name, description } each,
// in the order evaluators lists them; a reply that is not a list (offline, no-answerer)
// offers none. Copied in journal-entry/machine.js, because components never import each
// other (11.2).
export const evaluatorsOf = (reply) =>
  Array.isArray(reply?.evaluators) ? reply.evaluators.map(pickable) : [];
const pickable = (e) => ({ id: e.id, name: e.name, description: e.description ?? "" });
// evaluator.changed replaces the one it names in its place, or adds a new one at the end.
export const withEvaluator = (list, evaluator) =>
  list.some((e) => e.id === evaluator.id)
    ? list.map((e) => (e.id === evaluator.id ? pickable(evaluator) : e))
    : [...list, pickable(evaluator)];

export const machine = setup({
  actors: {
    // The starting picture (4.3): every note, and — only while following the stage —
    // the current subject. subject.changed that races the read is held for us until the
    // reply lands (subject: read supersededBy), so a change is applied after it, in order.
    // Whether the open note is kept (keepOpen) too, while following, so the choice below
    // knows whether to reopen the note kept in the browser; settings.changed is held for
    // us until that reply lands (settings: read supersededBy).
    start: fromPromise(async ({ input }) => {
      const [list, subject, settings] = await Promise.all([
        input.ask("notes", "list", {}),
        input.subjecting ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null }),
        input.subjecting ? input.ask("settings", "read", {}) : Promise.resolve({}),
      ]);
      return {
        notes: list?.notes ?? [],
        known: Array.isArray(list?.notes) ? list.notes.map((n) => n.id) : null,
        subject: subject?.subject ?? null,
        keep: settings?.keepOpen === true,
      };
    }),
    list: fromPromise(({ input }) => input.ask("notes", "list", {})),
    read: fromPromise(({ input }) => input.ask("notes", "read", { id: input.id })),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Which features are hidden (3.1); flags.changed is held until the reply lands.
    flags: fromPromise(({ input }) => input.ask("flags", "read", {})),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // Every evaluator of the account, for the "#" picker: no book is named, so none is
    // left out; evaluator.changed and evaluator.deleted are held until the reply lands.
    evaluators: fromPromise(({ input }) => input.ask("evaluators", "list", {})),
    // line-checks' report for the note shown, from the answers it keeps (it never asks Jev
    // for a read); text.checked is held for us until the reply lands (read supersededBy).
    checks: fromCallback(({ input, sendBack }) => {
      Promise.resolve(input.ask("line-checks", "read", { kind: "note", id: input.id, text: input.text })).then(
        (reply) => sendBack({ type: "_checks", id: input.id, reply }),
        () => {},
      );
    }),
    // The notes whose text links to the note shown (Linked from); note.changed and
    // note.deleted are held for us until the reply lands (notes: find supersededBy).
    linked: fromCallback(({ input, sendBack }) => {
      Promise.resolve(input.ask("notes", "find", { contains: `(note:${input.id})`, limit: 50 })).then(
        (reply) => sendBack({ type: "_linked", id: input.id, reply }),
        () => {},
      );
    }),
    // Following a source link asks notes for the note it names beside whatever the editor is
    // doing, so the draft and its state are untouched; the reply comes back as _followed.
    follow: fromCallback(({ input, sendBack }) => {
      input.ask("notes", "read", { id: input.id }).then(
        (reply) => sendBack({ type: "_followed", id: input.id, reply }),
        () => sendBack({ type: "_followed", id: input.id, reply: null }),
      );
    }),
  },
  guards: {
    // The text is what notes already holds (what we last sent, loaded, or adopted),
    // so a pause here is not a change: no note.saved, no new version. The title is
    // derived from the text, so equal text is equal title.
    unchanged: ({ context }) => context.sent != null && context.sent.body === context.body,
    // A kept note to reopen (keepOpen), skipping the subject choice.
    hasRestore: ({ context }) => context.restoreId != null,
    // A keystroke landed while the start was still waiting for the subject.
    typedAhead: ({ context }) => context.id != null,
  },
  actions: {
    save: enqueueActions(({ context, enqueue }) => {
      // What was sent, so the echo of this save (a note.changed carrying it back)
      // is told apart from a real change from elsewhere, and a later pause that
      // ends on the same text saves nothing.
      enqueue.assign({ sent: { body: context.body }, typed: true, finished: [], checkedText: context.body });
      enqueue.emit(savedEvent(context));
    }),
    // The user left the note (the keyboard left the editor, or another note opens): one
    // last save says so, so `notes` ends the stretch of typing as one step (12, Undo). It
    // carries the draft when it is dirty, and the text notes holds otherwise.
    leave: enqueueActions(({ context, enqueue }) => {
      if (context.id == null || !(context.typed || dirty(context))) return;
      enqueue.assign({ sent: { body: context.body }, typed: false, finished: [], checkedText: context.body });
      enqueue.emit({ ...savedEvent(context), left: true });
    }),
    // Take the subject the stage holds, from the start reply or from subject.changed, and
    // keep its title in the browser (3.1) so the About line can name a kept note's
    // book after a reload. One action, so the table in context and the stored one cannot
    // drift apart.
    takeSubject: enqueueActions(({ context, event, enqueue }) => {
      const subject = event.subject;
      const titles = withTitle(context.titles, subject);
      enqueue.assign({ subject, titles, subjectObserved: true });
      if (titles !== context.titles) enqueue(() => context.rememberTitles?.(titles));
    }),
    // The subject from the start reply is the starting picture (4.3), so it yields to
    // any subject.changed that raced ahead of it while the notes list was still loading,
    // including one that cleared the stage to null. Once a change has been observed
    // (subjectObserved) the reply is the older picture and is dropped.
    takeStartSubject: enqueueActions(({ context, event, enqueue }) => {
      if (context.subjectObserved) return;
      const subject = event.output.subject;
      const titles = withTitle(context.titles, subject);
      enqueue.assign({ subject, titles });
      if (titles !== context.titles) enqueue(() => context.rememberTitles?.(titles));
    }),
    // Ask line-checks for the note shown (checksDue); a text without a "#" has no hashtag
    // line, so there is nothing to ask and nothing to show.
    readChecks: enqueueActions(({ context, enqueue }) => {
      const due = checksDue(context);
      // The pre-written title is no hashtag line, and no note is written yet.
      const hashed = due.text !== LITERATURE_START && due.text?.includes("#") === true;
      enqueue.assign({ checkedId: due.id, checkedText: due.text, ...(due.reset || !hashed ? { checks: null } : {}) });
      enqueue.stopChild("checks");
      if (hashed) enqueue.spawnChild("checks", { id: "checks", input: { ask: context.ask, id: due.id, text: due.text } });
    }),
    // Ask notes which notes link to the note shown (linkedDue).
    readLinked: enqueueActions(({ context, enqueue }) => {
      enqueue.assign({ linkedFor: context.id, linked: [] });
      enqueue.stopChild("linked");
      if (context.id != null) enqueue.spawnChild("linked", { id: "linked", input: { ask: context.ask, id: context.id } });
    }),
    // A pick opens its note, also while keepOpen is on; the note open before is left.
    open: enqueueActions(({ event, enqueue }) => {
      enqueue({ type: "leave" });
      enqueue.assign({ id: event.id, body: "", baseVersion: null, sent: null, about: [], typed: false });
    }),
    // keepOpen from the start reply, unless a settings.changed came first and is newer;
    // while it is on, the note kept in the browser reopens.
    takeStartKeep: enqueueActions(({ context, event, enqueue }) => {
      const keep = context.keepObserved ? context.keep : event.output.keep;
      enqueue.assign({ keep });
      if (keep && context.kept != null) enqueue.assign({ restoreId: context.kept });
    }),
  },
}).createMachine({
  id: "note-editor",
  meta: {
    description:
      "Edits one note as a single page whose lines have four levels, Title, Heading, Subheading " +
      "and Body, set from four buttons at the bottom that mark the level of the line under the " +
      "cursor, flash when a level changes, and show their Vim keys while Vim keys is on. It " +
      "saves a short time into typing and when the editor loses focus, without saying so each " +
      "time: a muted \"Not synced\" shows under the note only while its change has waited " +
      "more than five seconds for the server (offline, or the server failing), and goes when " +
      "the server has it. Leaving the note, when the keyboard leaves the editor or another " +
      "note opens, says so with one last save, so Undo takes back everything typed since " +
      "the note was entered as one step (section 12); a change notes makes to the open " +
      "note, such as an Undo, shows at once while nothing typed would be lost. With Vim keys on, a new " +
      "note picked in the list (its New note row, or o or O there) starts in insert mode when " +
      "the keyboard arrives, so the user types at once; an existing note, the empty page " +
      "waiting for a subject and a note tab on the stage start in normal mode. With `subject` it opens " +
      "the most recently edited note about the subject whenever the subject changes, or an " +
      "empty page that a note about the subject arriving later fills. While a chapter is open " +
      "(the Journal's open day), it opens the most recently edited note linked to that chapter, " +
      "never a note linked to the whole book, and the empty page when the chapter has none; " +
      "turning to another chapter opens that chapter's note the same way, except while the " +
      "note is kept or the keyboard is in it, and the next chapter change after the keyboard " +
      "has left it follows again. Moving into a part with no chapter keeps the note. A new note is linked to " +
      "the subject at its first save, and to the chapter open in it (the Journal's open day), " +
      "the About line names the book, and plain muted text under it names the chapter the note " +
      "is linked to, as the chapter's title read when it was linked, or \"Whole book\" " +
      "(\"Whole Journal\") when it is linked to no chapter. While the note's book is the " +
      "subject and a chapter is open, the label offers one button, shown only while the pointer " +
      "or the keyboard is on the label (a tap on a phone): Unlink, when the note is " +
      "linked to the open chapter, which links it to the whole book, or \"Link to\" and the " +
      "open chapter's title otherwise, which also moves it from another chapter; the label " +
      "turns at once, and pressing again reverses it. A keystroke made " +
      "before the subject is known waits for it. While the device preference \"Keep the open " +
      "note and chat\" (`settings`) is on, the editor stays on its note " +
      "when the subject changes and picking another note opens it; while it is off, as it is at " +
      "first, the editor follows the subject. The open note and the titles of subjects seen are " +
      "kept in this browser, so with the preference on the note comes back after a reload. It " +
      "announces the note it shows, or none for the " +
      "empty page, so the list and `notes` know which note is open; a highlight is never opened " +
      "here. With Vim keys on, p pastes text or a link copied in the reader with Vim keys, paragraphs kept. A source link to a highlight, pasted from the reader's Copy link (or with p after " +
      "the reader's y while Vim keys is on), is drawn as one tag, the link icon and the start of " +
      "the quote, that the cursor steps over and Backspace or x removes whole; a click on it, " +
      "or Enter on it in Vim's normal mode, opens the book at the passage. A tag turns grey " +
      "and struck through, and opens nothing, as soon as its highlight is removed, or at once " +
      "when the highlight was already gone as the note opens, and turns back when the removal " +
      "is undone. While Slip-Box is shown, typing [[ opens a list of the notes by title, with " +
      "each note's first line under it, the Slip-Box first, then the most recently edited, " +
      "never a highlight or the open note, narrowed as the title is typed, with the same keys " +
      "as the # list; picking one writes a link to that note by its id, drawn as a tag. " +
      "Then a tag linking to a note shows that note's title as it is now, so renaming a note " +
      "renames every tag that links to it and no linking text changes; the title written " +
      "in the link shows only, grey, when the note is gone. A click on it, or Enter in Vim's " +
      "normal mode, opens that note, found by the id alone: here, or, in the stage's editor, " +
      "on a tab of its own on the stage; a link to the Slip-Box opens it on the stage. " +
      "While Slip-Box is shown, a muted line above the text, in this editor and in the stage's, says where " +
      "the note belongs, in place of the About line and the chapter label: its book and chapter (\"Journal · \" and the day " +
      "for the Journal), with the chapter label's Link or Unlink button on hover; then each note it is under, " +
      "as \"Slip-Box\" or \"Slip-Box › \" and that note's title (only the title for a note outside the " +
      "Slip-Box), which opens that note on a click, with an × that takes it out of that place; then, on a " +
      "Permanent note only, \"Add to Slip-Box…\", which opens a list in the look of the [[ list, never wider than the editor, of the " +
      "Slip-Box and every Permanent note whose chain of parents reaches it, never the note itself, a place it has or a " +
      "note under it, so no loop is made; the arrow keys or Ctrl+N and Ctrl+P (and j and k with Vim keys) " +
      "choose, Enter, Tab or a click adds the note there, Escape or moving away closes it. Each of these " +
      "changes is a save of the note's links, one step for Undo. At the left of that line is the note's type, " +
      "Fleeting, Literature or Permanent, which opens a small menu of the three, each with one line saying what it is for; " +
      "the arrow keys (and j and k with Vim keys) choose, Enter or a click sets it, one step for Undo, Escape closes it " +
      "and gives the keyboard back to the label. With Vim keys on, the label names its key, \\t, in Vim's normal mode, " +
      "which opens the menu from the text, in the panel's editor and on the stage; closing it or setting a type, through " +
      "the Add to Slip-Box list too, gives the keyboard back to the text in normal mode with the cursor where it was. A note " +
      "with no label ignores the key, and so does every other editor. Permanent can always be picked: on a note outside the Slip-Box it opens the " +
      "Add to Slip-Box list, and picking a place there saves the place and the type together, one step for Undo, while Escape " +
      "changes nothing. Changing a type never changes the note's links. A permanent note stays in the Slip-Box: the × of a " +
      "place whose loss would take it, or a permanent note under it, out of the Slip-Box is greyed and says so. A Permanent " +
      "note with notes under it keeps its type: the other two are greyed with the tooltip \"Move or delete the notes under it " +
      "first\", and a press or Enter on one shows those words in its line and changes nothing. A new note is " +
      "permanent when it is made under a Permanent note or the Slip-Box, literature when it is made beside a book, and " +
      "fleeting in the Journal or with no link. A new literature note starts with the line \"Literature Note\" at Title level " +
      "and the cursor on a new line below it, after a gap, on the empty page as on a new note picked in the list, also " +
      "after turning to a chapter with no note or an Undo of a new note. That text alone is an empty page: leaving it " +
      "saves nothing and no note exists, and a note about the subject arriving later fills it. The first change, to " +
      "the title or below it, saves the whole text, one step for Undo, and from then on it is text like any other: a " +
      "later change of type never touches it, and changing an existing note to Literature adds no title. With Slip-Box " +
      "hidden a new note starts empty. A new note written while a note that is not Permanent is the subject is " +
      "linked to nothing, since only a Permanent note or the Slip-Box can have notes under it; a " +
      "note without a type is fleeting. With Slip-Box hidden the type is kept but not shown. Fixed at the bottom of a written note and of the Slip-Box, above the level bar, " +
      "three sections fold each with its caret, the folds kept in this browser for every note: Passages, the " +
      "highlights the note holds, each by its first seven words quoted and its chapter, a click opening the " +
      "book at the passage and an × taking it out of the note (one step), a removed one grey; Notes under " +
      "this, on a Permanent note, the Slip-Box and any note that already holds notes, only here and not on the stage, where the side list shows them, a click opening it here; and " +
      "Linked from, the notes whose text links to this one by its id, a click opening it here, or on a tab " +
      "of its own from the stage. An empty section says so in one muted line. With Slip-Box hidden none of " +
      "this shows. With `subject` the " +
      "header also has Open on stage (and `:tab split` or `:tab sp` while Vim " +
      "keys is on), which shows the note on the stage as a tab of its own; the button is " +
      "accent while the note has a tab there, its arrow points towards the stage, also after the " +
      "desk moves its dock, and it is " +
      "disabled while the editor holds no note. With `stage` it is the editor the stage shows " +
      "for a note tab: it follows no subject and no selection, is never kept, has no header, never " +
      "announces its note, shows the note the stage names by `load`, and `:q`, `:tabc` or " +
      "`:tabclose` closes the tab without changing the note. While it shows the Slip-Box and " +
      "the Slip-Box has no text, a muted line in its place says \"Write how your Slip-Box is " +
      "arranged. The notes under it are beside.\" until the first letter is typed. Signed out it shows only \"Sign " +
      "in to see your notes.\" and nothing of the note it holds, also when it was in front " +
      "before a reload; the note stays kept in this browser and comes back when the user signs " +
      "in, without a reload. On a try page a visitor not yet signed in still sees the editor." +
      " A web address, bare or written as [label](https://…), is drawn as an underlined link in " +
      "the accent color, a markdown link showing only its label except on the line being " +
      "edited; a click on it, or gx with Vim keys on, opens it in a new browser tab. A " +
      "hashtag, such as #in-my-control, is drawn in the accent color when it names one of the " +
      "account's evaluators and muted when it names none; each line it names (the lines after " +
      "it in the same paragraph or list) is checked by line-checks once the user finishes it " +
      "(moves off it, presses Enter, pastes, or leaves the editor), and its answer shows at " +
      "the line's end as the option's icon and name, several joined in one row: a pulsing dot " +
      "while Jev is asked, and a warning whose tooltip says why when it could not be. Your " +
      "values gets one compass per line, whose name says which values: red when it goes against " +
      "any, green when it serves one, uncolored when Jev can't tell." +
      " Typing # at the start of a word opens a list of the account's evaluators by their " +
      "short names, each with its description on a line under it, narrowed as the name is " +
      "typed; the arrow keys (or Ctrl+N and Ctrl+P) choose, Enter, Tab, a click or a tap " +
      "writes the name and a space, and Escape or moving away closes it. Enter at the end of " +
      "a hashtag line starts a bullet directly below it, so the lines written next are the " +
      "ones it checks.",
    kind: "view",
    emits: ["note.saved", "note.opened", "passage.selected", "note.staged", "note.closed"],
    attributes: ["height", "follows", "subject", "stage"],
    asks: ["notes: list", "notes: read", "notes: find", "subject: read", "settings: read", "session: read", "line-checks: read", "evaluators: list", "flags: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    focus: input.focus,
    // Present: this editor loads whatever the list selects (6.4). Absent: it ignores
    // note.selected, so a future page with several editors leaves it off and a
    // container tells one editor to load by command instead.
    follows: input.follows,
    // The `subject` attribute (D5): present means follow the stage — open the note about
    // it and re-follow on a change. Off is exactly today's behaviour.
    subjecting: Boolean(input.subjecting),
    // The `stage` attribute: the editor a stage shows for a note tab, told what to show by
    // `load` alone.
    staged: Boolean(input.staged),
    // The tab ids each stage last announced (tabs.shown), by the stage's address, so the
    // Open on stage button knows whether the open note is there already.
    stageTabs: {},
    // How many desk layouts it has seen (dock.changed): a dock moved without changing size
    // fires no resize, so this is what tells the view to point the arrow again.
    layouts: 0,
    // The note this editor last showed, kept in the browser (3.1) through input so the
    // machine stays importable in Node; reopened at start while keepOpen is on.
    rememberOpen: input.rememberOpen,
    kept: input.subjecting ? input.recallOpen?.() ?? null : null,
    // The kept note to reopen at start.
    restoreId: null,
    // The device preference keepOpen (12, `settings`): the note stays when the stage
    // changes. Whether settings.changed arrived before the start reply, which is then the
    // older picture.
    keep: false,
    keepObserved: false,
    id: null,
    body: "",
    baseVersion: null,
    sent: null,
    // The open note's links, for the About line (D7): [] until a note with links loads.
    about: [],
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    // Whether a subject.changed has been observed: once it has, the start reply's
    // subject is the older starting picture and must not overwrite the change, even
    // when the change cleared the stage to null. takeStartSubject reads this.
    subjectObserved: false,
    // Titles of subjects this browser has seen, so the About line can name a link (D7,
    // D9): recalled from the view's own storage (3.1) and written back through
    // rememberTitles, like the open note.
    rememberTitles: input.rememberTitles,
    // The stage's editor reads them too, for its home line, and learns new ones from
    // subject.changed without writing them back, which the panel's editor does.
    titles: input.recallTitles?.() ?? {},
    // The "Vim keys" device preference (12), owned by `settings`: off until it says
    // otherwise, and off on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // Whether the keyboard is in the editor (UI state), from the view's focus and blur.
    focused: false,
    // Whether a save went out since the user last left the note (12, Undo).
    typed: false,
    // Puts text or a source link copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    // Source links a follow found gone (UI state): their tags are drawn removed.
    removed: [],
    // The notes whose change has waited longer than NOT_SYNCED_MS for the server.
    unsynced: [],
    // The ids of every note notes lists, for the source links' tags; null until it answers.
    notes: null,
    // What is known of each note a link may name (entryOf), for the tags' titles and the
    // "[[" picker.
    entries: {},
    // The features `flags` reports hidden (3.1); null until it answers.
    hidden: null,
    // Whether a kept note's reopening is in flight, so a not-found one chooses from the
    // start picture instead.
    restoring: false,
    // The notes fetched at start, kept so a kept note that is gone can choose from the same
    // picture without a second query.
    startNotes: [],
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
    // line-checks' report for the open note (text.checked's shape), null while there is none.
    checks: null,
    // The note and the text line-checks last learned from this editor, by a read or a save.
    checkedId: null,
    checkedText: null,
    // The lines the user finished that no save has carried yet (note.saved's finished).
    finished: [],
    // The account's evaluators the "#" picker offers (evaluatorsOf); none until evaluators
    // answers.
    evaluators: [],
    // The notes whose text links to the note shown (Linked from), and that note's id.
    linked: [],
    linkedFor: null,
  }),
  initial: "starting",
  // Asked after any change that shows another note or another text (checksDue), so no
  // state can forget it.
  always: [
    { guard: ({ context }) => checksDue(context) != null, actions: "readChecks" },
    { guard: ({ context }) => linkedDue(context), actions: "readLinked" },
  ],
  // Beside the states, so the preference arrives whatever the editor is doing and a
  // keystroke never waits for it. settings.changed that races it is held for us until
  // the reply lands (settings: read supersededBy).
  invoke: [
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
      src: "flags",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ hidden: ({ event }) => (Array.isArray(event.output?.hidden) ? event.output.hidden : null) }) },
      onError: { actions: [] },
    },
    {
      src: "evaluators",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ evaluators: ({ event }) => evaluatorsOf(event.output) }) },
      onError: { actions: assign({ evaluators: [] }) },
    },
  ],
  on: {
    // evaluators' news, for the "#" picker.
    "evaluator.changed": { actions: assign({ evaluators: ({ context, event }) => withEvaluator(context.evaluators, event.evaluator) }) },
    "evaluator.deleted": { actions: assign({ evaluators: ({ context, event }) => context.evaluators.filter((e) => e.id !== event.id) }) },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null }) },
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    // Lines the user finished (the view sends them before the blur that also finishes them).
    _finished: { actions: enqueueActions(({ context, event, enqueue }) => finish(context, enqueue, event.lines)) },
    // line-checks' report for the note shown: from the read, or announced after a check.
    _checks: {
      guard: ({ context, event }) => event.id === context.checkedId && event.reply?.source != null,
      actions: assign({ checks: ({ event }) => event.reply }),
    },
    "text.checked": {
      guard: ({ context, event }) => event.source.kind === "note" && event.source.id === context.checkedId,
      actions: assign({ checks: ({ event }) => event }),
    },
    // Whether the keyboard is in the note, so a chapter change does not swap the note the
    // user is writing in. Beside the states, so no state can miss the keyboard leaving.
    _focused: { actions: assign({ focused: true }) },
    _blurred: { actions: ["leave", assign({ focused: false })] },
    "dock.changed": { actions: assign({ layouts: ({ context }) => context.layouts + 1 }) },
    _unsynced: {
      guard: ({ context, event }) => !context.unsynced.includes(event.id),
      actions: assign({ unsynced: ({ context, event }) => [...context.unsynced, event.id] }),
    },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true, keep: ({ event }) => event.keepOpen === true, keepObserved: true }) },
    // A command addressing this instance (4.4).
    load: { target: ".loading", actions: "open" },
    // The list's gesture (4.3, fifth rule), taken only when this editor follows the
    // selection. An unfollowing editor leaves it to the bus to record as ignored.
    "note.selected": { guard: ({ context }) => context.follows, target: ".loading", actions: "open" },
    focus: { actions: ({ context }) => context.focus() },
    "tabs.shown": {
      actions: assign({ stageTabs: ({ context, event }) => ({ ...context.stageTabs, [event.view]: event.tabs.map((t) => t.id) }) }),
    },
    // Open on stage, or `:tab split` (4.3, fifth rule): the stage decides what that means.
    // Pressed again while the note is on the stage, it brings that tab to the front.
    _stage: {
      guard: ({ context }) => context.subjecting && !context.staged && context.id != null,
      actions: emit(({ context }) => ({ type: "note.staged", id: context.id })),
    },
    // The chapter label's button (4.3, fifth rule): a save like any other, with the
    // draft as it stands and its base version, carrying the new links. The label turns at
    // once; the echo brings back what notes now holds. Pressed again, it reverses itself.
    _relink: {
      guard: ({ context }) => relinkOf(context) != null,
      actions: enqueueActions(({ context, enqueue }) => {
        const { about } = relinkOf(context);
        enqueue.assign({ about, sent: { body: context.body }, finished: [], checkedText: context.body });
        enqueue.emit({ ...savedEvent(context), about });
      }),
    },
    // The home line: a place picked in the Add to Slip-Box list, or one taken away with its ×.
    // The list is reached only from a Permanent note or from picking Permanent, so a place
    // and the type are one save, and one step (12, Undo).
    _place: {
      guard: ({ context, event }) => noteTypeOf(context) != null && slipBoxTargets(context).some((t) => t.id === event.id),
      actions: enqueueActions(({ context, event, enqueue }) => {
        const about = [...links(context.about), { kind: "note", id: event.id }];
        const entry = context.entries[context.id] ?? entryOf({ about: context.about });
        enqueue.assign({ about, entries: { ...context.entries, [context.id]: { ...entry, noteType: "permanent" } }, sent: { body: context.body }, finished: [], checkedText: context.body });
        enqueue.emit({ ...savedEvent(context), about, noteType: "permanent" });
      }),
    },
    _unplace: {
      guard: ({ context, event }) =>
        rehomable(context) && links(context.about).some((l) => l.kind === "note" && l.id === event.id) && !strands(context, event.id),
      actions: rehome(({ context, event }) => links(context.about).filter((l) => !(l.kind === "note" && l.id === event.id))),
    },
    // The type menu (13): a save of the note's type with the draft as it stands, one step.
    // The label turns at once; the echo brings back what notes now holds.
    _retype: {
      guard: ({ context, event }) => {
        const type = noteTypeOf(context);
        return type != null && type.value !== event.noteType && type.options.some((t) => t.value === event.noteType && t.enabled && !t.needsPlace);
      },
      actions: enqueueActions(({ context, event, enqueue }) => {
        const entry = context.entries[context.id] ?? entryOf({ about: context.about });
        enqueue.assign({ entries: { ...context.entries, [context.id]: { ...entry, noteType: event.noteType } }, sent: { body: context.body }, finished: [], checkedText: context.body });
        enqueue.emit({ ...savedEvent(context), noteType: event.noteType });
      }),
    },
    // The footer: a passage taken out of the note with its ×, or opened with a click.
    _unpassage: {
      guard: ({ context, event }) => rehomable(context) && links(context.about).some((l) => l.kind === "highlight" && l.id === event.id),
      actions: rehome(({ context, event }) => links(context.about).filter((l) => !(l.kind === "highlight" && l.id === event.id))),
    },
    _passage: {
      guard: ({ context, event }) => context.entries[event.id]?.passage != null && exists(context, event.id),
      actions: emit(({ context, event }) => {
        const { book, place } = context.entries[event.id].passage;
        return { type: "passage.selected", book, id: event.id, place };
      }),
    },
    _linked: {
      guard: ({ context, event }) => event.id === context.linkedFor && Array.isArray(event.reply?.notes),
      actions: assign({ linked: ({ event }) => event.reply.notes.map((n) => n.id).filter((id) => id !== event.id) }),
    },
    // `:q`, `:tabc` or `:tabclose` in the stage's editor closes the note's tab.
    _quit: {
      guard: ({ context }) => context.staged && context.id != null,
      actions: emit(({ context }) => ({ type: "note.closed", id: context.id })),
    },
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, blocks a blank line apart as paragraphs are.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    // A click on a source link, or Enter on it in Vim's normal mode: ask notes for the
    // note the link's id names, never for its label. A second follow replaces one still
    // waiting. The Slip-Box lives on the stage (13), so it goes there at once.
    _follow: [
      {
        guard: ({ context, event }) => event.id === SLIPBOX && context.id !== SLIPBOX && slipBoxShown(context.hidden),
        actions: emit({ type: "note.staged", id: SLIPBOX }),
      },
      {
        guard: ({ event }) => event.id !== SLIPBOX,
        actions: [
          stopChild("follow"),
          spawnChild("follow", { id: "follow", input: ({ context, event }) => ({ ask: context.ask, id: event.id }) }),
        ],
      },
    ],
    // The reply: a highlight opens its passage (passage.selected); a note opens in this
    // editor, or, from the stage's editor, as a tab of its own on the stage (note.staged);
    // a note that is gone has its tag drawn removed.
    _followed: [
      {
        guard: ({ event }) => passageOf(event.reply, event.id) != null,
        actions: [
          assign({ removed: ({ context, event }) => without(context.removed, event.id) }),
          emit(({ event }) => ({ type: "passage.selected", ...passageOf(event.reply, event.id) })),
        ],
      },
      {
        guard: ({ context, event }) => opensNote(context, event) && context.staged,
        actions: [assign({ removed: ({ context, event }) => without(context.removed, event.id) }), emit(({ event }) => ({ type: "note.staged", id: event.id }))],
      },
      {
        guard: ({ context, event }) => opensNote(context, event) && event.id !== context.id,
        target: ".loading",
        actions: [assign({ removed: ({ context, event }) => without(context.removed, event.id) }), "open"],
      },
      {
        guard: ({ event }) => event.reply?.error === "not-found",
        actions: assign({
          removed: ({ context, event }) => [...without(context.removed, event.id), event.id],
        }),
      },
    ],
    // The stage moved (4.3): a different subject is on it. Held for us until the starting
    // subject: read reply lands (subject: read supersededBy), so it is never lost and
    // never applied before the picture it supersedes. Ignored when not following.
    "subject.changed": [
      {
        // Kept (keepOpen with a note open, or a kept note still loading), the same thing with a new
        // title only, or another chapter while the user is in the note: take the subject
        // and its title but keep the note on screen (D7). The note in the user's hands is
        // never swapped from under the keyboard; the next chapter change after the keyboard
        // has left it re-follows.
        guard: ({ context, event }) =>
          context.subjecting &&
          ((context.keep && context.id != null) ||
            context.restoring ||
            (sameThing(context.subject, event.subject) && !otherChapter(context.subject, event.subject)) ||
            (otherChapter(context.subject, event.subject) && context.focused)),
        actions: "takeSubject",
      },
      {
        // A different thing on the stage, or another chapter of it, not kept: save a
        // dirty draft (its links are the old subject's, still in context here), take the
        // new subject, and re-follow.
        guard: ({ context }) => context.subjecting,
        target: ".refollowing",
        actions: [
          "leave",
          "takeSubject",
          assign({
            id: null,
            body: "",
            baseVersion: null,
            sent: null,
            about: [],
          }),
        ],
      },
      // Not following (the stage's editor): only the subject's title, for the home line.
      { actions: assign({ titles: ({ context, event }) => withTitle(context.titles, event.subject) }) },
    ],
    // The fact's news that the open note is gone (4.3, fourth rule): fall back to the
    // empty page, where a keystroke starts a fresh note. A deletion of another note only
    // greys the tags that link to it.
    "note.deleted": [
      {
        guard: ({ context, event }) => event.id === context.id,
        target: ".empty",
        actions: [trackDeleted, assign({ id: null, body: "", baseVersion: null, sent: null, about: [], typed: false })],
      },
      { actions: trackDeleted },
    ],
    // The fact's news (4.3, fourth rule). A change for another note only brings back the
    // tags that link to it.
    "note.changed": [
      {
        // The echo of this editor's own save: bump baseVersion, take the links notes
        // now holds, and stay in the current state so a keystroke made since is not lost.
        guard: ({ context, event }) =>
          event.id === context.id && context.sent != null && event.body === context.sent.body,
        actions: [trackChanged, syncOfChange, assign({ baseVersion: ({ event }) => event.version, about: ({ event }) => links(event.about) })],
      },
      {
        // A newer change from elsewhere: adopt it (the user's decision, 12), even
        // over a dirty draft. A first note.changed (baseVersion null) counts.
        guard: ({ context, event }) =>
          event.id === context.id && (context.baseVersion === null || event.version > context.baseVersion),
        target: ".editing.clean",
        actions: [
          trackChanged,
          syncOfChange,
          assign({
            body: ({ event }) => event.body,
            baseVersion: ({ event }) => event.version,
            sent: ({ event }) => ({ body: event.body }),
            about: ({ event }) => links(event.about),
          }),
        ],
      },
      {
        // The text changed in this browser without a new version (an Undo or Keep mine
        // while signed in, 12): adopted while nothing typed here would be lost.
        guard: ({ context, event }) =>
          event.id === context.id && context.sent != null && event.version === context.baseVersion && !dirty(context) && event.body !== context.body,
        target: ".editing.clean",
        actions: [
          trackChanged,
          syncOfChange,
          assign({
            body: ({ event }) => event.body,
            sent: ({ event }) => ({ body: event.body }),
            about: ({ event }) => links(event.about),
          }),
        ],
      },
      { actions: [trackChanged, syncOfChange] },
    ],
  },
  states: {
    // The starting picture (4.3, fourth rule): every note and the current subject, so a
    // reload continues where the user left off. A keystroke meanwhile is the user's
    // answer instead, and leaving the state drops the query's reply.
    starting: {
      invoke: {
        src: "start",
        input: ({ context }) => ({ ask: context.ask, subjecting: context.subjecting }),
        onDone: [
          // The user typed while following the stage: the subject is known now, so the
          // note starts its throttle here and its first save carries the link (12).
          { guard: "typedAhead", target: "editing.dirty", actions: [takeKnown, "takeStartSubject", "takeStartKeep"] },
          {
            target: "choosing",
            actions: [takeKnown, "takeStartSubject", "takeStartKeep", assign({ startNotes: ({ event }) => event.output.notes })],
          },
        ],
        onError: [
          { guard: "typedAhead", target: "editing.dirty" },
          { target: "choosing", actions: assign({ startNotes: [] }) },
        ],
      },
      on: {
        _typed: [
          {
            // Following the stage, a keystroke stays here until the subject is known, so
            // a new note is never saved without its link (12). The text is on screen
            // meanwhile; the id is minted, and announced, once.
            guard: ({ context }) => context.subjecting,
            actions: enqueueActions(({ context, event, enqueue }) => {
              if (context.id == null) {
                const id = context.mint();
                enqueue.assign({ id });
                announceOpened(context, enqueue, id);
              }
              enqueue.assign({ body: event.body });
            }),
          },
          mintAndType,
        ],
        // The stage moved before the notes arrived: take the subject and stay, so
        // `choosing` still runs — a kept note is reopened, and the note chosen is
        // about the subject now on the stage. Tried before the root handler, which
        // would re-follow and skip the choice.
        "subject.changed": { guard: ({ context }) => context.subjecting, actions: "takeSubject" },
      },
    },
    // The start replies are in: a kept note reopens (keepOpen), else the newest
    // note about the subject, else the empty page. A synchronous choice, so a keystroke
    // never lands here.
    choosing: {
      always: [
        // The stage's editor opens only what `load` names.
        { guard: ({ context }) => context.staged, target: "empty" },
        {
          guard: "hasRestore",
          target: "loading",
          actions: assign({ id: ({ context }) => context.restoreId, restoring: true }),
        },
        {
          guard: ({ context }) => pickId(context.startNotes, context.subject, context.subjecting) != null,
          target: "loading",
          actions: assign({ id: ({ context }) => pickId(context.startNotes, context.subject, context.subjecting) }),
        },
        { target: "empty" },
      ],
    },
    // No note yet: typing starts one. Announced, so the note last shown is not taken
    // for the open one (12, "Which note is open").
    empty: {
      entry: enqueueActions(({ context, enqueue }) => announceOpened(context, enqueue, null)),
      always: prewrite,
      on: {
        _typed: mintAndType,
        // A note for the subject (in its open chapter, when it has one) arrived after the
        // choice was made (12): from the load's pull, or another device. Nothing is typed
        // here yet, so choose again.
        "note.changed": {
          guard: ({ context, event }) => context.subjecting && context.subject != null && ofSubject(event, context.subject),
          target: "refollowing",
          actions: [trackChanged, syncOfChange],
        },
      },
    },
    // A load command, a follow of the list's selection, the start, or a re-follow asked
    // notes for the note; the reply decides where we land. Entering here the id has just
    // changed, so the note now shown is announced once (note.opened).
    loading: {
      entry: enqueueActions(({ context, enqueue }) => announceOpened(context, enqueue, context.id)),
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.id }),
        onDone: [
          {
            guard: ({ event }) => "note" in event.output,
            target: "editing.clean",
            actions: [
              syncOfRead,
              assign({
                body: ({ event }) => event.output.note.body,
                baseVersion: ({ event }) => event.output.note.version,
                sent: ({ event }) => ({ body: event.output.note.body }),
                about: ({ event }) => links(event.output.note.about),
                restoring: false,
              }),
            ],
          },
          {
            // A kept note that is gone: choose from the start picture as if keepOpen were
            // off.
            guard: ({ context, event }) => context.restoring && event.output.error === "not-found",
            target: "choosing",
            actions: assign({ restoreId: null, restoring: false, id: null }),
          },
          { guard: ({ event }) => event.output.error === "not-found", target: "blank" },
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    // The subject changed under a following editor that does not keep its note: fetch the notes
    // afresh and open the newest about the new subject, else the empty page. A keystroke
    // here is the user's answer, the same as at start.
    refollowing: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ context, event }) => pickId(event.output.notes, context.subject, context.subjecting) != null,
            target: "loading",
            actions: [takeKnown, assign({ id: ({ context, event }) => pickId(event.output.notes, context.subject, context.subjecting) })],
          },
          { target: "empty", actions: takeKnown },
        ],
        onError: "empty",
      },
      on: { _typed: mintAndType },
    },
    editing: {
      initial: "clean",
      states: {
        clean: {
          on: { _typed: { target: "dirty", actions: assignTyped } },
        },
        dirty: {
          on: {
            // Targetless so the `after` window is not restarted: keystrokes made
            // within it join the one save at its end rather than pushing it back,
            // which is what makes this a throttle, not a debounce (4.3, third rule).
            _typed: { actions: assignTyped },
            // The root's _blurred is not taken while this one is, so the keyboard leaving is
            // noted here too.
            _blurred: { target: "clean", actions: ["leave", assign({ focused: false })] },
          },
          after: {
            [THROTTLE_MS]: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
        },
      },
    },
    // notes holds no note with this id: the id is a name for a note not yet written
    // — a fresh one the list minted with its +, or a stale one — and typing here
    // creates it. A null base under an id notes does not hold upserts as version 1
    // (notes.applySave), so nothing here differs from an editor that just minted.
    blank: {
      always: prewrite,
      on: { _typed: { target: "editing.dirty", actions: assignTyped } },
    },
    failed: {},
  },
});
