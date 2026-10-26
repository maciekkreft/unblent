import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openValueChecks } from "./store.js";
import changed from "./events/value-checks.changed.json" with { type: "json" };
import checked from "./events/values.checked.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs — the IndexedDB store and
// the sync `api` — and mounts it, so machine.js stays importable in Node. The api
// reports 401 as unauthorized; anything else that fails throws, which the machine
// treats as a network error and retries on the next trigger (5). A page loads this
// after the entries of evaluators, values and llm, so they answer its first asks, and
// before journal-entry's, so the first day.shown reaches it.
const store = openValueChecks();

// keepalive lets a PUT finish after the page is gone, which is what makes the
// hidden-tab drain reach the server (5); the browser caps keepalive bodies at 64 KiB
// in total, so it is asked for only while hidden and only for a small row.
const KEEPALIVE_MAX_BYTES = 32 * 1024;

const send = async (url, payload) => {
  const body = JSON.stringify(payload);
  const res = await fetch(url, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body,
    keepalive: document.visibilityState === "hidden" && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
  });
  if (res.status === 401) return { error: "unauthorized" };
  if (!res.ok) throw new Error(`value-checks put ${res.status}`);
  return await res.json();
};

const api = {
  put(row) {
    if (row.kind === "answer") return send(`/api/value-checks/answers/${row.key}`, { answers: row.answers });
    const { values, examples, baseVersion } = row;
    return send("/api/value-checks/settings", { values, examples, baseVersion });
  },
  async pull(since) {
    const res = await fetch(`/api/value-checks?since=${since}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`value-checks pull ${res.status}`);
    return await res.json();
  },
};

const actor = mount(machine, {
  input: { store, api, ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "value-checks.changed": changed, "values.checked": checked },
  queries: { read },
});

// A tab regaining focus drains then pulls, which is how a setting or an answer made on
// another device arrives; a tab going hidden drains without a pull (5).
document.addEventListener("visibilitychange", () =>
  actor.send({ type: "_sync", pull: document.visibilityState === "visible" }),
);
