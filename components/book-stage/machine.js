import { setup, assign, fromPromise, enqueueActions } from "xstate";

// A container view (3.1, 6.4) for the stage of a page that reads books: it shows the
// right view for the open book and keeps one tab per book. It owns only UI state: which
// child is shown, and the tab list, which follows the device in localStorage (3.1) and
// loses nothing when lost. It points at `books`: it asks books: open, books: read and
// books: list for the starting picture and follows book.opened, book.changed and
// book.deleted after (4.3, fourth rule). The asks and the storage arrive through
// `input`, so the machine is importable in Node.

// Which child the view shows: "written" while the open book is the one the user writes,
// "reader" otherwise, also when no book is open or the open book cannot be read.
export const shownOf = (context) => (context.written ? "written" : "reader");

// The journal is the book with `written` set (books: list); every other book shows the
// title the user gave it.
const labelOf = (book) => (book.written === true ? "Journal" : book.title);

// The tab list as stored: ids in order. Anything unreadable starts empty, because the
// list is only a convenience.
const recall = (storage, key) => {
  try {
    const ids = JSON.parse(storage?.getItem(key) ?? "[]");
    return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === "string"))] : [];
  } catch {
    return [];
  }
};

const remember = (context) => {
  try {
    context.storage?.setItem(context.key, JSON.stringify(context.tabs));
  } catch {
    // A full or blocked storage keeps the tabs for this page load only.
  }
};

// The tab that takes the front when `id` leaves it: the nearest drawn tab on the right,
// else on the left, since a tab with no label yet is not drawn (tabsOf); only when none
// is drawn does a hidden one come forward.
const neighbourOf = (context, id) => {
  const { tabs, labels } = context;
  const at = tabs.indexOf(id);
  const drawn = (t) => t !== undefined && labels[t] !== undefined;
  const right = tabs.slice(at + 1).find(drawn);
  const left = tabs.slice(0, at).reverse().find(drawn);
  return right ?? left ?? tabs[at + 1] ?? tabs[at - 1] ?? null;
};

// How many tabs the desk draws: a tab with no label yet is left out (tabsOf).
const drawnCount = (context) => context.tabs.filter((id) => context.labels[id] !== undefined).length;

// What tabs.shown announces. A tab with no label yet (a book books has not listed) is
// left out until its label is known, so no tab is ever blank.
export const tabsOf = (context) => {
  const tabs = context.tabs.filter((id) => context.labels[id] !== undefined);
  return {
    view: context.address,
    tabs: tabs.map((id) => ({ id, label: context.labels[id], closable: tabs.length > 1 })),
    active: tabs.includes(context.front) ? context.front : null,
  };
};

// Announces the tabs once the labels are known (the list replied), and only when what
// the desk would draw changed, so a reading position saved on book.changed is silent.
const announce = (context, enqueue) => {
  if (!context.listed) return;
  const shown = tabsOf(context);
  const said = JSON.stringify(shown);
  if (said === context.said) return;
  enqueue.assign({ said });
  enqueue.emit({ type: "tabs.shown", ...shown });
};

// The one path every change to the list takes: store it, then announce it.
const settle = (context, enqueue, change) => {
  const next = { ...context, ...change };
  enqueue.assign(change);
  if (change.tabs) remember(next);
  announce(next, enqueue);
};

// Brings a tab's book to the front through `books`, which answers with book.opened. The
// front moves at once, so the tab is selected the moment it is picked.
const switchTo = (enqueue, id) => {
  enqueue.assign({ front: id });
  enqueue.emit({ type: "book.switched", id });
};

// Removes a tab the user closed. The last drawn tab stays, so the stage always shows a
// book the user can see, the same count that marks a tab closable (tabsOf).
const close = ({ context, event, enqueue }) => {
  const { id } = event;
  if (!context.tabs.includes(id) || drawnCount(context) < 2) return;
  const tabs = context.tabs.filter((t) => t !== id);
  if (context.front === id) switchTo(enqueue, neighbourOf(context, id));
  const front = context.front === id ? neighbourOf(context, id) : context.front;
  settle({ ...context, front }, enqueue, { tabs });
};

// Moves a tab one place in the order the desk draws: it trades places with the nearest
// labelled tab on that side, since an unlabelled one is not drawn (tabsOf). A move past
// either end does nothing, and the front tab stays in front.
const move = ({ context, event, enqueue }) => {
  const at = context.tabs.indexOf(event.id);
  if (at < 0 || context.labels[event.id] === undefined) return;
  let to = at + event.step;
  while (to >= 0 && to < context.tabs.length && context.labels[context.tabs[to]] === undefined) to += event.step;
  if (to < 0 || to >= context.tabs.length) return;
  const tabs = [...context.tabs];
  [tabs[at], tabs[to]] = [tabs[to], tabs[at]];
  settle(context, enqueue, { tabs });
};

const mine = ({ context, event }) => event.view === context.address;

const readInput = ({ context }) => ({ ask: context.ask, id: context.openId });

// A reply that names the open book settles the decision; anything else (not found, no
// answerer) leaves the reader shown, so a page without `books` still reads.
const fromReply = assign({ written: ({ event }) => event.output?.book?.written === true });

