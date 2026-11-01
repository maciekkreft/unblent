import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The chat's journal lookups (7.7): journal, real, on the real bus with its real schemas
// (the kit, 10). A stand-in mounted with journal-entry's own day.shown schema announces
// the shown day the way that view does, and asks the two queries as the chat's loop would.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask } = await import("bus");
const { setup, emit } = await import("xstate");

const D1 = "01K7TEST00000000000000DA01";
const D2 = "01K7TEST00000000000000DA02";
const D3 = "01K7TEST00000000000000DA03";
const at = (d, h = 0) => new Date(2026, 9, d, h).getTime();

const memory = (days) => {
  const rows = new Map(days.map((r) => [r.id, r]));
  return {
    all: async () => [...rows.values()],
    put: async (_, r) => void rows.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
    empty: async () => rows.clear(),
  };
};

const shownSchema = JSON.parse(readFileSync(new URL("../../journal-entry/events/day.shown.json", import.meta.url)));

function standIn() {
  const machine = setup({}).createMachine({
    id: "test-journal-page",
    meta: { kind: "view", emits: ["day.shown"], asks: ["journal: open", "journal: days", "journal: index"], attributes: [] },
    on: { go: { actions: emit(({ event }) => ({ type: "day.shown", ...event.body })) } },
  });
  const actor = mount(machine, { events: { "day.shown": shownSchema } });
  return {
    show: (body) => actor.send({ type: "go", body }),
    open: () => ask(machine, "journal", "open", {}),
    days: (payload) => ask(machine, "journal", "days", payload),
    index: (payload) => ask(machine, "journal", "index", payload),
    stop: () => unmount(actor),
  };
}

async function journalOn(days, now, input = {}) {
  const wired = await wire(["journal"], { journal: { store: memory(days), now: () => now, ...input } });
  await until(() => wired.actors.journal.getSnapshot().matches("ready"));
  return wired;
}

const DAYS = [
  { id: D1, day: "2026-10-12", text: "# Monday\nEarlier", editedAt: at(12, 9), version: 1 },
  { id: D2, day: "2026-10-14", text: "Later", editedAt: at(14, 9), version: 2 },
  { id: D3, day: "2026-10-13", text: "Gone", editedAt: at(13, 9), version: 2, deleted: true },
];

test("open answers the day the journal page last announced, with its text and whether it can be written", async () => {
  const { unwire } = await journalOn(DAYS, at(15, 10));
  const page = standIn();
  try {
    assert.deepEqual(await page.open(), { shown: null }, "no journal page has announced a day");
    page.show({ day: "2026-10-12", writable: false });
    await until(async () => (await page.open()).shown?.day === "2026-10-12");
    assert.deepEqual(await page.open(), { shown: { day: "2026-10-12", text: "# Monday\nEarlier", writable: false } });
    // Today's page with nothing written yet; without `writable`, only today counts as writable.
    page.show({ day: "2026-10-15" });
    await until(async () => (await page.open()).shown?.day === "2026-10-15");
    assert.deepEqual(await page.open(), { shown: { day: "2026-10-15", text: "", writable: true } });
  } finally {
    page.stop();
    unwire();
  }
});

test("days answers the written days in a range of dates, oldest first, without deleted ones", async () => {
  const { unwire } = await journalOn(DAYS, at(15, 10));
  const page = standIn();
  const dates = async (payload) => (await page.days(payload)).days.map((d) => d.day);
  try {
    assert.deepEqual(await page.days({}), {
      days: [
        { day: "2026-10-12", text: "# Monday\nEarlier" },
        { day: "2026-10-14", text: "Later" },
      ],
    });
    assert.deepEqual(await dates({ from: "2026-10-14" }), ["2026-10-14"], "from alone is one day");
    assert.deepEqual(await dates({ from: "2026-10-13" }), [], "a date with nothing written");
    assert.deepEqual(await dates({ from: "2026-10-01", to: "2026-10-13" }), ["2026-10-12"]);
    assert.deepEqual(await dates({ to: "2026-10-14" }), ["2026-10-12", "2026-10-14"], "both ends included");
    assert.deepEqual(await page.days({ from: "12 Oct" }), { error: "invalid-payload" });
  } finally {
    page.stop();
    unwire();
  }
});

