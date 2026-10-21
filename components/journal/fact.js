import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openJournal } from "./store.js";
import changed from "./events/journal.changed.json" with { type: "json" };
import conflicted from "./events/journal.conflicted.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };
import open from "./queries/open.json" with { type: "json" };
import days from "./queries/days.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs, the IndexedDB store, the
// clock, the bus's ask and the sync `api`, and mounts it, so machine.js stays importable
// in Node. The api reports 401 as unauthorized and 409 as a conflict; anything else that
// fails throws, which the machine treats as a network error and retries on the next
// trigger (5).

// keepalive lets a write finish after the page is gone, which is what makes the
// hidden-tab drain reach the server (5); the browser caps keepalive bodies at 64 KiB in
// total, so it is asked for only while hidden and only for a small record.
const KEEPALIVE_MAX_BYTES = 32 * 1024;

const api = {
  async put(row) {
    const body = JSON.stringify({ record: row.record, baseVersion: row.baseVersion, deleted: Boolean(row.deleted) });
    const res = await fetch(`/api/journal/${row.table}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body,
      keepalive: document.visibilityState === "hidden" && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (res.status === 409) return { conflict: true, record: (await res.json()).record };
    if (!res.ok) throw new Error(`journal put ${res.status}`);
    return await res.json();
  },
  async pull(since) {
    const res = await fetch(`/api/journal?since=${since}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`journal pull ${res.status}`);
    return await res.json();
  },
};

const actor = mount(machine, {
  input: { store: openJournal(), now: () => Date.now(), api, ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "journal.changed": changed, "journal.conflicted": conflicted },
  queries: { read, open, days },
});

// A tab regaining focus drains then pulls, which is how a day written on another device
// arrives; a tab going to the background drains without a pull, so another device finds
// the latest copy (5). Reading visibilityState is a read of the document, allowed to any
// component; the machine only receives the message.
document.addEventListener("visibilitychange", () => actor.send({ type: "_sync", pull: document.visibilityState === "visible" }));
