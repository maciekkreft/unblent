import { setup, assign, fromPromise, enqueueActions } from "xstate";

// A container view (3.1, 6.4) for the stage of a page that reads books: it shows the
// right view for the open book and keeps one tab per book. It owns only UI state: which
// child is shown, and the tab list, which follows the device in localStorage (3.1) and
// loses nothing when lost. It points at `books`: it asks books: open, books: read and
// books: list for the starting picture and follows book.opened, book.changed and
// book.deleted after (4.3, fourth rule). It also keeps a tab per note the user opened on
// the stage (note.staged), labelled from notes: list and note.changed, and tells the
// stage's note editor which note to show by the load command (4.4). It asks session: read
// and follows session.changed only for whether anyone is signed in. The asks, the send,
// the storage and whether the page is a try page arrive through `input`, so the machine
// is importable in Node.

// Which child the view shows: "note" while a note's tab is in front, else "written" while
// the open book is the one the user writes, "reader" otherwise, also when no book is open
// or the open book cannot be read.
export const shownOf = (context) =>
  context.notes.includes(context.front) ? "note" : context.written ? "written" : "reader";

// The address of the editor that shows a note tab: the page gives it the id "stage" (4.1).
const STAGE_EDITOR = "note-editor#stage";

// A note's tab says its title, or Untitled while it has none.
const noteLabel = (title) => (title === "" ? "Untitled" : title);

// A tab's label, or undefined while it is not known yet, so the tab is not drawn.
const labelFor = (context, id) =>
  context.notes.includes(id) ? (id in context.titles ? noteLabel(context.titles[id]) : undefined) : context.labels[id];

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

// The order of every tab stays in the one list under `key`, and which of them are notes in
// a second list beside it, so a list stored before notes had tabs still reads as books.
const remember = (context) => {
  try {
    context.storage?.setItem(context.key, JSON.stringify(context.tabs));
    context.storage?.setItem(`${context.key}.notes`, JSON.stringify(context.notes));
  } catch {
    // A full or blocked storage keeps the tabs for this page load only.
  }
};

// The tab that takes the front when `id` leaves it: the nearest drawn tab on the right,
// else on the left, since a tab with no label yet is not drawn (tabsOf); only when none
// is drawn does a hidden one come forward.
const neighbourOf = (context, id) => {
  const { tabs } = context;
  const at = tabs.indexOf(id);
  const drawn = (t) => t !== undefined && labelFor(context, t) !== undefined;
  const right = tabs.slice(at + 1).find(drawn);
  const left = tabs.slice(0, at).reverse().find(drawn);
  return right ?? left ?? tabs[at + 1] ?? tabs[at - 1] ?? null;
};

// How many tabs the desk draws: a tab with no label yet is left out (tabsOf).
const drawnCount = (context) => context.tabs.filter((id) => labelFor(context, id) !== undefined).length;

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the stage.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the stage shows of the account (14, signed out): "wait" until session answers, so
// neither the tabs nor the sign-in line flashes; "sign-in" signed out, since the books and
// notes behind the tabs are the account's; "show" otherwise. A try page (8) shows the stage
// to a visitor who is not yet a guest.
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

// What tabs.shown announces. A tab with no label yet (a book books has not listed) is
// left out until its label is known, so no tab is ever blank.
export const tabsOf = (context) => {
  const tabs = context.tabs.filter((id) => labelFor(context, id) !== undefined);
  return {
    view: context.address,
    tabs: tabs.map((id) => ({ id, label: labelFor(context, id), closable: tabs.length > 1 })),
    active: tabs.includes(context.front) ? context.front : null,
  };
};

// Announces the tabs once the labels are known (the list replied), and only when what
// the desk would draw changed, so a reading position saved on book.changed is silent.
// Returns the context as it now stands, so several changes in one step can follow each other.
// Signed out the desk draws none of the account's tabs, only the stage's own; the tabs stay
// stored and are drawn again when the user signs in.
const announce = (context, enqueue) => {
  const account = showing(context);
  if (!context.listed || account === "wait") return context;
  const shown = account === "show" ? tabsOf(context) : { view: context.address, tabs: [], active: null };
  const said = JSON.stringify(shown);
  if (said === context.said) return context;
  enqueue.assign({ said });
  enqueue.emit({ type: "tabs.shown", ...shown });
  return { ...context, said };
};

