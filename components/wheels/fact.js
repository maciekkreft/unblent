import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openWheels } from "./store.js";
import changed from "./events/wheel.changed.json" with { type: "json" };
import deleted from "./events/wheel.deleted.json" with { type: "json" };
import recorded from "./events/step.recorded.json" with { type: "json" };
import settled from "./events/step.settled.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store and
// the sync `api` — and mounts it, so machine.js stays importable in Node. The api
// reports 401 as unauthorized; anything else that fails throws, which the machine
// treats as a network error and retries on the next trigger (5).
const store = openWheels();

const api = {
  async put(row) {
    const { id, ...payload } = row;
    const res = await fetch(`/api/wheels/${id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...payload, deleted: Boolean(row.deleted) }),
      // Lets a PUT finish after the page is gone, which is what makes the hidden-tab drain
      // reach the server (5); a wheel is far below the browser's 64 KiB cap on such a body.
      keepalive: document.visibilityState === "hidden",
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`wheels put ${res.status}`);
    return await res.json();
  },
  async pull(since) {
    const res = await fetch(`/api/wheels?since=${since}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`wheels pull ${res.status}`);
    return await res.json();
  },
};

const actor = mount(machine, {
  input: { store, api, ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "wheel.changed": changed, "wheel.deleted": deleted, "step.recorded": recorded, "step.settled": settled },
  queries: { list },
});

// A tab regaining focus drains then pulls, which is how an edit made on another device
// arrives; a tab going hidden drains without a pull, so another device finds the
// latest copy (5).
document.addEventListener("visibilitychange", () =>
  actor.send({ type: "_sync", pull: document.visibilityState === "visible" }),
);
