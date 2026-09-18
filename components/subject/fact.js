import { mount, ask } from "bus";
import { machine } from "./machine.js";
import changed from "./events/subject.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): a derived fact stores nothing, so its only real input is
// the bus `ask` it uses to read `dock` and `books` and to follow their events. This
// keeps machine.js importable in Node, where a test passes a stub ask.
mount(machine, {
  input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
  events: { "subject.changed": changed },
  queries: { read },
});
