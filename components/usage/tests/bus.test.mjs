import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): usage and trace, real, on the real bus with their real schemas, and
// stand-ins for settings and session mounted with those facts' own schemas. A view
// stand-in named after the note editor announces note.saved, so the trace records it
// and usage counts it by its sender; a record crossing from another tab arrives over
// trace's channel and is not counted.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);
const { mount, unmount, ask, tap } = await import("bus");
const { setup, emit } = await import("xstate");
const { readFileSync } = await import("node:fs");

const schema = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url)));
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";

function memory() {
  const t = new Map();
  const o = new Map();
  const m = new Map();
  return {
    t,
    o,
    all: async () => [...t.values()],
    put: async (r) => void t.set(r.id, r),
    outboxAll: async () => [...o.values()],
    outboxPut: async (r) => void o.set(r.id, r),
    outboxDelete: async (id) => void o.delete(id),
    metaGet: async (k) => m.get(k),
    metaPut: async (k, v) => void m.set(k, v),
    empty: async () => {
      t.clear();
      o.clear();
      m.clear();
    },
  };
}

function fact(id, query, reply, event) {
  const machine = setup({}).createMachine({
    id,
    meta: { kind: "fact", shape: "local-only", owns: id, emits: [event], asks: [] },
    on: { [`${query}?`]: { actions: ({ event }) => event.reply(reply) } },
  });
  return mount(machine, {
    events: { [event]: schema(`${id}/events/${event}.json`) },
    queries: { [query]: schema(`${id}/queries/${query}.json`) },
  });
}

function editor() {
  const machine = setup({}).createMachine({
    id: "note-editor",
    meta: { kind: "view", emits: ["note.saved"], asks: [], attributes: [] },
    on: { save: { actions: emit(() => ({ type: "note.saved", id: ID, title: "", body: "x", baseVersion: null })) } },
  });
  return { machine, actor: mount(machine, { events: { "note.saved": schema("note-editor/events/note.saved.json") } }) };
}

test("usage learns its tab from the trace, counts a view's events by sender, and ignores another tab's", async () => {
  const settings = fact("settings", "read", { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: false, editors: {}, usageCounting: true }, "settings.changed");
  const session = fact("session", "read", { userId: "u1", registrationOpen: false }, "session.changed");
  let channel = () => {};
  const store = memory();
  const puts = [];
  const api = { put: async (rows) => (puts.push(rows), { stored: rows.length }), summary: async () => ({ days: [], accounts: 1 }) };
  const { actors, unwire } = await wire(["trace", "usage"], {
    trace: { tab: "tab-own", tap, subscribe: (fn) => ((channel = fn), () => {}), publish: () => {}, share: () => {}, print: () => {} },
    usage: { store, api },
  });
  const view = editor();
  try {
    await until(() => actors.usage.getSnapshot().matches("ready") && actors.usage.getSnapshot().context.on);
    assert.equal(actors.usage.getSnapshot().context.tab, "tab-own", "the tab of usage's own ask");
    const base = Date.now();
    // Another tab's actions, crossing over the channel with later times, are not this tab's.
    channel({ type: "record", record: { seq: 1, at: base + 1, tab: "tab-other", kind: "event", name: "note.saved", from: "note-editor", fromKind: "view", to: [], ignored: [], outcome: "delivered", reason: null, cid: null, payload: {} } });
    view.actor.send({ type: "save" });
    await new Promise((r) => setTimeout(r, 30));
    channel({ type: "record", record: { seq: 2, at: Date.now() + 5, tab: "tab-other", kind: "event", name: "day.saved", from: "journal-entry", fromKind: "view", to: [], ignored: [], outcome: "delivered", reason: null, cid: null, payload: {} } });
    view.actor.send({ type: "save" });
    await until(() => store.t.size === 1);
    const [total] = store.t.values();
    assert.equal(total.feature, "notes");
    assert.ok(total.ms >= 20 && total.ms < 2000, `the time between the two saves: ${total.ms}`);
    assert.equal(store.o.size, 1, "waiting to be sent after the pause");
    // The summary asked through the bus sends first, then answers.
    const reply = await ask(usageAsker(), "usage", "summary", { who: "you" });
    assert.deepEqual(reply, { days: [], accounts: 1 });
    assert.equal(puts.length, 1);
  } finally {
    unmount(view.actor);
    unmount(settings);
    unmount(session);
    unwire();
  }
});

// An asker declaring usage: summary, the way the usage tab will.
function usageAsker() {
  return setup({}).createMachine({ id: "test-usage-tab", meta: { kind: "view", emits: [], asks: ["usage: summary"], attributes: [] } });
}
