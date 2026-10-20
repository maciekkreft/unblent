import { setup, assign, fromPromise, fromCallback, enqueueActions, emit, spawnChild, stopChild } from "xstate";

// The view component for editing one note (3.1): owns only its own UI state — the
// draft, which state it is in, whether it is pinned — and points at `notes`, which
// owns the fact, and at `subject`, which owns what is on the stage. On start it asks
// notes: list and reopens a note, or takes a note by the load command or, when it
// carries `follows`, by note.selected from the list (both ask notes: read); it follows
// note.changed after (4.3), and emits note.saved at a short throttle while the user
// types, and on blur. With the `subject` attribute it follows the stage (12): it opens
// the newest note about the subject, re-follows when the subject changes, and a pin
// stops the re-following, so a change on the stage never moves the note on screen; a
// pick by the user always opens. It announces the note
// it shows with note.opened whenever its id changes (6.4). The view (view.js) is a
// CodeMirror 6 document with three levels (Title/Heading/Subheading) like Notes.app,
// and Vim when the "Vim keys" preference is on (12). A note is markdown on the wire and
// marker-free in the view; parseBody/serialize are the one place the two forms meet,
// and both are pure, so they and titleOf are tested in Node. Everything with a side
// effect — the queries, minting an id, focusing the input, the pin store — arrives
// through input, so this stays a pure definition importable in Node; it imports no
// CodeMirror (that lives in view.js, the browser-only entry).

const THROTTLE_MS = 200;

// The wire form of a note is markdown: a line prefixed "# "/"## "/"### " is a
// Title/Heading/Subheading, an unprefixed line is Body. The CM6 document the user
// edits is marker-free (view.js), so parseBody/serialize are the one place the two
// representations meet; both are pure, so they and titleOf are tested in Node.
const PREFIX = { title: "# ", heading: "## ", subheading: "### ", body: "" };

