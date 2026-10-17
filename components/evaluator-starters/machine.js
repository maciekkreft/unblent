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
    read: fromPromise(async ({ input }) => {
      const [pages, evaluators, books] = await Promise.all([
        input.ask("pages", "list", {}),
        input.ask("evaluators", "list", {}),
        input.ask("books", "list", {}),
      ]);
      return { pages, evaluators, books };
    }),
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
  context: ({ input }) => ({ ask: input.ask, title: null, books: [], evaluators: [], failed: false }),
  initial: "hidden",
  states: {
    hidden: { on: { _shown: "reading" } },
    reading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: assign(({ event }) => {
            const { pages, evaluators, books } = event.output;
            if (!ok(evaluators) || !ok(books)) return { failed: true };
            return {
              failed: false,
              title: ok(pages) ? (pages.pages.find((p) => p.path === PATH)?.title ?? null) : null,
              evaluators: evaluators.evaluators,
              books: books.books.map((b) => ({ id: b.id, title: b.title })),
            };
          }),
        },
        onError: { target: "ready", actions: assign({ failed: true }) },
      },
    },
    ready: {
      on: {
        _shown: "reading",
        _tick: {
          actions: emit(({ event }) => ({ type: "starter.ticked", evaluator: event.evaluator, page: PAGE, on: event.on === true })),
        },
      },
    },
  },
  on: {
    "evaluator.changed": { actions: assign({ evaluators: ({ context, event }) => upsert(context.evaluators, event.evaluator) }) },
    "evaluator.deleted": { actions: assign({ evaluators: ({ context, event }) => context.evaluators.filter((e) => e.id !== event.id) }) },
    "book.changed": {
      actions: assign({ books: ({ context, event }) => upsert(context.books, { id: event.id, title: event.title }) }),
    },
    "book.deleted": { actions: assign({ books: ({ context, event }) => context.books.filter((b) => b.id !== event.id) }) },
  },
});