// The one path every change to the list takes: store it, then announce it.
const settle = (context, enqueue, change) => {
  const next = { ...context, ...change };
  enqueue.assign(change);
  if (change.tabs || change.notes) remember(next);
  return announce(next, enqueue);
};

// Brings a tab's book to the front through `books`, which answers with book.opened. The
// front moves at once, so the tab is selected the moment it is picked.
const switchTo = (enqueue, id) => {
  enqueue.assign({ front: id });
  enqueue.emit({ type: "book.switched", id });
};

// Brings any tab to the front. A note's tab tells the stage's editor which note to show;
// it never touches `books`, so the open book, and with it the subject, stays. The open
// book's own tab needs no book.switched, since `books` already holds it open.
const bringForward = (context, enqueue, id) => {
  if (id != null && context.notes.includes(id)) {
    enqueue.assign({ front: id });
    enqueue(() => context.send?.(STAGE_EDITOR, "load", { id }));
  } else if (id == null || id === context.openId) enqueue.assign({ front: id });
  else switchTo(enqueue, id);
};

// Removes a tab whatever took it away (a close, a deletion, a list that lacks it); the
// tab beside it comes forward if it was in front.
const drop = (context, enqueue, id) => {
  const tabs = context.tabs.filter((t) => t !== id);
  const notes = context.notes.filter((t) => t !== id);
  const front = context.front === id ? neighbourOf(context, id) : context.front;
  if (context.front === id) bringForward(context, enqueue, front);
  return settle({ ...context, front }, enqueue, { tabs, notes });
};

// Removes a tab the user closed. The last drawn tab stays, so the stage always shows a
// book the user can see, the same count that marks a tab closable (tabsOf).
const close = ({ context, event, enqueue }) => {
  const { id } = event;
  if (!context.tabs.includes(id) || drawnCount(context) < 2) return;
  drop(context, enqueue, id);
};

// Moves a tab one place in the order the desk draws: it trades places with the nearest
// labelled tab on that side, since an unlabelled one is not drawn (tabsOf). A move past
// either end does nothing, and the front tab stays in front.
const move = ({ context, event, enqueue }) => {
  const at = context.tabs.indexOf(event.id);
  if (at < 0 || labelFor(context, event.id) === undefined) return;
  let to = at + event.step;
  while (to >= 0 && to < context.tabs.length && labelFor(context, context.tabs[to]) === undefined) to += event.step;
  if (to < 0 || to >= context.tabs.length) return;
  const tabs = [...context.tabs];
  [tabs[at], tabs[to]] = [tabs[to], tabs[at]];
  settle(context, enqueue, { tabs });
};

