import { mount, ask } from "bus";
import { machine } from "./machine.js";
import { openUndo } from "./store.js";
import undone from "./events/step.undone.json" with { type: "json" };
import redone from "./events/step.redone.json" with { type: "json" };
import settled from "./events/step.settled.json" with { type: "json" };
import dropped from "./events/step.dropped.json" with { type: "json" };
import changed from "./events/undo.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): the IndexedDB store and the channel to the other tabs, so
// machine.js stays importable in Node. A tab that changed the steps says which account's;
// every other tab holding that account reads them again (12, Undo).
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("undo") : null;

const actor = mount(machine, {
  input: {
    store: openUndo(),
    ask: (target, name, payload) => ask(machine, target, name, payload),
    tell: (account) => channel?.postMessage({ account }),
  },
  events: {
    "step.undone": undone,
    "step.redone": redone,
    "step.settled": settled,
    "step.dropped": dropped,
    "undo.changed": changed,
  },
  queries: { read },
});

channel?.addEventListener("message", (message) => {
  if (message.data?.account === actor.getSnapshot().context.account) actor.send({ type: "_reread" });
});
