import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openUsage } from "./store.js";
import summary from "./queries/summary.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store and
// the `api` to its own server module — and mounts it, so machine.js stays importable in
// Node. The api reports 401 as unauthorized; anything else that fails throws, which the
// machine treats as offline and retries at the next trigger (5).
const store = openUsage();

// keepalive lets a PUT finish after the page is gone, which is what makes the
// hidden-tab drain reach the server (5); the browser caps keepalive bodies at 64 KiB
// in total, so it is asked for only while hidden and only for a small batch.
const KEEPALIVE_MAX_BYTES = 32 * 1024;

const api = {
  async put(totals) {
    const body = JSON.stringify({ totals });
    const res = await fetch("/api/usage", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body,
      keepalive: document.visibilityState === "hidden" && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`usage put ${res.status}`);
    return await res.json();
  },
  async summary(who) {
    const res = await fetch(`/api/usage/summary?who=${encodeURIComponent(who)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return { error: "signed-out" };
    if (res.status === 403) return { error: "not-admin" };
    if (!res.ok) throw new Error(`usage summary ${res.status}`);
    return await res.json();
  },
};

const actor = mount(machine, {
  input: { store, api, ask: (target, name, payload) => ask(machine, target, name, payload) },
  queries: { summary },
});

// A tab regaining focus, or the network coming back, sends what was counted meanwhile;
// a tab going hidden sends at once, so the account has the latest totals (5). Each
// contacts the server only when the outbox holds a row.
document.addEventListener("visibilitychange", () => actor.send({ type: "_sync" }));
addEventListener("online", () => actor.send({ type: "_sync" }));
