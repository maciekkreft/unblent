import { mount } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/settings.changed.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is
// the one place that touches localStorage and the URL, so machine.js stays
// importable in Node. Three global keys (3.1, local-only): one copy of the
// preferences per profile plus the stored switch (§12). "settings" stays the
// workshop copy so a device's existing choices carry over.
const workshop = openStore("settings");
const product = openStore("settings", "product");
const profile = openStore("settings", "profile");

// The profile a non-workshop page starts in is product; a page under /workshop/ is
// always workshop (§12), read from the URL like dock reads location.pathname.
const onProduct = !location.pathname.startsWith("/workshop/");

mount(machine, {
  input: {
    product: onProduct,
    stored: { workshop: workshop.read(), product: product.read(), profile: profile.read() },
    save: { workshop: workshop.write, product: product.write, profile: profile.write },
  },
  events: { "settings.changed": changed },
  queries: { read },
});
