import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the Evaluators group of Starters in Administration (8, 12). It
// owns no fact: the evaluators and their ticks belong to `evaluators`, the books' titles
// to `books`, and the try page to `pages`, each reached by one query for the starting
// picture and its events after (4.3, fourth rule); a tick is emitted as starter.ticked
// and the box follows evaluator.changed. It asks only once it is shown (`_shown`, sent
// by the view), so nobody but the admin, the one account the sheet shows it to, asks.
// The ask arrives through `input`, so the machine imports in Node.

// The try page this group is for, by name, and its address.
export const PAGE = "evaluators";
export const PATH = `/try/${PAGE}`;

export const UNTITLED = "Untitled evaluator";

// A question Run would ask (the same rule as evaluator-list's; components never import
// each other, 11.2): not being removed, switched on, written, and for a pick question
// two live options with distinct names.
const filled = (s) => typeof s === "string" && s.trim() !== "";
const pickable = (question) => {
  const names = (question.options ?? []).filter((o) => !o.removing).map((o) => (o.name ?? "").trim());
  return names.length >= 2 && names.every((n) => n !== "") && new Set(names).size === names.length;
};
const askable = (question) =>
  !question.removing && question.on !== false && filled(question.text) && (question.kind !== "pick" || pickable(question));

// What a book's group lists: the admin's evaluators kept with each book, the books in
// the order books lists them (the Journal first), each evaluator in id order with its
// tick for this page and how many questions Run would ask. One in its undo window, or
// of a book no longer listed, is left out.
export const groupsOf = ({ books, evaluators }) =>
  books
    .map((book) => ({
      book: book.id,
      title: book.title,
      evaluators: evaluators
        .filter((e) => e.book === book.id && !e.removing)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((e) => ({
          id: e.id,
          name: e.name || UNTITLED,
          questions: (e.questions ?? []).filter(askable).length,
          ticked: Array.isArray(e.starterFor) && e.starterFor.includes(PAGE),
        })),
    }))
    .filter((group) => group.evaluators.length > 0);

// "3 questions", "1 question".
export const countText = (n) => `${n} ${n === 1 ? "question" : "questions"}`;

const ok = (reply) => reply && !reply.error;

const upsert = (list, item) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask(input.target, "list", {})),
  },
}).createMachine({
  id: "evaluator-starters",
  meta: {
    description:
      "The Evaluators group of Starters in Administration, shown only to the admin: the " +
      "try page's link with Copy link, which copies it ready to paste, and the admin's " +
      "evaluators grouped by book, each with a tick and how many of its questions are " +
      "written and switched on. A new guest of the Evaluators try " +
      "page gets a copy of each ticked evaluator as it is " +
      "then, kept with the guest's Journal. Each later try page adds its own group as a " +
      "view of its own.",
    kind: "view",
    emits: ["starter.ticked"],
    attributes: [],
    asks: ["pages: list", "evaluators: list", "books: list"],
  },
  // `read` turns true at the first answer: a later read, after one that failed, keeps
  // what is shown, so the sheet never shrinks under a scrolling finger.
  context: ({ input }) => ({ ask: input.ask, read: false, title: null, books: [], evaluators: [], failed: false, waiting: 0, failing: false }),
  initial: "hidden",
  states: {
    hidden: { on: { _shown: "reading" } },
    // Each answer is taken as it lands, never all three together: the bus releases the
    // events a query holds right after that query's reply (4.2), so an evaluator.changed
    // or book.changed that comes while a slower answer is still on its way is applied
    // on top of its own starting picture instead of being overwritten by it.
    reading: {
      entry: assign({ waiting: 3, failing: false }),
      invoke: [
        {
          src: "read",
          input: ({ context }) => ({ ask: context.ask, target: "pages" }),
          onDone: {
            actions: assign(({ context, event }) => ({
              waiting: context.waiting - 1,
              title: ok(event.output) ? (event.output.pages.find((p) => p.path === PATH)?.title ?? null) : context.title,
            })),
          },
          onError: { actions: assign({ waiting: ({ context }) => context.waiting - 1 }) },
        },
        {
          src: "read",
          input: ({ context }) => ({ ask: context.ask, target: "evaluators" }),
          onDone: {
            actions: assign(({ context, event }) =>
              ok(event.output)
                ? { waiting: context.waiting - 1, evaluators: event.output.evaluators }
                : { waiting: context.waiting - 1, failing: true },
            ),
          },
          onError: { actions: assign({ waiting: ({ context }) => context.waiting - 1, failing: true }) },
        },
        {
          src: "read",
          input: ({ context }) => ({ ask: context.ask, target: "books" }),
          onDone: {
            actions: assign(({ context, event }) =>
              ok(event.output)
                ? { waiting: context.waiting - 1, books: event.output.books.map((b) => ({ id: b.id, title: b.title })) }
                : { waiting: context.waiting - 1, failing: true },
            ),
          },
          onError: { actions: assign({ waiting: ({ context }) => context.waiting - 1, failing: true }) },
        },
      ],
      always: {
        guard: ({ context }) => context.waiting === 0,
        target: "ready",
        actions: assign(({ context }) => ({ read: true, failed: context.failing })),
      },
    },
    // The first answer is the starting picture and the events keep it current (4.3), so
    // coming into view again reads only after a read that failed; a second read could
    // land after a tick and show the box as it was before it.
    ready: { on: { _shown: { guard: ({ context }) => context.failed, target: "reading" } } },
  },
  // A tick is handled in every state, so one made while the part reads its data again
  // is never dropped.
  on: {
    _tick: {
      actions: emit(({ event }) => ({ type: "starter.ticked", evaluator: event.evaluator, page: PAGE, on: event.on === true })),
    },
    "evaluator.changed": { actions: assign({ evaluators: ({ context, event }) => upsert(context.evaluators, event.evaluator) }) },
    "evaluator.deleted": { actions: assign({ evaluators: ({ context, event }) => context.evaluators.filter((e) => e.id !== event.id) }) },
    "book.changed": {
      actions: assign({ books: ({ context, event }) => upsert(context.books, { id: event.id, title: event.title }) }),
    },
    "book.deleted": { actions: assign({ books: ({ context, event }) => context.books.filter((b) => b.id !== event.id) }) },
  },
});
