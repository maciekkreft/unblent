import { setup, assign } from "xstate";

// A container view (3.1, 6.4) for a list and the thing picked from it. It owns only
// its own UI state: which child is shown. The children arrive through `input`, read
// from the DOM by the view, so the machine stays a pure definition importable in Node.
// It emits nothing and asks nothing: a new kind of list adds only one consumed gesture.

// The item to show for a selection gesture: the last child whose `shows-on` names this
// event (6.4). The selection gestures are the closed set the container consumes:
// book.selected, note.selected, conversation.selected, highlights.selected and
// evaluator.selected.
const shownFor = (items, type) => {
  const matching = items.filter((item) => item.showsOn === type);
  return matching.length ? matching[matching.length - 1].name : null;
};

// A remembered or re-read `shown` is kept only while it still names an item; otherwise
// the list is shown, so a stored name from an item since removed loses nothing (3.1).
const kept = (items, shown) => (items.some((item) => item.name === shown) ? shown : null);

// A selection gesture: it shows the item that declares it. A container that is itself
// the item of an outer list-then-item also hears the gesture that brings it up (its own
// `shows-on`, `opensOn`): that pick names something new, a book say, so the container
// opens at its list rather than at an item picked under the previous one. 6.4: an event
// neither declares is not this container's business, so it stays unhandled and the trace
// records it honestly as ignored.
const select = [
  {
    guard: ({ context, event }) => context.items.some((item) => item.showsOn === event.type),
    actions: assign({ shown: ({ context, event }) => shownFor(context.items, event.type) }),
  },
  {
    guard: ({ context, event }) => context.opensOn === event.type,
    actions: assign({ shown: null }),
  },
];

// Whether the container draws its Back bar: only while it shows an item, and not while
// that item is a nested list-then-item showing an item of its own. The panel then has one
// Back bar, the inner one, so Back always goes one level up.
export const drawsBar = (shown, nestedShowsItem) => Boolean(shown) && !nestedShowsItem;

export const machine = setup({}).createMachine({
  id: "list-then-item",
  meta: {
    description:
      "A container for a list and the thing picked from it, shown in one panel. The first child " +
      "is the list, and each later child is an item whose `shows-on` names the selection " +
      "gesture that brings it up (`book.selected`, `note.selected`, `conversation.selected`, " +
      "`highlights.selected`, `evaluator.selected`); the item is shown under a Back bar naming the " +
      "list's `label`, and Back shows the list again; so does Escape pressed inside the item when " +
      "the item does not use it itself (an editor in Vim's insert mode leaves insert mode first). " +
      "When the shown child changes while the keyboard is inside the container, the keyboard " +
      "follows into the newly shown child; a pick made elsewhere never moves it. Which child is shown is kept on this " +
      "device under the container's id. It emits and asks nothing, so a new kind of list needs " +
      "only one more consumed gesture here. On a desk it is one tab, with its own `label`, " +
      "`side`, `height` and `shows-on`, and a page holds one per pair, each with its own `id` " +
      "(4.1). An item may itself be a list-then-item, so one panel can go two levels deep. " +
      "The panel shows one Back bar at a time, naming the level above, and the inner container " +
      "opens at its list each time it is brought up; a list may name itself after what it shows.",
    kind: "view", emits: [], asks: [], attributes: ["height"],
  },
  context: ({ input }) => ({
    list: input.list,
    items: input.items,
    shown: kept(input.items, input.shown),
    opensOn: input.opensOn ?? null,
  }),
  initial: "ready",
  states: {
    ready: {
      on: {
        "book.selected": select,
        "note.selected": select,
        "conversation.selected": select,
        "highlights.selected": select,
        "evaluator.selected": select,
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
