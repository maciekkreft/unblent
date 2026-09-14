import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openNotes } from "./store.js";
import changed from "./events/note.changed.json" with { type: "json" };
import deleted from "./events/note.deleted.json" with { type: "json" };
import conflicted from "./events/note.conflicted.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store,
// the clock, and the passkey-gated sync `api` — and mounts it, so machine.js stays
// importable in Node. The api reports 401 as unauthorized and 409 as a conflict;
// anything else that fails throws, which the machine treats as a network error and
// retries on the next trigger (5).
const store = openNotes();

const api = {
  async put(row) {
    const res = await fetch(`/api/notes/${row.id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ title: row.title, body: row.body, baseVersion: row.baseVersion }),
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (res.status === 409) return { conflict: true, note: (await res.json()).note };
    if (!res.ok) throw new Error(`notes put ${res.status}`);
    return await res.json();
  },
  async pull(since) {
    const res = await fetch(`/api/notes?since=${since}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`notes pull ${res.status}`);
    return await res.json();
  },
};

const actor = mount(machine, {
  input: { store, now: () => Date.now(), api, ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "note.changed": changed, "note.deleted": deleted, "note.conflicted": conflicted },
  queries: { list, read },
});

// On mount the machine already reconciles; on focus, reconcile again (5): this is
// how an edit made on another device arrives. Reading visibilityState is a read of
// the document, allowed to any component; the machine only receives the message.
document.addEventListener(
  "visibilitychange",
  () => document.visibilityState === "visible" && actor.send({ type: "_sync" }),
);
