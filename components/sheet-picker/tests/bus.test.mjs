import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The kit (10): sheet-picker with the three sheets and the facts it reads, real machines on the
// real bus. The kit passes no command schemas, so the machines that accept a command are mounted
// here the way their views mount them, and the stores are faked.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, send, ask } = await import("bus");

const NOW = new Date(2026, 9, 14, 9, 30).getTime();
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const CP = "01ARZ3NDEKTSV4RRFFQ69G5CP2";

const memory = () => {
  const held = new Map();
  return {
    held,
    all: async () => [...held.values()],
    put: async (r) => void held.set(r.id, r),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
};

const json = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

async function page() {
  const wired = await wire(["wheels", "choice-points", "values"], {
    wheels: { store: memory() },
    "choice-points": { store: memory() },
    values: { store: { ...memory(), placesAll: async () => [], placePut: async () => {} }, now: () => NOW },
  });
  const [{ machine: picker }, { machine: wheel }, { machine: cards }, { machine: values }] = await Promise.all(
    ["sheet-picker", "wheel-sheet", "choice-point-cards", "values-sheet"].map((n) => import(`../../${n}/machine.js`)),
  );
  const input = (m, more = {}) => ({
    ask: (target, name, payload) => ask(m, target, name, payload),
    send: (target, name, payload) => send(m, target, name, payload),
    now: () => NOW,
    ...more,
  });
  const actors = {
    picker: mount(picker, { input: input(picker), commands: { focus: json("sheet-picker/commands/focus.json") } }),
    wheel: mount(wheel, {
      input: input(wheel, { mint: () => ID }),
      events: { "wheel.saved": json("wheel-sheet/events/wheel.saved.json") },
      commands: { add: json("wheel-sheet/commands/add.json") },
    }),
    cards: mount(cards, {
      input: input(cards, { mint: () => CP }),
      events: { "choice-point.saved": json("choice-point-cards/events/choice-point.saved.json") },
      commands: { add: json("choice-point-cards/commands/add.json") },
    }),
    values: mount(values, {
      input: input(values, { mint: () => ID }),
      events: { "values.saved": json("values-sheet/events/values.saved.json"), "values.placed": json("values-sheet/events/values.placed.json") },
      commands: { add: json("values-sheet/commands/add.json") },
    }),
  };
  const finish = () => {
    Object.values(actors).forEach(unmount);
    wired.unwire();
  };
  return { ...wired, finish, sheets: actors, ctx: () => actors.picker.getSnapshot().context };
}

test("picking the Wheel of Life opens a wheel through the bus; once it is kept it leaves the list, and deleting it puts it back", async () => {
  const { sheets, finish, ctx, records } = await page();
  try {
    await until(() => sheets.wheel.getSnapshot().matches("ready") && ctx().wheels !== null);
    sheets.picker.send({ type: "_toggle" });
    sheets.picker.send({ type: "_pick", id: "wheel" });
    assert.equal(sheets.wheel.getSnapshot().context.draft.id, ID);
    assert.equal(sheets.wheel.getSnapshot().context.landing, 1);
    assert.ok(records.some((r) => r.kind === "command" && r.name === "add"));

    sheets.wheel.send({ type: "_press", area: 0, value: 6 });
    sheets.wheel.send({ type: "_done" });
    await until(() => ctx().wheels.some((w) => w.id === ID));
    sheets.wheel.send({ type: "_open", id: ID });
    sheets.wheel.send({ type: "_delete" });
    await until(() => !ctx().wheels.some((w) => w.id === ID));
  } finally {
    finish();
  }
});

test("picking Choice point opens a new one through the bus, and picking it again another", async () => {
  const { sheets, finish } = await page();
  try {
    await until(() => sheets.cards.getSnapshot().matches("ready"));
    sheets.picker.send({ type: "_pick", id: "choice-point" });
    sheets.picker.send({ type: "_pick", id: "choice-point" });
    const { drafts, landing } = sheets.cards.getSnapshot().context;
    assert.equal(drafts.length, 2);
    assert.equal(landing, 2);
  } finally {
    finish();
  }
});

test("picking Your values puts the panel on the day through the bus, and the fact's answer takes it off the list", async () => {
  const { sheets, finish, ctx } = await page();
  try {
    await until(() => sheets.values.getSnapshot().matches("ready") && ctx().placed === false);
    sheets.picker.send({ type: "_pick", id: "values" });
    assert.equal(sheets.values.getSnapshot().context.placed, true);
    assert.equal(sheets.values.getSnapshot().context.landing, 1);
    await until(() => ctx().placed === true);
  } finally {
    finish();
  }
});

test("a sheet handing the keyboard back reaches the picker's focus command through the bus, from each sheet", async () => {
  const { sheets, finish, ctx } = await page();
  try {
    sheets.wheel.send({ type: "_handBack" });
    sheets.cards.send({ type: "_handBack" });
    sheets.values.send({ type: "_handBack" });
    assert.equal(ctx().landing, 3);
  } finally {
    finish();
  }
});

test("add is ignored by each sheet on a day that cannot be written", async () => {
  const { sheets, finish } = await page();
  try {
    await until(() => sheets.wheel.getSnapshot().matches("ready") && sheets.cards.getSnapshot().matches("ready"));
    const closed = { type: "day.shown", day: "2026-10-14", writable: false };
    sheets.wheel.send(closed);
    sheets.cards.send(closed);
    sheets.values.send(closed);
    sheets.wheel.send({ type: "add" });
    sheets.cards.send({ type: "add" });
    sheets.values.send({ type: "add" });
    assert.equal(sheets.wheel.getSnapshot().context.draft, null);
    assert.equal(sheets.cards.getSnapshot().context.drafts.length, 0);
    assert.equal(sheets.values.getSnapshot().context.landing, 0);
  } finally {
    finish();
  }
});