// Ten written days, 1 to 10 October, the 5th mentioning Mum.
const TEN = Array.from({ length: 10 }, (_, i) => ({
  id: `01K7TEST00000000000000DB${String(i + 10)}`,
  day: `2026-10-${String(i + 1).padStart(2, "0")}`,
  text: i === 4 ? "## Sunday\nA call with MUM about the move.\n\nLong evening." : `Day ${i + 1} went fine`,
  editedAt: at(i + 1, 9),
  version: 1,
}));

test("days answers at most seven days and counts the ones it left out", async () => {
  const { unwire } = await journalOn(TEN, at(15, 10));
  const page = standIn();
  try {
    const all = await page.days({ from: "2026-10-01", to: "2026-10-31" });
    assert.deepEqual(all.days.map((d) => d.day.slice(8)), ["01", "02", "03", "04", "05", "06", "07"], "the first seven, oldest first");
    assert.equal(all.more, 3);
    const rest = await page.days({ from: "2026-10-08", to: "2026-10-31" });
    assert.equal(rest.days.length, 3);
    assert.ok(!("more" in rest), "a range of seven or fewer carries no more");
  } finally {
    page.stop();
    unwire();
  }
});

test("index lists written days newest first, short, filtered, with how many more", async () => {
  const { unwire } = await journalOn([...TEN, ...DAYS], at(15, 10));
  const page = standIn();
  try {
    const first = await page.index({});
    assert.equal(first.total, 12, "ten days, the 12th and the 14th; the deleted 13th is not counted");
    assert.equal(first.days.length, 12);
    assert.deepEqual(first.days.slice(0, 3).map((d) => d.day), ["2026-10-14", "2026-10-12", "2026-10-10"], "newest first");
    assert.deepEqual(first.days[0], { id: D2, day: "2026-10-14", summary: "Later", words: 1 });
    assert.equal(first.days[1].summary, "Monday", "the first line, without its level marker");
    const few = await page.index({ limit: 3 });
    assert.deepEqual([few.days.length, few.total, few.more], [3, 12, 9]);
    const mum = await page.index({ contains: "mum", from: "2026-10-01", to: "2026-10-09" });
    assert.deepEqual(mum.days.map((d) => [d.day, d.summary, d.words]), [["2026-10-05", "Sunday", 10]], "contains ignores case");
    assert.deepEqual((await page.index({ from: "2026-10-10" })).days.map((d) => d.day), ["2026-10-14", "2026-10-12", "2026-10-10"], "from alone is every day since it");
    assert.deepEqual(await page.index({ limit: 51 }), { error: "invalid-payload" });
  } finally {
    page.stop();
    unwire();
  }
});

test("index has at most twenty entries unless asked for more, up to fifty", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `01K7TEST00000000000000DC${String(i + 10)}`,
    day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    text: "x",
    editedAt: at(1, 9),
    version: 1,
  }));
  const { unwire } = await journalOn(many, at(15, 10));
  const page = standIn();
  try {
    const list = await page.index({});
    assert.deepEqual([list.days.length, list.total, list.more], [20, 30, 10]);
    assert.equal((await page.index({ limit: 50 })).days.length, 30);
  } finally {
    page.stop();
    unwire();
  }
});

// A stand-in for generators: its results schema and generation.changed, answering the
// summaries it holds, as generators does.
function generatorsStandIn(results) {
  const dir = new URL("../../generators/", import.meta.url);
  const results$ = JSON.parse(readFileSync(new URL("queries/results.json", dir)));
  const changed = JSON.parse(readFileSync(new URL("events/generation.changed.json", dir)));
  const machine = setup({}).createMachine({
    id: "generators",
    meta: { kind: "fact", shape: "local-only", owns: "test summaries", emits: ["generation.changed"], asks: [] },
    on: {
      "results?": { actions: ({ event }) => event.reply({ results }) },
      go: { actions: emit(({ event }) => ({ type: "generation.changed", result: event.result })) },
    },
  });
  const actor = mount(machine, { events: { "generation.changed": changed }, queries: { results: results$ } });
  return { announce: (result) => actor.send({ type: "go", result }), stop: () => unmount(actor) };
}

const SOURCE = "0".repeat(64);
const summary = (item, text, version = 1) => ({ id: `journal-summary:${item}`, generator: "journal-summary", item, text, source: SOURCE, version });

