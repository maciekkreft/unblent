import { mount } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/dock.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is
// the one place that touches localStorage, so machine.js stays importable in Node.
// The layout is scoped to this page (3.1, local-only): the app desk and the
// /workshop/design/dock stem each remember their own arrangement.
const store = openStore("dock", location.pathname);

mount(machine, {
  input: { stored: store.read(), save: store.write },
  events: { "dock.changed": changed },
  queries: { read },
});
