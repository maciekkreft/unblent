import { mount } from "bus";
import { machine } from "./machine.js";
import { openNotes } from "./store.js";
import changed from "./events/note.changed.json" with { type: "json" };
import deleted from "./events/note.deleted.json" with { type: "json" };
import conflicted from "./events/note.conflicted.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store
// and the clock — and mounts it, so machine.js stays importable in Node.
mount(machine, {
  input: { store: openNotes(), now: () => Date.now() },
  events: { "note.changed": changed, "note.deleted": deleted, "note.conflicted": conflicted },
  queries: { list, read },
});
