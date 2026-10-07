import { setup, assign } from "xstate";

// A container view (3.1, 6.4) for a list and the thing picked from it. It owns only
// its own UI state: which child is shown. The children arrive through `input`, read
// from the DOM by the view, so the machine stays a pure definition importable in Node.
// It emits nothing and asks nothing: a new kind of list adds only one consumed gesture.

// The item to show for a selection gesture: the last child whose `shows-on` names this
// event (6.4). The selection gestures are the closed set the container consumes:
// book.selected, note.selected, conversation.selected, highlights.selected and
// gauge.selected.
const shownFor = (items, type) => {
  const matching = items.filter((item) => item.showsOn === type);
  return matching.length ? matching[matching.length - 1].name : null;
};

// A remembered or re-read `shown` is kept only while it still names an item; otherwise
// the list is shown, so a stored name from an item since removed loses nothing (3.1).
const kept = (items, shown) => (items.some((item) => item.name === shown) ? shown : null);

const select = {
  // 6.4: an event no item declares is not this container's business, so the guard
  // leaves it unhandled and the trace records it honestly as ignored.
  guard: ({ context, event }) => context.items.some((item) => item.showsOn === event.type),
  actions: assign({ shown: ({ context, event }) => shownFor(context.items, event.type) }),
};

export const machine = setup({}).createMachine({
  id: "list-then-item",
  meta: { kind: "view", emits: [], asks: [], attributes: ["height"] },
  context: ({ input }) => ({
    list: input.list,
    items: input.items,
    shown: kept(input.items, input.shown),
  }),
  initial: "ready",
  states: {
    ready: {
      on: {
        "book.selected": select,
        "note.selected": select,
        "conversation.selected": select,
        "highlights.selected": select,
        "gauge.selected": select,
        // Leading underscore (7.2): a user gesture forwarded by the view, an internal
        // message the bus never routes.
        _back: { actions: assign({ shown: null }) },
        // The child list changed under the container (a composer swap, 3.6): re-read it,
        // keeping the shown child if it is still there.
        _children: {
          actions: assign(({ context, event }) => ({
            list: event.list,
            items: event.items,
            shown: kept(event.items, context.shown),
          })),
        },
      },
    },
  },
});
