import { mount, ask, answers } from "bus";
import { monotonicFactory } from "ulid";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/conversation.changed.json" with { type: "json" };
import deleted from "./events/conversation.deleted.json" with { type: "json" };
import opened from "./events/conversation.opened.json" with { type: "json" };
import toolsChanged from "./events/tools.changed.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };
import open from "./queries/open.json" with { type: "json" };
import tools from "./queries/tools.json" with { type: "json" };

// Every script of the page has run once DOMContentLoaded has fired, so by then every
// fact the page holds is mounted (8); a script that runs later finds it fired already.
const loaded = () => {
  const navigation = performance.getEntriesByType("navigation")[0];
  if (navigation ? navigation.domContentLoadedEventStart > 0 : document.readyState !== "loading") return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
};

// The browser entry (3.2): the one place this component touches the network, and only
// to reach its own server module (section 3) or, over the bus, the facts it asks. All
// fetch, the id source, the store and the browser signals live here, so machine.js
// stays a pure definition importable in Node.

const BASE = "/api/conversations";
const json = { Accept: "application/json" };

const getJson = async (path) => {
  const res = await fetch(path, { credentials: "same-origin", headers: json });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

const putJson = async (path, body) => {
  const res = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...json },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

// Focus and online, the two moments the fact re-syncs (5): a chat continued on another
// device appears on focus, and an unsent turn is retried when the connection returns.
const subscribe = (send) => {
  const onVisible = () => {
    if (document.visibilityState === "visible") send("_focus");
  };
  const onOnline = () => send("_online");
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
  };
};

mount(machine, {
  input: {
    session: () => ask(machine, "session", "read", {}),
    subject: () => ask(machine, "subject", "read", {}),
    settings: () => ask(machine, "settings", "read", {}),
    flags: () => ask(machine, "flags", "read", {}),
    loaded,
    complete: (request) => ask(machine, "llm", "complete", request),
    // The tool list (catalog: contracts) and each tool call (the `*: tool` wildcard, 7.7).
    contracts: () => ask(machine, "catalog", "contracts", {}),
    askTool: (target, name, payload) => ask(machine, target, name, payload),
    answered: answers,
    list: () => getJson(BASE),
    read: (id) => getJson(`${BASE}/${id}`),
    saveChat: (id, body) => putJson(`${BASE}/${id}`, body),
    deleteChat: async (id) => {
      const res = await fetch(`${BASE}/${id}`, { method: "DELETE", credentials: "same-origin", headers: json });
      if (!res.ok) throw new Error(String(res.status));
    },
    saveTools: (body) => putJson(`${BASE}/tools`, body),
    store: openStore("conversations"),
    ulid: monotonicFactory(),
    now: () => Date.now(),
    subscribe,
  },
  events: {
    "conversation.changed": changed,
    "conversation.deleted": deleted,
    "conversation.opened": opened,
    "tools.changed": toolsChanged,
  },
  queries: { list, read, open, tools },
});
