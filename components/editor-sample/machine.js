import { setup, assign, fromPromise } from "xstate";

// A view component (3.1) with no fact of its own: the text it shows is UI state and
// lives only in view.js. The actor decides one thing, whether Vim is on, from the
// `vimKeys` preference that `settings` owns: one query for the starting picture and
// settings.changed after (4.3, fourth rule). With no settings on the page the ask
// replies no-answerer and Vim stays off. The ask arrives through `input`, so the
// machine imports in Node.
export const machine = setup({
  actors: {
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "editor-sample",
  meta: {
    description:
      "A bare editor with everything the editor kit gives every editor: paragraphs, bullet, " +
      "numbered and checklist items, quotes, source links drawn as tags, web links, hashtags, " +
      "the \"#\" and \"[[\" pickers, marks at a line's end, and Vim " +
      "when the Vim keys setting is on. It is for trying the kit by hand and for the kit's " +
      "browser tests. The `text` attribute gives the text it starts with; what is typed lives " +
      "only in the page and is never saved, and a click on a source link does nothing. The " +
      "\"[[\" picker offers two sample notes, and a link to one shows its title. Which " +
      "hashtags are known and which lines show marks are set by a test, never by the user.",
    kind: "view",
    emits: [],
    attributes: ["text"],
    asks: ["settings: read"],
  },
  context: ({ input }) => ({ ask: input.ask, vimKeys: false }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }),
        },
        onError: { target: "ready" },
      },
    },
    ready: {},
  },
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
  },
});
