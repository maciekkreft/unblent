import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/decision.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is the
// one place that touches localStorage, the clock and the bus's ask, so machine.js stays
// importable in Node.
const store = openStore("decisions");

mount(machine, {
  input: {
    stored: store.read(),
    save: store.write,
    now: () => Date.now(),
    ask: (target, name, payload) => ask(machine, target, name, payload),
  },
  events: { "decision.changed": changed },
  queries: { read },
});
