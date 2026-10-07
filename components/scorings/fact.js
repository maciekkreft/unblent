import { mount } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/scoring.changed.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is the
// one place that touches localStorage, so machine.js stays importable in Node.
const store = openStore("scorings");

mount(machine, {
  input: { stored: store.read(), save: store.write },
  events: { "scoring.changed": changed },
  queries: { list, read },
});