const signedIn = { ask: async () => ({ userId: "u1" }) };

test("index takes a day's summary from the journal summary generator while signed in, and follows new ones", async () => {
  const gens = generatorsStandIn([summary("2026-10-12", "A quiet Monday."), { ...summary("x", "t"), id: "chat-title:x", generator: "chat-title" }]);
  const store = memory(DAYS);
  store.metaGet = async (key) => (key === "userId" ? "u1" : undefined);
  const { machine } = await import("../machine.js");
  const actor = mount(machine, {
    input: {
      store,
      now: () => at(15, 10),
      api: { put: async () => ({}), pull: async () => ({ cursor: 0, days: [] }) },
      ask: (target, name, payload) => (target === "session" ? signedIn.ask() : ask(machine, target, name, payload)),
    },
    events: Object.fromEntries(["journal.changed", "journal.conflicted", "step.recorded", "step.settled"].map((n) => [n, JSON.parse(readFileSync(new URL(`../events/${n}.json`, import.meta.url)))])),
    queries: Object.fromEntries(["read", "open", "days", "index"].map((n) => [n, JSON.parse(readFileSync(new URL(`../queries/${n}.json`, import.meta.url)))])),
  });
  const page = standIn();
  const summaries = async () => Object.fromEntries((await page.index({})).days.map((d) => [d.day, d.summary]));
  try {
    await until(async () => (await summaries())["2026-10-12"] === "A quiet Monday.");
    assert.equal((await summaries())["2026-10-14"], "Later", "a day without one shows its first line");
    gens.announce(summary("2026-10-14", "Later, a good day.", 2));
    await until(async () => (await summaries())["2026-10-14"] === "Later, a good day.");
    gens.announce(summary("2026-10-14", "An old summary.", 1));
    gens.announce(summary("2026-10-12", "A newer Monday.", 2));
    await until(async () => (await summaries())["2026-10-12"] === "A newer Monday.");
    assert.equal((await summaries())["2026-10-14"], "Later, a good day.", "an older version never replaces a newer one");
  } finally {
    page.stop();
    unmount(actor);
    gens.stop();
  }
});

test("index shows first lines only while signed out, and without generators on the page", async () => {
  const gens = generatorsStandIn([summary("2026-10-12", "A quiet Monday.")]);
  const { unwire } = await journalOn(DAYS, at(15, 10));
  const page = standIn();
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual((await page.index({})).days.map((d) => d.summary), ["Later", "Monday"]);
  } finally {
    page.stop();
    unwire();
    gens.stop();
  }
  const alone = await journalOn(DAYS, at(15, 10));
  const page2 = standIn();
  try {
    assert.deepEqual((await page2.index({})).days.map((d) => d.summary), ["Later", "Monday"]);
  } finally {
    page2.stop();
    alone.unwire();
  }
});

// The chat's tool list is catalog: contracts (7.7); the three lookups are in it, labelled,
// and reach conversations through its `*: tool` ask.
test("the chat is offered the journal's lookups and the choice points", async () => {
  assert.ok(process.env.UNBLENT_URL, "UNBLENT_URL must be set");
  const res = await fetch(`${process.env.UNBLENT_URL}/api/catalog/contracts`);
  assert.equal(res.status, 200);
  const { queries } = await res.json();
  const byKey = Object.fromEntries(queries.map((q) => [`${q.target}: ${q.name}`, q]));
  const labels = {
    "journal: open": "Reading the open journal day",
    "journal: days": "Reading journal day text",
    "journal: index": "Reading journal days",
    "choice-points: list": "Reading choice points",
  };
  for (const [key, label] of Object.entries(labels)) {
    assert.equal(byKey[key]?.tool?.label, label, key);
    assert.ok(byKey[key].tool.description.length > 0, key);
    assert.ok(byKey[key].askers.includes("conversations"), `${key} is asked by conversations`);
  }
});

test("a first line stands in for a summary: the first written line, without its marker, cut at 25 words", async () => {
  const { firstLine } = await import("../machine.js");
  assert.equal(firstLine("\n\n### Plans\nmore"), "Plans");
  assert.equal(firstLine(""), "");
  const long = Array.from({ length: 30 }, (_, i) => "w" + i).join(" ");
  assert.equal(firstLine(long), long.split(" ").slice(0, 25).join(" ") + "…");
});
