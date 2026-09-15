import { setup, assign, fromPromise, enqueueActions, emit } from "xstate";

// A member of the note-editor role (3.1, 7.3): the same editor concept — one text,
// its first line the title — with a CodeMirror 6 view (view.js) that renders three
// levels (Title/Heading/Subheading) like Notes.app and edits under Vim. The actor is
// note-editor's, so the members share one contract (7.3) and the composer (3.6) can
// swap one for the other. Only the view differs. Everything with a side effect
// arrives through input, so this stays a pure definition importable in Node — it
// imports no CodeMirror (that lives in view.js, the browser-only entry).

const THROTTLE_MS = 200;

// The wire form of a note is markdown: a line prefixed "# "/"## "/"### " is a
// Title/Heading/Subheading, an unprefixed line is Body. The CM6 document the user
// edits is marker-free (view.js), so parseBody/serialize are the one place the two
// representations meet; both are pure, so they and titleOf are tested in Node.
const PREFIX = { title: "# ", heading: "## ", subheading: "### ", body: "" };

// The note's title is its first line that says anything, with its level marker off so
// a list row and note.saved.title never show a "#".
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim().replace(/^#{1,3} /, "").trim() : "";
}

// markdown -> { doc: marker-free text, levels: one level per line }. An empty note
// seeds a single Title line: the first line's default (changeable), not a hardcoded
// level — loaded content is governed by its own markers, so a plain-editor note
// round-trips losslessly (a bare first line stays Body, never re-titled).
export function parseBody(md) {
  if (md === "") return { doc: "", levels: ["title"] };
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
// would pollute the one plain string the plain note-editor and note-list also read.
export function serialize(doc, levels) {
  if (doc === "") return ""; // a blank note is empty, never a lone "# " — so opening one never mints
  return doc
    .split("\n")
    .map((text, i) => (PREFIX[levels[i]] ?? "") + text)
    .join("\n");
}

const assignTyped = assign({ body: ({ event }) => event.body });

const mintAndType = {
  target: "editing.dirty",
  actions: enqueueActions(({ context, event, enqueue }) => {
    const id = context.mint();
    enqueue.assign({ id, body: event.body });
    enqueue.emit({ type: "note.opened", id });
  }),
};

export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("notes", "list", {})),
    read: fromPromise(({ input }) => input.ask("notes", "read", { id: input.id })),
  },
  guards: {
    unchanged: ({ context }) => context.sent != null && context.sent.body === context.body,
  },
  actions: {
    save: enqueueActions(({ context, enqueue }) => {
      enqueue.assign({ sent: { body: context.body } });
      enqueue.emit({
        type: "note.saved",
        id: context.id,
        title: titleOf(context.body),
        body: context.body,
        baseVersion: context.baseVersion,
      });
    }),
  },
}).createMachine({
  id: "note-editor-cm6",
  meta: {
    kind: "view",
    role: "note-editor",
    emits: ["note.saved", "note.opened"],
    attributes: ["height", "follows"],
    asks: ["notes: list", "notes: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    focus: input.focus,
    follows: input.follows,
    id: null,
    body: "",
    baseVersion: null,
    sent: null,
  }),
  initial: "starting",
  on: {
    load: {
      target: ".loading",
      actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null }),
    },
    "note.selected": {
      guard: ({ context }) => context.follows,
      target: ".loading",
      actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null }),
    },
    focus: { actions: ({ context }) => context.focus() },
    "note.deleted": {
      guard: ({ context, event }) => event.id === context.id,
      target: ".empty",
      actions: assign({ id: null, body: "", baseVersion: null, sent: null }),
    },
    "note.changed": [
      {
        guard: ({ context, event }) =>
          event.id === context.id && context.sent != null && event.body === context.sent.body,
        actions: assign({ baseVersion: ({ event }) => event.version }),
      },
      {
        guard: ({ context, event }) =>
          event.id === context.id && (context.baseVersion === null || event.version > context.baseVersion),
        target: ".editing.clean",
        actions: assign({
          body: ({ event }) => event.body,
          baseVersion: ({ event }) => event.version,
          sent: ({ event }) => ({ body: event.body }),
        }),
      },
    ],
  },
  states: {
    starting: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => event.output.notes?.length > 0,
            target: "loading",
            actions: assign({ id: ({ event }) => event.output.notes[0].id }),
          },
          { target: "empty" },
        ],
        onError: "empty",
      },
      on: { _typed: mintAndType },
    },
    empty: {
      on: { _typed: mintAndType },
    },
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
            }),
          },
          { guard: ({ event }) => event.output.error === "not-found", target: "blank" },
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    editing: {
      initial: "clean",
      states: {
        clean: {
          on: { _typed: { target: "dirty", actions: assignTyped } },
        },
        dirty: {
          on: {
            _typed: { actions: assignTyped },
            _blurred: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
          after: {
            [THROTTLE_MS]: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
        },
      },
    },
    blank: {
      on: { _typed: { target: "editing.dirty", actions: assignTyped } },
    },
    failed: {},
  },
});
