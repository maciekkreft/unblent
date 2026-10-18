import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/pins.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): the one place pins touches localStorage, so machine.js stays
// importable in Node.
const store = openStore("pins");

mount(machine, {
  input: { stored: store.read(), save: store.write, ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "pins.changed": changed },
  queries: { read },
});
