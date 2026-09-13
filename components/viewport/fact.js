import { mount } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/viewport.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is
// the one place that touches localStorage and the document, so machine.js stays
// importable in Node. Module-level, so the attribute lands before Lit renders.
const store = openStore("viewport");

// Section 7.5: the one place in the system that writes this fact to the document,
// and it writes only data-viewport on <html>.
const apply = (viewport) => {
  document.documentElement.dataset.viewport = viewport;
};

mount(machine, {
  input: { stored: store.read(), save: store.write, apply },
  events: { "viewport.changed": changed },
  queries: { read },
});
