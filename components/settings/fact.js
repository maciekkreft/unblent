import { mount } from "bus";
import { machine } from "./machine.js";
import { openStore } from "./store.js";
import changed from "./events/settings.changed.json" with { type: "json" };
import recorded from "./events/step.recorded.json" with { type: "json" };
import settled from "./events/step.settled.json" with { type: "json" };
import read from "./queries/read.json" with { type: "json" };

// The browser entry (3.2): builds the machine's real inputs and mounts it. This is
// the one place that touches localStorage and the URL, so machine.js stays
// importable in Node. Three global keys (3.1, local-only): one copy of the
// preferences per profile plus the stored switch (§12). "settings" stays the
// workshop copy so a device's existing choices carry over.
const workshop = openStore("settings");
const product = openStore("settings", "product");
const profile = openStore("settings", "profile");
// The step that last wrote each copy (12, Undo), kept beside it.
const stamp = { workshop: openStore("settings", "step"), product: openStore("settings", "product:step") };

// An app page (/ or under /workshop/apps/) starts in product; a design page, under
// /workshop/design/, is always workshop (§12), read from the URL like dock reads
// location.pathname.
const onProduct = !location.pathname.startsWith("/workshop/design/");
// A try page is always in the product (8): the stored switch is not read there, so a
// device left in the workshop still shows a visitor's page as the visitor sees it.
const onTry = location.pathname.startsWith("/try/");

mount(machine, {
  input: {
    product: onProduct,
    stored: { workshop: workshop.read(), product: product.read(), profile: onTry ? null : profile.read() },
    save: { workshop: workshop.write, product: product.write, profile: profile.write },
    stamps: { workshop: stamp.workshop.read(), product: stamp.product.read() },
    load: { workshop: workshop.read, product: product.read },
    stampLoad: { workshop: stamp.workshop.read, product: stamp.product.read },
    stampSave: { workshop: stamp.workshop.write, product: stamp.product.write },
  },
  events: { "settings.changed": changed, "step.recorded": recorded, "step.settled": settled },
  queries: { read },
});
