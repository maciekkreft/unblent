import { mount, tap } from "bus";
import { ulid } from "ulid";
import { machine } from "./machine.js";
import { openChannel } from "./store.js";
import recorded from "./events/trace.recorded.json" with { type: "json" };
import list from "./queries/list.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is
// the one place that touches the bus tap, the channel, and the console, so
// machine.js stays importable in Node.
const tab = ulid();
const channel = openChannel("trace");

// A new tab announces itself so the tabs already open share their history (the
// _hello / buffer handshake in machine.js). Own posts do not come back, so hello
// reaches only the others.
channel.post({ type: "hello", tab });

mount(machine, {
  input: {
    tab,
    tap,
    subscribe: (fn) => channel.subscribe(fn),
    publish: (record) => channel.post({ type: "record", record }),
    share: (records) => channel.post({ type: "buffer", records }),
    print: (text) => console.debug(text),
  },
  events: { "trace.recorded": recorded },
  queries: { list },
});
