import { setup, assign, emit, fromCallback } from "xstate";

// A fact component (3.1): headless owner of the page's light-or-dark scheme.
// Everything environmental — the media query, the one DOM write — arrives through
// `input`, so the machine is a pure definition importable in Node.
const schemeFor = (matches) => (matches ? "dark" : "light");

export const machine = setup({
  actors: {
    // Bridges the media query into the mailbox. Its cleanup is media's own
    // unsubscribe, so stopping the actor stops listening.
    watchMedia: fromCallback(({ input, sendBack }) =>
      input.media.subscribe((matches) => sendBack({ type: "_mediaChanged", matches })),
    ),
  },
}).createMachine({
  id: "color-scheme",
  meta: { kind: "fact", shape: "local-only", emits: ["color-scheme.changed"], owns: "light or dark mode" },
  context: ({ input }) => ({
    scheme: schemeFor(input.media.matches),
    media: input.media,
    apply: input.apply,
  }),
  // Section 7.5: the document fact is written from the start, before any view
  // reads the stylesheet. No emit on mount; a view takes its starting picture
  // from the sheet and follows color-scheme.changed after.
  entry: ({ context }) => context.apply(context.scheme),
  invoke: { src: "watchMedia", input: ({ context }) => ({ media: context.media }) },
  on: {
    // Leading underscore (7.2): an internal message the bus never routes.
    _mediaChanged: {
      guard: ({ context, event }) => schemeFor(event.matches) !== context.scheme,
      actions: [
        assign({ scheme: ({ event }) => schemeFor(event.matches) }),
        ({ context }) => context.apply(context.scheme),
        emit(({ context }) => ({ type: "color-scheme.changed", scheme: context.scheme })),
      ],
    },
  },
});