// Who is signed in changed: the desk draws the account's tabs again, or none of them.
const signIn = (context, enqueue, now) => {
  if (now === context.signedIn) return;
  enqueue.assign({ signedIn: now });
  announce({ ...context, signedIn: now }, enqueue);
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
    noteList: fromPromise(({ input }) => input.ask("notes", "list", {})),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
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
      "(after View as) loses its tab. A note opened on the stage (`note.staged`, the Notes " +
      "panel's Open on stage) gets a tab of its own at the end, or its tab comes to the front; " +
      "while a note's tab is in front the stage shows a third view, the note editor with id " +
      "`stage`, which it tells which note to show. A note's tab says the note's title, or " +
      "Untitled; picking it never opens a book, so the open book, and what the panels follow, " +
      "stays. Picking a book's tab, or a book opened anywhere, brings the book back to the " +
      "front. A note's tab closes like a book's, also by `:q` or `:tabc` in its editor, and the " +
      "note itself is unchanged; a deleted note, or one the account does not have, loses its " +
      "tab. Note tabs are kept in the browser beside the book tabs, and after a reload the open " +
      "book is in front. It announces its tabs so the desk can draw them in place of the " +
      "stage's own tab. Signed out it shows only \"Sign in to read.\": no tabs, no book, no " +
      "journal page and no note. The tabs stay kept in the browser, and signing in, with or " +
      "without a reload, brings back the same tabs with the same one in front. On a try page " +
      "a visitor not yet signed in still sees the stage.",
    kind: "view",
    emits: ["tabs.shown", "book.switched"],
    asks: ["books: open", "books: read", "books: list", "notes: list", "session: read"],
    sends: ["note-editor: load"],
    attributes: ["height"],
  },
  context: ({ input }) => {
    const key = input.address && input.address !== "book-stage" ? `book-stage.tabs${input.address.slice("book-stage".length)}` : "book-stage.tabs";
    const tabs = recall(input.storage, key);
    return {
      ask: input.ask,
      send: input.send,
      address: input.address ?? "book-stage",
      storage: input.storage ?? null,
      key,
      openId: null,
      written: false,
      tabs,
      // Which tabs are notes; every other tab is a book.
      notes: recall(input.storage, `${key}.notes`).filter((id) => tabs.includes(id)),
      labels: {},
      // Every note's title, by id, from notes: list and note.changed.
      titles: {},
      front: null,
      listed: false,
      said: null,
      // Whether someone is signed in (3.4): null until session answers.
      signedIn: null,
      // Whether the page is a try page (8), from the view, so this stays importable in Node.
      tryPage: Boolean(input.tryPage),
    };
  },
  type: "parallel",
  states: {
    account: {
      initial: "asking",
      states: {
        asking: {
          invoke: {
            src: "session",
            input: ({ context }) => ({ ask: context.ask }),
            onDone: { target: "known", actions: enqueueActions(({ context, event, enqueue }) => signIn(context, enqueue, signedIn(event.output))) },
            onError: { target: "known", actions: enqueueActions(({ context, enqueue }) => signIn(context, enqueue, true)) },
          },
        },
        known: {},
      },
    },
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
                let tabs = context.tabs.filter((id) => labels[id] !== undefined || context.notes.includes(id));
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
    // The notes' titles, and which note tabs the account still has (notes: list). A
    // note.changed or note.deleted that races it is held until the reply (4.2).
    noteTitles: {
      initial: "listing",
      states: {
        listing: {
          invoke: {
            src: "noteList",
            input: ({ context }) => ({ ask: context.ask }),
            onDone: {
              target: "known",
              actions: enqueueActions(({ context, event, enqueue }) => {
                const notes = event.output?.notes;
                // No answer (no notes on the page, offline) keeps the note tabs as stored.
                if (!Array.isArray(notes)) return;
                // A title kept before the reply is a note staged while it was on its way.
                const titles = { ...context.titles, ...Object.fromEntries(notes.map((n) => [n.id, n.title])) };
                let next = settle(context, enqueue, { titles });
                for (const id of context.notes.filter((n) => !(n in titles))) next = drop(next, enqueue, id);
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
    "session.changed": { actions: enqueueActions(({ context, event, enqueue }) => signIn(context, enqueue, event.userId != null)) },
    // The Notes panel's Open on stage (4.3, fifth rule): a tab for the note at the end, or
    // its tab to the front.
    "note.staged": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        const { id } = event;
        const fresh = !context.tabs.includes(id);
        const tabs = fresh ? [...context.tabs, id] : context.tabs;
        const notes = fresh ? [...context.notes, id] : context.notes;
        // A note just written may not be listed yet; it shows as Untitled until it is.
        const titles = id in context.titles ? context.titles : { ...context.titles, [id]: "" };
        const next = { ...context, tabs, notes, titles };
        if (context.front !== id) bringForward(next, enqueue, id);
        settle({ ...next, front: id }, enqueue, { tabs, notes, titles });
      }),
    },
    "note.changed": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (context.titles[event.id] === event.title) return;
        settle(context, enqueue, { titles: { ...context.titles, [event.id]: event.title } });
      }),
    },
    "note.deleted": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (context.notes.includes(event.id)) drop(context, enqueue, event.id);
      }),
    },
    "note.closed": { actions: enqueueActions(close) },
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
        const gone = id === context.openId ? { openId: null, written: false } : {};
        enqueue.assign(gone);
        if (context.tabs.includes(id)) drop({ ...context, ...gone }, enqueue, id);
      }),
    },
    // The desk's tab gestures name the view they belong to (4.1); another view's are not ours.
    "tab.picked": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (!mine({ context, event }) || !context.tabs.includes(event.id) || event.id === context.front) return;
        bringForward(context, enqueue, event.id);
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
