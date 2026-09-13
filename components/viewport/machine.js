import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the viewport the page is
// previewed in. It stores the choice in localStorage and writes the one document
// attribute data-viewport on <html> (7.5); base.css reacts, so every page gets the
// preview with no per-component change. Everything with a side effect — the store,
// the DOM write — arrives through `input`, so the machine is a pure definition
// importable in Node.
const viewportFor = (stored) => (stored === "phone" ? "phone" : "desk");

export const machine = setup({}).createMachine({
  id: "viewport",
  meta: { kind: "fact", shape: "local-only", emits: ["viewport.changed"], owns: "the viewport the page is previewed in" },
  context: ({ input }) => ({
    viewport: viewportFor(input.stored),
    save: input.save,
    apply: input.apply,
  }),
  // Section 7.5: the document fact is written from the start, before Lit renders.
  // No emit on mount; a view takes its starting picture by query (4.3) and follows
  // viewport.changed after.
  entry: ({ context }) => context.apply(context.viewport),
  on: {
    // The gesture from viewport-switch, consumed as an event (4.3). Guarded so a
    // repeat or an unknown viewport writes, saves and announces nothing.
    "viewport.selected": {
      guard: ({ context, event }) =>
        event.viewport !== context.viewport && ["desk", "phone"].includes(event.viewport),
      actions: [
        assign({ viewport: ({ event }) => event.viewport }),
        ({ context }) => context.apply(context.viewport),
        ({ context }) => context.save(context.viewport),
        emit(({ context }) => ({ type: "viewport.changed", viewport: context.viewport })),
      ],
    },
    "read?": {
      actions: ({ context, event }) => event.reply({ viewport: context.viewport }),
    },
  },
});
