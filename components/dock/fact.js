import { mount } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/dock.changed.json" with { type: "json" };
import recorded from "./events/step.recorded.json" with { type: "json" };
import settled from "./events/step.settled.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is
// the one place that touches localStorage, so machine.js stays importable in Node.
// The layout is scoped to this page (3.1, local-only): the app desk and the
// /workshop/design/dock stem each remember their own arrangement.
const store = openStore("dock", location.pathname);
// The step that last arranged this desk (12, Undo), kept beside it.
const stamp = openStore("dock", "step:" + location.pathname);

mount(machine, {
  input: { stored: store.read(), save: store.write, stamp: stamp.read(), load: store.read, stampLoad: stamp.read, stampSave: stamp.write },
  events: { "dock.changed": changed, "step.recorded": recorded, "step.settled": settled },
  queries: { read },
});
