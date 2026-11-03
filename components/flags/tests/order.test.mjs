import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): flags and each of its askers, both real, on the real bus with their
// real schemas, mounted in either order, because a page's scripts can mount them in
// either order (8). The bus's loading window (4.2) stands in for the page still running
// its scripts, and the function `pageLoading` returns for the page having run them all.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire } = await import(process.env.UNBLENT_KIT);
const { ask, pageLoading } = await import("bus");
const { machine: conversations } = await import("../../conversations/machine.js");

const flush = () => new Promise((r) => setTimeout(r, 20));

// What the server says and the device kept: Values and Choice Points hidden, so an
// asker that read nothing (and so hides nothing) is told apart from one that read it.
const PICTURE = { off: [], hidden: ["choice-points"], released: ["choice-points", "usage", "slip-box"], shown: ["usage", "slip-box"] };
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
// features, or for feature-flags the Show column.
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
  "feature-flags": {},
};
const seen = (name, context) => (name === "feature-flags" ? context.shown : context.hidden);
const read = (name) => (name === "feature-flags" ? PICTURE.shown : PICTURE.hidden);
const unknown = () => null;
const nothing = (name) => (name === "feature-flags" ? null : []);

for (const [name, input] of Object.entries(ASKERS)) {
  test(`${name} takes what flags says whether flags mounts before it or after it`, async () => {
    for (const order of [["flags", name], [name, "flags"]]) {
      const open = pageLoading();
      const { actors, unwire } = await wire(order, { flags, [name]: input });
      try {
        await flush();
        open();
        await flush();
        assert.deepEqual(seen(name, actors[name].getSnapshot().context), read(name), `mounted ${order.join(" then ")}`);
      } finally {
        open();
        unwire();
      }
    }
  });

  test(`${name} on a page without flags knows nothing until the page has loaded, then hides nothing`, async () => {
    const open = pageLoading();
    const { actors, unwire } = await wire([name], { [name]: input });
    try {
      await flush();
      if (name !== "feature-flags") assert.deepEqual(seen(name, actors[name].getSnapshot().context), unknown(name));
      open();
      await flush();
      assert.deepEqual(seen(name, actors[name].getSnapshot().context), nothing(name));
    } finally {
      open();
      unwire();
    }
  });
}
