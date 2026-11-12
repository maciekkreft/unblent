import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openMatrices } from "./store.js";
import changed from "./events/matrix.changed.json" with { type: "json" };
import deleted from "./events/matrix.deleted.json" with { type: "json" };
import recorded from "./events/step.recorded.json" with { type: "json" };
import settled from "./events/step.settled.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store and
// the sync `api` — and mounts it, so machine.js stays importable in Node. The api
// reports 401 as unauthorized; anything else that fails throws, which the machine
// treats as a network error and retries on the next trigger (5).
const store = openMatrices();

// keepalive lets a PUT finish after the page is gone, which is what makes the
// hidden-tab drain reach the server (5); the browser caps keepalive bodies at 64 KiB
// in total, so it is asked for only while hidden and only for a short matrix.
const KEEPALIVE_MAX_BYTES = 32 * 1024;

const api = {
  async put(row) {
    const { id, ...payload } = row;
    const body = JSON.stringify({ ...payload, deleted: Boolean(row.deleted) });
    const res = await fetch(`/api/matrices/${id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body,
      keepalive: document.visibilityState === "hidden" && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`matrices put ${res.status}`);
    return await res.json();
  },
  async pull(since) {
    const res = await fetch(`/api/matrices?since=${since}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`matrices pull ${res.status}`);
    return await res.json();
  },
};

const actor = mount(machine, {
  input: { store, api, ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "matrix.changed": changed, "matrix.deleted": deleted, "step.recorded": recorded, "step.settled": settled },
  queries: { list },
});

// A tab regaining focus drains then pulls, which is how an edit made on another device
// arrives; a tab going hidden drains without a pull, so another device finds the
// latest copy (5).
document.addEventListener("visibilitychange", () =>
  actor.send({ type: "_sync", pull: document.visibilityState === "visible" }),
);
