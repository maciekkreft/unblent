import { mount } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/flags.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): the one place this component touches the network, and only
// to reach its own server module (section 3), and the one place it touches storage.
const store = openStore("flags");

const json = { Accept: "application/json" };
const answer = (res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status))));

const load = () => fetch("/api/flags", { credentials: "same-origin", headers: json }).then(answer);

const save = (feature, on) =>
  fetch("/api/flags", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...json },
    body: JSON.stringify({ feature, on }),
  }).then(answer);

mount(machine, {
  input: { load, save, cached: store.read(), remember: store.write },
  events: { "flags.changed": changed },
  queries: { read },
});
