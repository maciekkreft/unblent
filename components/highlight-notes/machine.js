import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The view component that composes the highlights of the book on the stage into one
// continuous document (8, kind 4; Decision 2): a quote line per highlight, the comment
// under it, each highlight one ordinary note record whose link to the book carries the
// place and the quote (Decision 1, 12). To the user the document is one note, the
// Highlights (13), however many records it is made of. It owns only UI state — the
// fragments it is showing, which are dirty, which are counting down to a discard — and
// points at `notes`, which owns the facts, `subject`, the thing on the stage it
// follows, and `settings`, whose "Vim keys" preference (12) the view turns on and off
// in place.
//
// It follows the subject the same way note-list does (3.5): it applies its
// `subject: read` starting picture on its own concern, never batched into the
// `notes: list`/`notes: read` replies, so a slow notes pull on reload cannot re-apply a
// stale null over a `subject.changed` that arrived first. Everything with a side effect
// — the queries — arrives through `input`, so this stays a pure definition importable
// in Node; the CodeMirror document it drives lives in view.js. It asks session: read and
// follows session.changed only for whether anyone is signed in.

// One save waits this long after the last keystroke, the whole page's edits at once (a
// throttle, not a debounce: a keystroke within the window joins the pending save rather
// than pushing it back, 4.3 third rule). The same shape as note-editor's editing.
const THROTTLE_MS = 200;

// A run of white space, including line breaks, shown as one space: a quote spanning
// two blocks reads as one line (Decision 2). The quote line is never edited, so this is
// display only; it is also what split reads back around.
const oneLine = (s) => s.replace(/\s+/gu, " ").trim();

// The highlights in reading order (Decision 2): by chapter, then the start block, then
// the start offset. A stable order so a re-render keeps every region in place.
export const ordered = (fragments) =>
  [...fragments].sort(
    (a, b) =>
      a.place.chapter - b.place.chapter ||
      a.place.start.block - b.place.start.block ||
      a.place.start.offset - b.place.start.offset,
  );

// The one document, and the line each quote sits on so a position maps back to its
// note. Per fragment: one quote line, then the comment's lines — always at least one,
// an empty line when the body is empty, so a quote line is never directly followed by
// the next quote line or the end (the invariant the view's transaction filter keeps).
export function compose(fragments) {
  const lines = [];
  const quotes = [];
  for (const f of fragments) {
    quotes.push({ id: f.id, line: lines.length });
    lines.push(oneLine(f.quote.exact));
    for (const line of (f.body ?? "").split("\n")) lines.push(line);
  }
  return { doc: lines.join("\n"), quotes };
}

// The inverse: each note's comment read back out of the document, the lines under its
// quote line up to the next quote (or the end), trailing empty lines trimmed. So
// split(compose(x)) returns the bodies of x (a body carries no trailing empty line of
// its own — the editor never keeps one, 12).
export function split(doc, quotes) {
  const lines = doc.split("\n");
  const bodies = {};
  quotes.forEach((q, i) => {
    const end = i + 1 < quotes.length ? quotes[i + 1].line : lines.length;
    const comment = lines.slice(q.line + 1, end);
    while (comment.length > 0 && comment[comment.length - 1] === "") comment.pop();
    bodies[q.id] = comment.join("\n");
  });
  return bodies;
}

// A highlight's title is its comment's first line that says anything (12): the Highlights
// page sets note.saved.title from it, so a list row and book-reader's hasComment, which
// carry no body, can tell a commented highlight from a bare one.
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : "";
}

// A note's links (12), always an array; an old cached note reads as none.
const links = (note) => (Array.isArray(note.about) ? note.about : []);

// The link that makes a note a highlight of the subject on the stage: kind and id equal
// (D4: compare kind + id, never learn what kinds exist) and a place (Decision 1). Null
// when the note is not this subject's highlight.
const highlightLink = (note, subject) =>
  subject != null && links(note).find((l) => l.kind === subject.kind && l.id === subject.id && l.place);

