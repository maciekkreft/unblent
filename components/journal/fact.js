import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openJournal } from "./store.js";
import changed from "./events/journal.changed.json" with { type: "json" };
import conflicted from "./events/journal.conflicted.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs, the IndexedDB store, the
// clock and the bus's ask, and mounts it, so machine.js stays importable in Node.
mount(machine, {
  input: { store: openJournal(), now: () => Date.now(), ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "journal.changed": changed, "journal.conflicted": conflicted },
  queries: { read },
});
