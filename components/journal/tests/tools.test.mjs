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
    meta: { kind: "view", emits: ["day.shown"], asks: ["journal: open", "journal: days"], attributes: [] },
    on: { go: { actions: emit(({ event }) => ({ type: "day.shown", ...event.body })) } },
  });
  const actor = mount(machine, { events: { "day.shown": shownSchema } });
  return {
    show: (body) => actor.send({ type: "go", body }),
    open: () => ask(machine, "journal", "open", {}),
    days: (payload) => ask(machine, "journal", "days", payload),
    stop: () => unmount(actor),
  };
}

async function journalOn(days, now) {
  const wired = await wire(["journal"], { journal: { store: memory(days), now: () => now } });
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
    "journal: days": "Reading journal days",
    "choice-points: list": "Reading choice points",
  };
  for (const [key, label] of Object.entries(labels)) {
    assert.equal(byKey[key]?.tool?.label, label, key);
    assert.ok(byKey[key].tool.description.length > 0, key);
    assert.ok(byKey[key].askers.includes("conversations"), `${key} is asked by conversations`);
  }
});