// The ids of the highlight notes among a list reply's rows (list carries about, so the
// place is there, but no body — the bodies are read next).
const wantedIds = (rows, subject) =>
  (Array.isArray(rows) ? rows : []).filter((n) => highlightLink(n, subject)).map((n) => n.id);

// One fragment from a whole note (a read reply or a note.changed, both carry the body,
// version and links, 4.3 third rule): its place and quote from the subject's link, its
// body the comment, sent set to what notes holds so a fresh fragment starts clean.
const fragmentOf = (note, subject) => {
  const link = highlightLink(note, subject);
  return link
    ? { id: note.id, place: link.place, quote: link.quote, body: note.body, version: note.version, sent: { body: note.body } }
    : null;
};

// Fold a note.changed into the fragments: drop one that is no longer this subject's
// highlight; add a new highlight; on the echo of our own save (same body as sent) only
// bump the version and refresh the place and quote; a newer body from elsewhere replaces
// the fragment (adopted even over a draft, 12), re-clean against it.
const foldChanged = (fragments, note, subject) => {
  const link = highlightLink(note, subject);
  const existing = fragments.find((f) => f.id === note.id);
  if (!link) return existing ? fragments.filter((f) => f.id !== note.id) : fragments;
  if (!existing) return [...fragments, fragmentOf(note, subject)];
  return fragments.map((f) => {
    if (f.id !== note.id) return f;
    if (f.sent && note.body === f.sent.body) return { ...f, version: note.version, place: link.place, quote: link.quote };
    return { id: note.id, place: link.place, quote: link.quote, body: note.body, version: note.version, sent: { body: note.body } };
  });
};

// Merge the read replies into the fragments, keeping any fragment a note.changed already
// added while the reads were in flight (its version is at least as fresh as the read's).
const mergeReads = (fragments, notes, subject) => {
  let frags = fragments;
  for (const note of notes) {
    const frag = fragmentOf(note, subject);
    if (frag && !frags.some((f) => f.id === frag.id)) frags = [...frags, frag];
  }
  return frags;
};

// A Set with one id removed, as a new Set so assign sees a fresh value.
const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

// The fragments with the given ids' bodies replaced by what the view reports (a
// document change reduced to one body per note by the view's split); others untouched.
const applyBodies = (fragments, bodies) =>
  fragments.map((f) => (bodies[f.id] !== undefined ? { ...f, body: bodies[f.id] } : f));

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the highlights.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the document shows of the account (14, signed out): "wait" until session answers,
// so neither the highlights nor the sign-in line flashes; "sign-in" signed out, since the
// panel keeps the Highlights in front across a reload and they are the account's; "show"
// otherwise. A try page (8) shows its visitor the document.
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

