import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openGenerators } from "./store.js";
import generatorChanged from "./events/generator.changed.json" with { type: "json" };
import generationChanged from "./events/generation.changed.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };
import results from "./queries/results.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store and
// the sync `api` — and mounts it, so machine.js stays importable in Node. The api
// reports 401 as unauthorized; anything else that fails throws, which the machine
// treats as a network error and retries on the next trigger (5).
const store = openGenerators();

// keepalive lets a PUT finish after the page is gone, which is what makes the
// hidden-tab drain reach the server (5); the browser caps keepalive bodies at 64 KiB
// in total, so it is asked for only while hidden and only for a small record.
const KEEPALIVE_MAX_BYTES = 32 * 1024;

const api = {
  async put(row) {
    const { id, ...payload } = row;
    const kind = id.includes(":") ? "results" : "generators";
    const body = JSON.stringify(payload);
    const res = await fetch(`/api/generators/${kind}/${encodeURIComponent(id)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body,
      keepalive: document.visibilityState === "hidden" && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`generators put ${res.status}`);
    return await res.json();
  },
  async pull(since) {
    const res = await fetch(`/api/generators?since=${since}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`generators pull ${res.status}`);
    return await res.json();
  },
};

// A try page (8) runs no generator: the engine reads this.
const tryPage = location.pathname.startsWith("/try/");

const actor = mount(machine, {
  input: { store, api, tryPage, ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "generator.changed": generatorChanged, "generation.changed": generationChanged },
  queries: { list, results },
});

// A tab regaining focus drains then pulls, which is how an edit made on another device
// arrives; a tab going hidden drains without a pull, so another device finds the
// latest copy (5).
document.addEventListener("visibilitychange", () =>
  actor.send({ type: "_sync", pull: document.visibilityState === "visible" }),
);