// The note's title is its first line that says anything, with its level marker or its
// bullet off so a list row and note.saved.title never show a "#" or a "- ".
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim().replace(/^#{1,3} /, "").replace(/^[-*] /, "").trim() : "";
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

// Which note to open from a list reply (D7): the newest note about the subject that is
// not a highlight of it (the reply is newest first), or — for an editor that does not
// follow the stage — the newest note overall. Null when there is none, so the editor
// lands on the empty page. A following editor with nothing on the stage opens none: the
// note it opens is pinned (`pins` starts every pin on), and the subject is often not
// known yet at a reload, so a note chosen then would stay open in place of the subject's.
const pickId = (notes, subject, subjecting) => {
  const list = Array.isArray(notes) ? notes : [];
  if (subject == null) return subjecting ? null : list[0]?.id ?? null;
  return list.find((n) => isAbout(n, subject) && !isHighlight(n, subject))?.id ?? null;
};

// Two subjects name the same thing when their kind and id match (title aside); both
// null is the same nothing. A title-only change keeps the note on screen (D7).
const sameThing = (a, b) => (a == null && b == null) || Boolean(a && b && a.kind === b.kind && a.id === b.id);

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
// a note may still arrive (starting, loading), so a pinned note's line does not show
// the stage's book first. Pure, so it is tested in Node and the view only renders it.
export function aboutTitleOf(snapshot) {
  const { about, titles, subjecting, subject, baseVersion } = snapshot.context;
  const link = about?.[0];
  if (link) return titles?.[`${link.kind}:${link.id}`] ?? null;
  if (!subjecting || baseVersion !== null) return null;
  const fresh = ["empty", "blank", "refollowing", "editing"].some((state) => snapshot.matches(state));
  return fresh ? subject?.title ?? null : null;
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

const assignTyped = assign({ body: ({ event }) => event.body });

// A first keystroke into an editor holding no note mints its id (a ULID, the
// browser's own, 5) and starts editing it. The id changed, so the note it now shows
// is announced (note.opened), the same as a load or a reopen does on entering
// `loading`.
const mintAndType = {
  target: "editing.dirty",
  actions: enqueueActions(({ context, event, enqueue }) => {
    const id = context.mint();
    enqueue.assign({ id, body: event.body });
    enqueue.emit({ type: "note.opened", id });
  }),
};

// note.saved from the current draft. A new note (baseVersion null) written while
// following the stage carries one link to the subject (D7, D2): about is on it only
// then, so every other save leaves the note's links as they are.
const savedEvent = (context) => {
  const event = {
    type: "note.saved",
    id: context.id,
    title: titleOf(context.body),
    body: context.body,
    baseVersion: context.baseVersion,
  };
  if (context.subjecting && context.baseVersion === null) {
    event.about = context.subject ? [{ kind: context.subject.kind, id: context.subject.id }] : [];
  }
  return event;
};

// Is there an unsaved change to send? A note with an id whose text differs from what
// notes last acknowledged (loaded, adopted, or our own last save).
const dirty = (context) =>
  context.id != null && (context.sent == null ? context.body !== "" : context.body !== context.sent.body);

export const machine = setup({
  actors: {
    // The starting picture (4.3): every note, and — only while following the stage —
    // the current subject. subject.changed that races the read is held for us until the
    // reply lands (subject: read supersededBy), so a change is applied after it, in order.
    // The pin too, from `pins`, while following: pins.changed is held for us until that
    // reply lands (pins: read supersededBy).
    start: fromPromise(async ({ input }) => {
      const [list, subject, pins] = await Promise.all([
        input.ask("notes", "list", {}),
        input.subjecting ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null }),
        input.subjecting ? input.ask("pins", "read", {}) : Promise.resolve({}),
      ]);
      return { notes: list?.notes ?? [], subject: subject?.subject ?? null, pin: typeof pins?.note === "string" ? pins.note : null };
    }),
    list: fromPromise(({ input }) => input.ask("notes", "list", {})),
    read: fromPromise(({ input }) => input.ask("notes", "read", { id: input.id })),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Following a source link asks notes for the highlight beside whatever the editor is
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
    // A remembered pin (D10): a note to reopen and start pinned, skipping the subject
    // choice.
    hasPin: ({ context }) => context.restoreId != null,
    // A keystroke landed while the start was still waiting for the subject.
    typedAhead: ({ context }) => context.id != null,
  },
  actions: {
    save: enqueueActions(({ context, enqueue }) => {
      // What was sent, so the echo of this save (a note.changed carrying it back)
      // is told apart from a real change from elsewhere, and a later pause that
      // ends on the same text saves nothing.
      enqueue.assign({ sent: { body: context.body } });
      enqueue.emit(savedEvent(context));
    }),
    // Save only if there is something to send: used before following a subject change,
    // where the draft may already be clean.
    saveIfDirty: enqueueActions(({ context, enqueue }) => {
      if (!dirty(context)) return;
      enqueue.assign({ sent: { body: context.body } });
      enqueue.emit(savedEvent(context));
    }),
    // Take the subject the stage holds, from the start reply or from subject.changed, and
    // keep its title in the browser (3.1) so the About line can name a pinned note's
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
    // A pick opens its note even while pinned: the pin belongs to the editor, not to one
    // note, so it moves to the note picked and survives a reload there.
    open: enqueueActions(({ context, event, enqueue }) => {
      enqueue.assign({ id: event.id, body: "", baseVersion: null, sent: null, about: [] });
      if (context.pinned) enqueue.emit({ type: "pin.toggled", what: "note", id: event.id });
    }),
    // The pin the start found: `pins` holds it, or else the note this editor kept under
    // its own key before `pins` existed, which is handed to `pins` once and forgotten
    // here. A pins.changed that arrived first is newer than the reply and wins.
    takeStartPin: enqueueActions(({ context, event, enqueue }) => {
      const legacy = context.legacyPin;
      if (legacy != null) enqueue(() => context.forget?.());
      if (context.pinsObserved) return;
      if (event.output.pin != null) enqueue.assign({ restoreId: event.output.pin });
      else if (legacy != null) {
        enqueue.assign({ restoreId: legacy });
        enqueue.emit({ type: "pin.toggled", what: "note", id: legacy });
      }
    }),
  },
}).createMachine({
  id: "note-editor",
  meta: {
    description:
      "Edits one note as a single page whose lines have four levels, Title, Heading, Subheading " +
      "and Body, set from four buttons at the bottom that mark the level of the line under the " +
      "cursor, flash when a level changes, and show their Vim keys while Vim keys is on. It " +
      "saves a short time into typing and when the editor loses focus. With `subject` it opens " +
      "the most recently edited note about the subject whenever the subject changes, or an " +
      "empty page that a note about the subject arriving later fills; a new note is linked to " +
      "the subject at its first save, the About line shows that link, and a keystroke made " +
      "before the subject is known waits for it. The pin is on unless the user turns it off, and " +
      "while it is on the editor stays on its note when the subject changes; picking another " +
      "note still opens it and the pin stays on, now on that note; turned off, the editor " +
      "follows the subject. The pin is kept by `pins` and the titles of subjects seen on this device, so " +
      "both survive a reload. It announces the note it shows, or none for the " +
      "empty page, so the list and `notes` know which note is open; a highlight is never opened " +
      "here. A source link to a highlight, pasted from the reader's Copy link (or with p after " +
      "the reader's y while Vim keys is on), is drawn as one tag, the link icon and the start of " +
      "the quote, that the cursor steps over and Backspace or x removes whole; a click on it, " +
      "or Enter on it in Vim's normal mode, opens the book at the passage, and a tag whose " +
      "highlight is gone turns grey and struck through and opens nothing.",
    kind: "view",
    emits: ["note.saved", "note.opened", "pin.toggled", "passage.selected", "note.staged", "note.closed"],
    attributes: ["height", "follows", "subject"],
    asks: ["notes: list", "notes: read", "subject: read", "settings: read", "pins: read"],
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
    // it, re-follow on a change, and offer the pin. Off is exactly today's behaviour.
    subjecting: Boolean(input.subjecting),
    // The note pinned under this editor's own key before `pins` owned the pin, read
    // through input so the machine stays importable in Node; `forget` clears that key.
    forget: input.forget,
    legacyPin: input.subjecting ? input.recall?.() ?? null : null,
    // The pinned note to reopen at start, from `pins` (D10).
    restoreId: null,
    // Whether pins.changed arrived before the start reply, which is then the older picture.
    pinsObserved: false,
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
    // rememberTitles, like the pin.
    rememberTitles: input.rememberTitles,
    titles: (input.subjecting ? input.recallTitles?.() : null) ?? {},
    // The "Vim keys" device preference (12), owned by `settings`: off until it says
    // otherwise, and off on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // Whether the note on screen is pinned (D7): UI state, remembered across reloads.
    pinned: false,
    // Puts a copied source link in Vim's unnamed register, so p pastes it (link.copied).
    pushRegister: input.pushRegister,
    // Source links whose highlight is gone (UI state): their tags are drawn removed.
    removed: [],
    // Whether a pin restore is in flight, so a successful load starts pinned and a
    // not-found one forgets the pin (D10).
    restoring: false,
    // The notes fetched at start, kept so a forgotten pin can choose from the same
    // picture without a second query.
    startNotes: [],
  }),
  initial: "starting",
  // Beside the states, so the preference arrives whatever the editor is doing and a
  // keystroke never waits for it. settings.changed that races it is held for us until
  // the reply lands (settings: read supersededBy).
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
  },
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // A command addressing this instance (4.4).
    load: { target: ".loading", actions: "open" },
    // The list's gesture (4.3, fifth rule), taken only when this editor follows the
    // selection. An unfollowing editor leaves it to the bus to record as ignored.
    "note.selected": { guard: ({ context }) => context.follows, target: ".loading", actions: "open" },
    focus: { actions: ({ context }) => context.focus() },
    // The reader copied a link to a highlight: Vim's p reads Vim's own register, not the
    // system clipboard, so the link goes there too.
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    // A click on a source link, or Enter on it in Vim's normal mode: ask notes for the
    // highlight. A second follow replaces one still waiting.
    _follow: {
      actions: [
        stopChild("follow"),
        spawnChild("follow", { id: "follow", input: ({ context, event }) => ({ ask: context.ask, id: event.id }) }),
      ],
    },
    // The highlight's reply: the passage opens (passage.selected), or the highlight is
    // gone and its tag is drawn removed.
    _followed: [
      {
        guard: ({ event }) => passageOf(event.reply, event.id) != null,
        actions: [
          assign({ removed: ({ context, event }) => context.removed.filter((id) => id !== event.id) }),
          emit(({ event }) => ({ type: "passage.selected", ...passageOf(event.reply, event.id) })),
        ],
      },
      {
        guard: ({ event }) => event.reply?.error === "not-found",
        actions: assign({
          removed: ({ context, event }) => (context.removed.includes(event.id) ? context.removed : [...context.removed, event.id]),
        }),
      },
    ],
    // The user pinned or unpinned (D7): the gesture goes to `pins` (4.3, fifth rule); the
    // button turns at once and pins.changed confirms it. Guarded so the button does
    // nothing while the editor holds no note.
    _togglePin: {
      guard: ({ context }) => context.subjecting && context.id != null,
      actions: [
        assign({ pinned: ({ context }) => !context.pinned }),
        emit(({ context }) => ({ type: "pin.toggled", what: "note", id: context.pinned ? context.id : null })),
      ],
    },
    // `pins`' news (4.3, fourth rule): the editor is pinned while `pins` holds its note.
    "pins.changed": {
      guard: ({ context }) => context.subjecting,
      actions: assign({ pinned: ({ context, event }) => event.note != null && event.note === context.id, pinsObserved: true }),
    },
    // The stage moved (4.3): a different subject is on it. Held for us until the starting
    // subject: read reply lands (subject: read supersededBy), so it is never lost and
    // never applied before the picture it supersedes. Ignored when not following.
    "subject.changed": [
      {
        // Pinned (or a remembered pin's note still loading), or the same thing with a
        // new title only: take the subject and its title but keep the note on screen (D7).
        guard: ({ context, event }) =>
          context.subjecting && (context.pinned || context.restoring || sameThing(context.subject, event.subject)),
        actions: "takeSubject",
      },
      {
        // A different thing on the stage, not pinned: save a dirty draft (its links are
        // the old subject's, still in context here), take the new subject, and re-follow.
        guard: ({ context }) => context.subjecting,
        target: ".refollowing",
        actions: [
          "saveIfDirty",
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
    ],
    // The fact's news that the open note is gone (4.3, fourth rule): fall back to the
    // empty page, where a keystroke starts a fresh note. `pins` lets go of the note when
    // the empty page is announced; pin.toggled is the user's press alone, so it is not
    // sent here. A deletion of another note is left to the bus to record as ignored.
    "note.deleted": {
      guard: ({ context, event }) => event.id === context.id,
      target: ".empty",
      actions: assign({ id: null, body: "", baseVersion: null, sent: null, about: [], pinned: false }),
    },
    // The fact's news (4.3, fourth rule). Guarded so a change for another id is left
    // to the bus to record as ignored.
    "note.changed": [
      {
        // The echo of this editor's own save: bump baseVersion, take the links notes
        // now holds, and stay in the current state so a keystroke made since is not lost.
        guard: ({ context, event }) =>
          event.id === context.id && context.sent != null && event.body === context.sent.body,
        actions: assign({ baseVersion: ({ event }) => event.version, about: ({ event }) => links(event.about) }),
      },
      {
        // A newer change from elsewhere: adopt it (the user's decision, 12), even
        // over a dirty draft. A first note.changed (baseVersion null) counts.
        guard: ({ context, event }) =>
          event.id === context.id && (context.baseVersion === null || event.version > context.baseVersion),
        target: ".editing.clean",
        actions: assign({
          body: ({ event }) => event.body,
          baseVersion: ({ event }) => event.version,
          sent: ({ event }) => ({ body: event.body }),
          about: ({ event }) => links(event.about),
        }),
      },
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
          { guard: "typedAhead", target: "editing.dirty", actions: "takeStartSubject" },
          {
            target: "choosing",
            actions: ["takeStartSubject", "takeStartPin", assign({ startNotes: ({ event }) => event.output.notes })],
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
                enqueue.emit({ type: "note.opened", id });
              }
              enqueue.assign({ body: event.body });
            }),
          },
          mintAndType,
        ],
        // The stage moved before the notes arrived: take the subject and stay, so
        // `choosing` still runs — a remembered pin is restored, and the note chosen is
        // about the subject now on the stage. Tried before the root handler, which
        // would re-follow and skip the choice.
        "subject.changed": { guard: ({ context }) => context.subjecting, actions: "takeSubject" },
        // A pin set or cleared before the notes arrived: the choice below honours it.
        "pins.changed": {
          guard: ({ context }) => context.subjecting,
          actions: assign({ restoreId: ({ event }) => event.note ?? null, pinsObserved: true }),
        },
      },
    },
    // The start replies are in: a remembered pin reopens its note (D10), else the newest
    // note about the subject, else the empty page. A synchronous choice, so a keystroke
    // never lands here.
    choosing: {
      always: [
        {
          guard: "hasPin",
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
      entry: emit({ type: "note.opened", id: null }),
      on: {
        _typed: mintAndType,
        // A note about the subject arrived after the choice was made (12): from the
        // load's pull, or another device. Nothing is typed here yet, so choose again.
        "note.changed": {
          guard: ({ context, event }) =>
            context.subjecting && isAbout(event, context.subject) && !isHighlight(event, context.subject),
          target: "refollowing",
        },
      },
    },
    // A load command, a follow of the list's selection, the start, or a re-follow asked
    // notes for the note; the reply decides where we land. Entering here the id has just
    // changed, so the note now shown is announced once (note.opened).
    loading: {
      entry: emit(({ context }) => ({ type: "note.opened", id: context.id })),
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.id }),
        onDone: [
          {
            guard: ({ event }) => "note" in event.output,
            target: "editing.clean",
            actions: assign({
              body: ({ event }) => event.output.note.body,
              baseVersion: ({ event }) => event.output.note.version,
              sent: ({ event }) => ({ body: event.output.note.body }),
              about: ({ event }) => links(event.output.note.about),
              // A pin restore that found its note starts pinned (D10).
              pinned: ({ context }) => context.restoring || context.pinned,
              restoring: false,
            }),
          },
          {
            // A remembered pin whose note is gone (D10): choose from the start picture as
            // an unpinned editor would; `pins` takes the note that choice announces.
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
    // The subject changed under a following, unpinned editor (D7): fetch the notes
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
            actions: assign({ id: ({ context, event }) => pickId(event.output.notes, context.subject, context.subjecting) }),
          },
          { target: "empty" },
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
            _blurred: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
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
      on: { _typed: { target: "editing.dirty", actions: assignTyped } },
    },
    failed: {},
  },
});