export const machine = setup({
  actors: {
    // The subject starting picture, asked as its own concern (3.5) so its reply — the
    // picture at read time — never overwrites a subject.changed that arrived first while
    // a slow notes pull was still loading. subject.changed is held for this ask until
    // its reply lands (subject: read supersededBy), so it is applied after, in order.
    readSubject: fromPromise(({ input }) => input.ask("subject", "read", {})),
    // Every note, to find which are highlights of the subject (list carries about but no
    // body). note.changed / note.deleted are held for this ask until the reply lands
    // (supersededBy), then followed after (4.3, fourth rule).
    load: fromPromise(({ input }) => input.ask("notes", "list", {})),
    // The bodies and versions of the wanted highlights. note.changed / note.deleted are
    // held for each read until its reply lands.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    readNotes: fromPromise(async ({ input }) => {
      const replies = await Promise.all(input.ids.map((id) => input.ask("notes", "read", { id })));
      return replies.filter((r) => r && "note" in r).map((r) => r.note);
    }),
  },
  actions: {
    // A subject is known: raise the internal rebuild so it runs after the assign that
    // set it, from the top-level subject read reply or a subject.changed alike.
    reload: enqueueActions(({ enqueue }) => enqueue.raise({ type: "_reload" })),
    // Send every dirty fragment's comment (Decision 2): one note.saved per changed body,
    // its title the comment's first line so a bare highlight and a commented one are
    // told apart, without about — the link and its place stay as the reader set them.
    // Mark each sent so its echo is recognised and a later pause on the same text saves
    // nothing.
    saveDirty: enqueueActions(({ context, enqueue }) => {
      const changed = context.fragments.filter((f) => !f.sent || f.body !== f.sent.body);
      for (const f of changed) {
        enqueue.emit({ type: "note.saved", id: f.id, title: titleOf(f.body), body: f.body, baseVersion: f.version });
      }
      if (changed.length > 0) {
        enqueue.assign({
          fragments: ({ context }) =>
            context.fragments.map((f) => (changed.some((c) => c.id === f.id) ? { ...f, sent: { body: f.body } } : f)),
        });
      }
    }),
  },
}).createMachine({
  id: "highlight-notes",
  meta: {
    description:
      "The highlights editor: it shows every highlight of the book on the stage as one " +
      "document, the Highlights, with a quote line per highlight in reading order and the " +
      "user's comment under it. The quote lines cannot be edited and the comments can; in a " +
      "comment Enter starts a new paragraph, drawn after a short gap, and Shift+Enter a new " +
      "line. All " +
      "changes on the page are saved together a short time after typing stops. Deleting a quote " +
      "line whole, or `dd` on it with Vim keys on, removes that highlight after the undo " +
      "window. With Vim keys on, p pastes text or a link copied in the reader with Vim keys, paragraphs kept. Each highlight is stored as its own note whose link to the book carries a place, " +
      "but the user sees and edits them only here, as one note. Signed out it shows only " +
      "\"Sign in to see your notes.\" and no highlight, also when it was in front before a " +
      "reload; the highlights stay kept in this browser and come back when the user signs in, " +
      "without a reload, and a removal still in its undo window when the user signs out is " +
      "taken back. On a try page a visitor not yet signed in still sees them.",
    kind: "view",
    emits: ["note.saved", "note.discarded"],
    attributes: ["height"],
    asks: ["notes: list", "notes: read", "subject: read", "settings: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Puts text copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    // How long a discarded highlight can be brought back (the --duration-undo token,
    // read in the view and passed in so the machine stays importable in Node). The
    // delete is not a fact until this window ends (delayed delete, as in note-list).
    undoMs: input.undoMs,
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    // The ids to read after a list reply is filtered to this subject's highlights.
    wanted: [],
    // One fragment per highlight of the subject: { id, place, quote, body, version, sent }.
    // Reset when the subject changes; kept current from note.changed and note.deleted.
    fragments: [],
    // The ids counting down to a discard, each with its own cancelable timer.
    discarding: new Set(),
    // The "Vim keys" device preference (12), owned by `settings`: off until it says
    // otherwise, and off on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
  }),
  // The subject read runs for the machine's whole life (3.5) so a rebuild never cancels
  // it: its reply lands on its own and sets the subject, and no notes reply ever writes
  // the subject. Each subject it learns starts a rebuild against the current notes.
  // The settings read runs beside it for the same reason: the preference arrives
  // whatever the document is doing, and a settings.changed that races it is held for us
  // until the reply lands (settings: read supersededBy).
  invoke: [
    {
      src: "readSubject",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: [assign({ subject: ({ event }) => event.output.subject ?? null }), "reload"] },
      onError: { actions: "reload" },
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
  ],
  initial: "idle",
  on: {
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, blocks a blank line apart as paragraphs are.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // Who is signed in now (4.3). Signing out hides the highlights and keeps them; a
    // removal the user can no longer see is taken back, so nothing goes without its Undo.
    "session.changed": [
      { guard: ({ event }) => event.userId != null, actions: assign({ signedIn: true }) },
      {
        actions: enqueueActions(({ context, enqueue }) => {
          for (const id of context.discarding) enqueue.cancel(`undo:${id}`);
          enqueue.assign({ signedIn: false, discarding: new Set() });
        }),
      },
    ],
    // The stage moved (4.3): a different subject, so a different set of highlights.
    // Held for us until the starting subject: read reply lands, so it is never lost and
    // never applied before the picture it supersedes. Start the set over against it.
    "subject.changed": { actions: [assign({ subject: ({ event }) => event.subject }), "reload"] },
    // A subject is known (from the read reply or a change): fetch the notes afresh and
    // rebuild the highlight set for it (start over). Raised, so it runs after the assign.
    _reload: { target: ".loading" },
    // The fact's news (4.3, fourth rule): add a new highlight, adopt a newer body, bump a
    // version on our own echo, or drop a note that is no longer this subject's highlight.
    "note.changed": {
      actions: assign({ fragments: ({ context, event }) => foldChanged(context.fragments, event, context.subject) }),
    },
    // The fact confirms a highlight is gone (this device's own discard on elapse, or
    // another device's): drop its fragment and clear any countdown still standing for it.
    "note.deleted": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          fragments: ({ context }) => context.fragments.filter((f) => f.id !== event.id),
          discarding: ({ context }) => without(context.discarding, event.id),
        });
        if (context.discarding.has(event.id)) enqueue.cancel(`undo:${event.id}`);
      }),
    },
    // The bin on a quote line (session 5): begin the undo window. Nothing is emitted yet;
    // only its elapse makes the delete a fact.
    _discard: {
      guard: ({ context, event }) =>
        showing(context) === "show" && context.fragments.some((f) => f.id === event.id) && !context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(event.id) });
        enqueue.raise({ type: "_elapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `undo:${event.id}` });
      }),
    },
    // Undo within the window: cancel it, emit nothing.
    _undo: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.cancel(`undo:${event.id}`);
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
      }),
    },
    // The window ran out: now the delete is a fact (note.discarded), which notes turns
    // into a tombstone and the note.deleted that drops the fragment.
    _elapsed: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
        enqueue.emit({ type: "note.discarded", id: event.id });
      }),
    },
  },
  states: {
    // Nothing is fetched until a subject is known (even null), so the list is not pulled
    // and filtered against a null subject only to be pulled again once the subject lands.
    idle: {},
    // Start the set over: drop the old subject's fragments, fetch every note, and keep
    // the ids of those that are this subject's highlights.
    loading: {
      entry: assign({ fragments: [] }),
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "reading",
          actions: assign({ wanted: ({ context, event }) => wantedIds(event.output.notes, context.subject) }),
        },
        onError: { target: "reading", actions: assign({ wanted: [] }) },
      },
    },
    // Read each wanted highlight for its body and version, then rest. A note.changed that
    // added a fragment meanwhile is kept (mergeReads).
    reading: {
      invoke: {
        src: "readNotes",
        input: ({ context }) => ({ ask: context.ask, ids: context.wanted }),
        onDone: {
          target: "ready",
          actions: assign({ fragments: ({ context, event }) => mergeReads(context.fragments, event.output, context.subject) }),
        },
        onError: "ready",
      },
    },
    // Showing the highlights. Typing under them drains at a throttle; blur saves at once.
    ready: {
      initial: "clean",
      states: {
        clean: {
          on: { _typed: { target: "dirty", actions: assign({ fragments: ({ context, event }) => applyBodies(context.fragments, event.bodies) }) } },
        },
        dirty: {
          on: {
            // Targetless so the window is not restarted: a keystroke within it joins the
            // one save rather than pushing it back (4.3, third rule).
            _typed: { actions: assign({ fragments: ({ context, event }) => applyBodies(context.fragments, event.bodies) }) },
            _blurred: { target: "clean", actions: "saveDirty" },
          },
          after: { [THROTTLE_MS]: { target: "clean", actions: "saveDirty" } },
        },
      },
    },
  },
});