export const machine = setup({
  actors: {
    open: fromPromise(({ input }) => input.ask("books", "open", {})),
    read: fromPromise(({ input }) => input.ask("books", "read", { id: input.id })),
    list: fromPromise(({ input }) => input.ask("books", "list", {})),
  },
  guards: {
    hasBook: ({ context }) => context.openId != null,
  },
}).createMachine({
  id: "book-stage",
  meta: {
    description:
      "The stage of a page that reads books, with one tab per book. It holds two views: the " +
      "first shows an ordinary book (the book reader), the second the book the user writes (the " +
      "journal's page). It shows the second while the open book is written, and the first " +
      "otherwise, also when no book is open. Both views stay loaded behind it, so each keeps its " +
      "place, and when the shown view changes while the keyboard is on the stage the keyboard " +
      "moves into the newly shown one. The tabs are the books opened on this device, in the " +
      "order they were first opened, kept in the browser: opening a book adds its tab at the " +
      "end, or brings its tab to the front if it has one, and the tab in front is the open book. " +
      "Each tab shows the book's title, and the journal's says Journal. Picking a tab opens its " +
      "book. Closing a tab, by its × or by `:q`, removes it, and if it was in front the tab to " +
      "its right comes forward, or the one to its left if there is none; the last tab cannot be " +
      "closed. The desk's ‹ › move the tab in front one place earlier or later, and the new " +
      "order is kept like the rest; a move past either end does nothing. A deleted book's tab goes the same way, and a book the account no longer has " +
      "(after View as) loses its tab. It announces its tabs so the desk can draw them in place " +
      "of the stage's own tab.",
    kind: "view",
    emits: ["tabs.shown", "book.switched"],
    asks: ["books: open", "books: read", "books: list"],
    attributes: ["height"],
  },
  context: ({ input }) => {
    const key = input.address && input.address !== "book-stage" ? `book-stage.tabs${input.address.slice("book-stage".length)}` : "book-stage.tabs";
    return {
      ask: input.ask,
      address: input.address ?? "book-stage",
      storage: input.storage ?? null,
      key,
      openId: null,
      written: false,
      tabs: recall(input.storage, key),
      labels: {},
      front: null,
      listed: false,
      said: null,
    };
  },
  type: "parallel",
  states: {
    show: {
      initial: "opening",
      on: {
        // Another book opened, here or on another device (5): ask about it afresh, and give
        // it a tab at the end unless it has one.
        "book.opened": {
          target: ".deciding",
          actions: enqueueActions(({ context, event, enqueue }) => {
            const id = event.id ?? null;
            enqueue.assign({ openId: id });
            if (id == null) return settle(context, enqueue, { front: null });
            const tabs = context.tabs.includes(id) ? context.tabs : [...context.tabs, id];
            settle({ ...context, front: id }, enqueue, { front: id, tabs });
          }),
        },
      },
      states: {
        // The starting picture (4.3): which book is open. book.opened and book.deleted
        // that race it are held for us until the reply lands (books: open supersededBy).
        opening: {
          invoke: {
            src: "open",
            input: ({ context }) => ({ ask: context.ask }),
            onDone: {
              target: "deciding",
              actions: enqueueActions(({ context, event, enqueue }) => {
                const id = event.output?.id ?? null;
                enqueue.assign({ openId: id });
                if (id == null) return;
                const tabs = context.tabs.includes(id) ? context.tabs : [...context.tabs, id];
                settle({ ...context, front: id }, enqueue, { front: id, tabs });
              }),
            },
            onError: "ready",
          },
        },
        deciding: {
          always: [{ guard: "hasBook", target: "reading" }, { target: "ready", actions: assign({ written: false }) }],
        },
        // Whether the open book is written. The view shown so far stays until the reply,
        // so nothing flickers; book.changed and book.deleted for the book are held until then.
        reading: {
          invoke: {
            src: "read",
            input: readInput,
            onDone: { target: "ready", actions: fromReply },
            onError: { target: "ready", actions: assign({ written: false }) },
          },
        },
        ready: {},
      },
    },
    tabs: {
      initial: "listing",
      states: {
        // The labels, and which stored ids the account still has (books: list). A
        // book.changed or book.deleted that races it is held until the reply (4.2).
        listing: {
          invoke: {
            src: "list",
            input: ({ context }) => ({ ask: context.ask }),
            onDone: {
              target: "known",
              actions: enqueueActions(({ context, event, enqueue }) => {
                const books = event.output?.books;
                // No answer (no books on the page, offline) keeps the stored list as it is.
                if (!Array.isArray(books)) return;
                const labels = Object.fromEntries(books.map((b) => [b.id, labelOf(b)]));
                let tabs = context.tabs.filter((id) => labels[id] !== undefined);
                if (context.openId != null && labels[context.openId] !== undefined && !tabs.includes(context.openId)) tabs = [...tabs, context.openId];
                settle({ ...context, listed: true }, enqueue, { labels, tabs, listed: true });
              }),
            },
            onError: "known",
          },
        },
        known: {},
      },
    },
  },
  on: {
    "book.changed": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (event.id === context.openId) enqueue.assign({ written: event.written === true });
        const labels = { ...context.labels, [event.id]: labelOf(event) };
        if (labels[event.id] !== context.labels[event.id]) settle(context, enqueue, { labels });
      }),
    },
    "book.deleted": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        const { id } = event;
        if (id === context.openId) enqueue.assign({ openId: null, written: false });
        if (!context.tabs.includes(id)) return;
        const tabs = context.tabs.filter((t) => t !== id);
        const next = context.front === id ? neighbourOf(context, id) : context.front;
        if (context.front === id && next != null) switchTo(enqueue, next);
        settle({ ...context, front: next }, enqueue, { tabs });
      }),
    },
    // The desk's tab gestures name the view they belong to (4.1); another view's are not ours.
    "tab.picked": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (!mine({ context, event }) || !context.tabs.includes(event.id) || event.id === context.front) return;
        switchTo(enqueue, event.id);
        announce({ ...context, front: event.id }, enqueue);
      }),
    },
    "tab.closed": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (mine({ context, event })) close({ context, event, enqueue });
      }),
    },
    "tab.moved": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (mine({ context, event })) move({ context, event, enqueue });
      }),
    },
    "book.closed": { actions: enqueueActions(close) },
  },
});
