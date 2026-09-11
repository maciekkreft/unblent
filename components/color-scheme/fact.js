import { mount } from "bus";
import { machine } from "./machine.js";
import changed from "./events/color-scheme.changed.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. All
// environment access lives here, so machine.js stays importable in Node.
const query = window.matchMedia("(prefers-color-scheme: dark)");

const media = {
  get matches() {
    return query.matches;
  },
  subscribe(fn) {
    const handler = (event) => fn(event.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  },
};

// Section 7.5: the one place in the system that writes to the document, and it
// writes only data-color-scheme on <html>.
const apply = (scheme) => {
  document.documentElement.dataset.colorScheme = scheme;
};

mount(machine, { input: { media, apply }, events: { "color-scheme.changed": changed } });
