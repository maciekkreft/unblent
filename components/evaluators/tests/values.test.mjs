import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): evaluators and values, both real, on the real bus with their real
// schemas. A stand-in mounted with the schemas of the views that send these gestures
// (values-sheet, evaluator-list, evaluator-editor) saves values, asks for the
// evaluators and tries to delete and rewrite Your values, so every payload and reply is
// checked against its contract.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const YOURS = "0000000000000000000000YVAS";
const JOURNAL = "00000000000000000000000JRN";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const SERVES = "0000000000000000000000SRVS";
const AGAINST = "0000000000000000000000AGST";
const UNRELATED = "0000000000000000000000NRTD";

const pad = (n) => String(n).padStart(2, "0");
const d = new Date();
const TODAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const PAST = "2026-01-05";
const parent = { id: "01ARZ3NDEKTSV4RRFFQ69G5VA1", name: "Being a present parent", meaning: "Showing up for my kids." };
const health = { id: "01ARZ3NDEKTSV4RRFFQ69G5VA2", name: "Health", meaning: "" };
const old = { id: "01ARZ3NDEKTSV4RRFFQ69G5VA0", name: "Learning", meaning: "" };

const memory = (key) => {
  const rows = new Map();
  return {
    rows,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r[key], r),
    // values keeps its days' placements beside its versions.
    placesAll: async () => [],
    placePut: async () => {},
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const events = {
  "values.saved": schema("../../values-sheet/events/values.saved.json"),
  "evaluator.discarded": schema("../../evaluator-list/events/evaluator.discarded.json"),
  "evaluator.switched": schema("../../evaluator-list/events/evaluator.switched.json"),
  "evaluator.saved": schema("../../evaluator-editor/events/evaluator.saved.json"),
  "removal.started": schema("../../evaluator-editor/events/removal.started.json"),
};

function standIn(heard) {
  const machine = setup({}).createMachine({
    id: "test-views",
    meta: { kind: "view", emits: Object.keys(events), asks: ["evaluators: list"], attributes: [] },
    on: {
      go: { actions: emit(({ event }) => event.body) },
      "evaluator.changed": { actions: ({ event }) => heard.push(event.evaluator) },
    },
  });
  const actor = mount(machine, { events });
  const list = async (payload) => (await ask(machine, "evaluators", "list", payload)).evaluators;
  return { actor, list, send: (body) => actor.send({ type: "go", body }) };
}

async function start(names = ["values", "evaluators"], versions = []) {
  const valueStore = memory("day");
  for (const v of versions) valueStore.rows.set(v.day, v);
  const store = memory("id");
  const { actors, unwire } = await wire(names, { values: { store: valueStore, now: () => Date.now() }, evaluators: { store } });
  const heard = [];
  const views = standIn(heard);
  for (const name of names) await until(() => actors[name].getSnapshot().matches("ready"));
  return { ...views, heard, store, stop: () => (unmount(views.actor), unwire()) };
}

const yours = async (views, payload = { book: JOURNAL }) => (await views.list(payload)).find((e) => e.id === YOURS);

test("Your values is kept with the Journal, one pick question per value, Serves expected", async () => {
  const views = await start();
  try {
    const empty = await yours(views);
    assert.deepEqual([empty.name, empty.on, empty.questions, empty.derivedFrom, empty.combined], ["Your values", true, [], "values", true], "no values, no questions");
    views.send({ type: "values.saved", day: TODAY, values: [parent, health] });
    await until(() => views.heard.some((e) => e.id === YOURS && e.questions.length === 2));
    const listed = await yours(views);
    assert.deepEqual(listed.questions.map((q) => q.id), [parent.id, health.id], "a question's id is its value's");
    const [q] = listed.questions;
    assert.equal(q.kind, "pick");
    assert.equal(q.expect, SERVES);
    assert.match(q.text, /“Being a present parent” \(Showing up for my kids\)\?$/);
    assert.equal(q.name, "Being a present parent", "named after its value");
    assert.deepEqual(q.options.map((o) => [o.id, o.name, o.against === true]), [
      [SERVES, "Serves", false],
      [AGAINST, "Goes against", true],
      [UNRELATED, "Unrelated", false],
    ]);
    assert.ok(q.options.every((o) => o.description), "each option says what it means");
    assert.ok(!(await views.list({ book: BOOK })).some((e) => e.id === YOURS), "not kept with another book");
    assert.ok((await views.list({})).some((e) => e.id === YOURS), "every book's list holds it");
    assert.equal(views.store.rows.size, 0, "nothing of it is stored until the user sets something");
    views.send({ type: "evaluator.saved", id: "01ARZ3NDEKTSV4RRFFQ69G5EV1", book: JOURNAL, name: "Goals", questions: [] });
    await until(async () => (await views.list({ book: JOURNAL })).length === 2);
    assert.deepEqual((await views.list({ book: JOURNAL })).map((e) => e.name), ["Goals", "Your values"], "at the end until moved");
  } finally {
    views.stop();
  }
});

test("a day asks for that day's values; no day gives today's", async () => {
  const views = await start(["values", "evaluators"], [{ day: PAST, values: [old], version: 1 }]);
  try {
    views.send({ type: "values.saved", day: TODAY, values: [parent] });
    await until(() => views.heard.some((e) => e.id === YOURS && e.questions[0]?.id === parent.id));
    assert.deepEqual((await yours(views, { book: JOURNAL, day: PAST })).questions.map((q) => q.id), [old.id]);
    assert.deepEqual((await yours(views, { book: JOURNAL, day: "2026-01-01" })).questions, [], "before any values");
    assert.deepEqual((await yours(views)).questions.map((q) => q.id), [parent.id]);
  } finally {
    views.stop();
  }
});

test("a change of values is announced; a delete, a discard or a save over it changes nothing, a switch is kept", async () => {
  const views = await start();
  try {
    views.send({ type: "values.saved", day: TODAY, values: [parent] });
    await until(() => views.heard.some((e) => e.id === YOURS && e.questions.length === 1));
    views.send({ type: "values.saved", day: TODAY, values: [parent, health] });
    await until(() => views.heard.some((e) => e.id === YOURS && e.questions.length === 2));

    views.send({ type: "evaluator.discarded", id: YOURS });
    views.send({ type: "removal.started", kind: "evaluator", id: YOURS, name: "Your values" });
    views.send({ type: "evaluator.saved", id: YOURS, book: JOURNAL, name: "Mine", questions: [] });
    let listed = await yours(views);
    assert.deepEqual([listed.name, listed.removing, listed.questions.length], ["Your values", false, 2]);
    assert.equal(views.store.rows.size, 0);

    views.send({ type: "evaluator.switched", id: YOURS, on: false });
    await until(() => views.heard.some((e) => e.id === YOURS && e.on === false));
    listed = await yours(views);
    assert.deepEqual([listed.on, listed.questions.length], [false, 2], "off, its questions still its values");
    assert.deepEqual(views.store.rows.get(YOURS)?.questions, [], "stored: only what the user set");
  } finally {
    views.stop();
  }
});

test("without the values fact on the page, Your values is not listed", async () => {
  const views = await start(["evaluators"]);
  try {
    assert.deepEqual(await views.list({ book: JOURNAL }), []);
  } finally {
    views.stop();
  }
});
