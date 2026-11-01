import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): flags and each of its askers, both real, on the real bus with their
// real schemas, mounted in either order, because a page's scripts can mount them in
// either order (8). `loaded` stands in for the page having run all its scripts.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire } = await import(process.env.UNBLENT_KIT);
const { ask } = await import("bus");
const { machine: conversations } = await import("../../conversations/machine.js");

const flush = () => new Promise((r) => setTimeout(r, 20));

// What the server says and the device kept: Values and Choice Points hidden, so an
// asker that read nothing (and so hides nothing) is told apart from one that read it.
const PICTURE = { off: [], hidden: ["choice-points"], released: ["choice-points", "undo"], shown: ["undo"] };
const flags = { cached: PICTURE, load: async () => PICTURE, save: async () => PICTURE };

const memory = () => ({
  all: async () => [],
  put: async () => {},
  outboxAll: async () => [],
  outboxPut: async () => {},
  outboxDelete: async () => {},
  metaGet: async () => undefined,
  metaPut: async () => {},
});

// Each asker, with what it needs to start, and what it took from flags: its hidden
// features, or for undo-bar whether Undo is hidden, or for feature-flags the Show column.
const ASKERS = {
  "book-toc": {},
  "journal-days": {},
  "journal-entry": { mint: () => "m", children: [] },
  "dock-desk": { children: [] },
  "settings-sheet": {},
  "settings-tabs": { children: [] },
  "generator-settings": {},
  evaluators: { store: memory() },
  generators: { store: memory() },
  conversations: { flags: () => ask(conversations, "flags", "read", {}) },
  "undo-bar": {},
  "feature-flags": {},
};
const seen = (name, context) => (name === "undo-bar" ? context.hidden : name === "feature-flags" ? context.shown : context.hidden);
const read = (name) => (name === "undo-bar" ? false : name === "feature-flags" ? PICTURE.shown : PICTURE.hidden);
const unknown = (name) => (name === "undo-bar" ? true : null);
const nothing = (name) => (name === "undo-bar" ? false : name === "feature-flags" ? null : []);

function gate() {
  let open;
  const opened = new Promise((r) => (open = r));
  return { loaded: () => opened, open };
}

for (const [name, input] of Object.entries(ASKERS)) {
  test(`${name} takes what flags says whether flags mounts before it or after it`, async () => {
    for (const order of [["flags", name], [name, "flags"]]) {
      const { loaded, open } = gate();
      const { actors, unwire } = await wire(order, { flags, [name]: { ...input, loaded } });
      try {
        await flush();
        open();
        await flush();
        assert.deepEqual(seen(name, actors[name].getSnapshot().context), read(name), `mounted ${order.join(" then ")}`);
      } finally {
        unwire();
      }
    }
  });

  test(`${name} on a page without flags knows nothing until the page has loaded, then hides nothing`, async () => {
    const { loaded, open } = gate();
    const { actors, unwire } = await wire([name], { [name]: { ...input, loaded } });
    try {
      await flush();
      if (name !== "feature-flags") assert.deepEqual(seen(name, actors[name].getSnapshot().context), unknown(name));
      open();
      await flush();
      assert.deepEqual(seen(name, actors[name].getSnapshot().context), nothing(name));
    } finally {
      unwire();
    }
  });
}
