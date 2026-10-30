import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, groupsOf, countText } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

const JOURNAL = "00000000000000000000000JRN";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const E1 = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const E2 = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const E3 = "01ARZ3NDEKTSV4RRFFQ69G5EV3";
const q = (removing = false) => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5QQ1", kind: "yesno", text: "Is it a goal?", removing });

const evaluator = (id, book, over = {}) => ({ id, book, name: "Goals", on: true, journal: false, questions: [q()], version: 1, removing: false, pending: false, ...over });

const REPLIES = {
  pages: { pages: [{ path: "/try/evaluators", title: "Evaluators", kind: "try" }] },
  evaluators: {
    evaluators: [
      evaluator(E2, JOURNAL, { name: "Values check", questions: [q(), q(), q(true)] }),
      evaluator(E1, JOURNAL, { name: "Clear goal", starterFor: ["evaluators"] }),
      evaluator(E3, BOOK, { name: "" }),
    ],
  },
  books: { books: [{ id: JOURNAL, title: "Journal", written: true }, { id: BOOK, title: "The Happiness Trap" }] },
};

test("the admin's evaluators are grouped by book, the Journal first, each with its tick and count", () => {
  const groups = groupsOf({
    books: REPLIES.books.books,
    evaluators: [...REPLIES.evaluators.evaluators, evaluator("01ARZ3NDEKTSV4RRFFQ69G5EV4", BOOK, { removing: true })],
  });
  assert.deepEqual(groups, [
    {
      book: JOURNAL,
      title: "Journal",
      evaluators: [
        { id: E1, name: "Clear goal", questions: 1, ticked: true },
        { id: E2, name: "Values check", questions: 2, ticked: false },
      ],
    },
    { book: BOOK, title: "The Happiness Trap", evaluators: [{ id: E3, name: "Untitled evaluator", questions: 1, ticked: false }] },
  ]);
  assert.deepEqual([countText(1), countText(3)], ["1 question", "3 questions"]);
});

test("it asks only once shown, emits a tick, and follows the facts' news", async () => {
  const asked = [];
  const emitted = [];
  const actor = createActor(machine, { input: { ask: async (target, name) => (asked.push(`${target}: ${name}`), REPLIES[target]) } });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await flush();
  assert.deepEqual(asked, [], "nothing is asked while the part is not shown");
  actor.send({ type: "_shown" });
  await flush();
  assert.deepEqual(asked.sort(), ["books: list", "evaluators: list", "pages: list"]);
  assert.equal(actor.getSnapshot().context.title, "Evaluators");

  actor.send({ type: "_tick", evaluator: E2, on: true });
  assert.deepEqual(emitted, [{ type: "starter.ticked", evaluator: E2, page: "evaluators", on: true }]);

  actor.send({ type: "evaluator.changed", evaluator: evaluator(E2, JOURNAL, { name: "Values check", starterFor: ["evaluators"] }) });
  actor.send({ type: "evaluator.deleted", id: E3, book: BOOK });
  actor.send({ type: "book.changed", id: "01ARZ3NDEKTSV4RRFFQ69G5BK2", title: "Another" });
  const groups = groupsOf(actor.getSnapshot().context);
  assert.deepEqual(groups.map((g) => [g.title, g.evaluators.map((e) => [e.name, e.ticked])]), [
    ["Journal", [["Clear goal", true], ["Values check", true]]],
  ]);
});

// The bus releases what a query holds right after that query's reply (4.2), so news can
// land while another answer is still on its way; the slower answer must not undo it.
test("news that lands while another answer is on its way is kept", async () => {
  let pagesAnswer;
  const pages = new Promise((resolve) => (pagesAnswer = resolve));
  const books = { books: [{ id: BOOK, title: "The Happiness Trap" }] };
  const actor = createActor(machine, {
    input: { ask: async (target) => (target === "pages" ? pages : target === "books" ? books : { evaluators: [] }) },
  }).start();
  actor.send({ type: "_shown" });
  await flush();
  actor.send({ type: "evaluator.changed", evaluator: evaluator(E1, JOURNAL, { name: "Kind or harsh" }) });
  actor.send({ type: "book.changed", id: JOURNAL, title: "Journal" });
  pagesAnswer(REPLIES.pages);
  await flush();
  assert.equal(actor.getSnapshot().matches("ready"), true);
  assert.deepEqual(groupsOf(actor.getSnapshot().context).map((g) => [g.title, g.evaluators.map((e) => e.name)]), [["Journal", ["Kind or harsh"]]]);
});

test("coming into view again reads only after a failed read, keeping what is shown", async () => {
  const emitted = [];
  let books = { error: "no-answerer" };
  const actor = createActor(machine, { input: { ask: async (target) => (target === "books" ? books : REPLIES[target]) } });
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  assert.equal(actor.getSnapshot().context.read, false, "nothing to show before the first answer");
  actor.send({ type: "_shown" });
  await flush();
  assert.equal(actor.getSnapshot().context.failed, true);
  books = new Promise(() => {});
  actor.send({ type: "_shown" });
  await flush();
  assert.equal(actor.getSnapshot().matches("reading"), true, "a failed read is tried again");
  assert.equal(actor.getSnapshot().context.read, true, "the part keeps its content, so the sheet does not shrink");
  actor.send({ type: "_tick", evaluator: E2, on: true });
  assert.deepEqual(emitted, [{ type: "starter.ticked", evaluator: E2, page: "evaluators", on: true }]);

  const asked = [];
  const fresh = createActor(machine, { input: { ask: async (target, name) => (asked.push(`${target}: ${name}`), REPLIES[target]) } }).start();
  fresh.send({ type: "_shown" });
  await flush();
  asked.length = 0;
  fresh.send({ type: "_shown" });
  await flush();
  assert.deepEqual(asked, [], "a part that read once follows the events instead of reading again");
});

test("a reply that is not the picture leaves the part saying so", async () => {
  const actor = createActor(machine, { input: { ask: async (target) => (target === "evaluators" ? { error: "no-answerer" } : REPLIES[target]) } }).start();
  actor.send({ type: "_shown" });
  await flush();
  assert.equal(actor.getSnapshot().context.failed, true);
});

test("a starter counts only the questions Run would ask", () => {
  const groups = groupsOf({
    books: [{ id: JOURNAL, title: "Journal" }],
    evaluators: [
      evaluator(E1, JOURNAL, {
        questions: [q(), { ...q(), text: "" }, { ...q(), on: false }, { ...q(), kind: "pick", options: [{ id: "o1", name: "One" }] }],
      }),
    ],
  });
  assert.equal(groups[0].evaluators[0].questions, 1);
  assert.equal(countText(0), "0 questions");
});
