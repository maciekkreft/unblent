import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "settings.changed.json");
const READ = json("queries", "read.json").reply;
// Every emit and reply the tests below produce, checked against its schema last.
const recorded = [];

// The actor is where decisions live (3.2): it is driven with fake stores and its
// reply/emit are read directly, so no browser is needed. `stored` is the workshop
// copy (the common case, on a workshop page); `opts` supplies the product page and
// the other stored copies when a test needs them. `saved` records every write
// tagged by which key it landed in, so a test sees a choice stay in one copy.
const start = (stored, opts = {}) => {
  const { product = false, productStored = null, profileStored = null } = opts;
  const saved = { workshop: [], product: [], profile: [] };
  const actor = createActor(machine, {
    input: {
      product,
      stored: { workshop: stored, product: productStored, profile: profileStored },
      save: {
        workshop: (v) => saved.workshop.push(v),
        product: (v) => saved.product.push(v),
        profile: (v) => saved.profile.push(v),
      },
    },
  });
  const emitted = [];
  actor.on("settings.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.start();
  return { actor, saved, emitted };
};

const read = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  recorded.push({ value: reply, schema: READ });
  return reply;
};

test("garbage parses to defaults, arranging on", () => {
  const { actor } = start("not json");
  assert.deepEqual(read(actor), {
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
    vimKeys: false,
    editors: {},
    profile: "workshop",
  });
});

test("settings.edited carrying editors is adopted, sanitised, saved and re-emitted", () => {
  const { actor, saved, emitted } = start(null);
  actor.send({
    type: "settings.edited",
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
    editors: { "note-editor": "note-editor-cm6", junk: 3 },
  });
  const s = read(actor);
  assert.deepEqual(s.editors, { "note-editor": "note-editor-cm6" }, "non-string values are dropped");
  assert.equal(emitted.length, 1);
  assert.equal(saved.workshop.length, 1);
  assert.deepEqual(emitted[0].editors, { "note-editor": "note-editor-cm6" });
});

test("settings.edited dedupes nav by path and applies the invariant", () => {
  const { actor, saved, emitted } = start(null);
  actor.send({
    type: "settings.edited",
    nav: [
      { path: "/a", hidden: true },
      { path: "/a", hidden: false },
      { path: "/b", hidden: false },
    ],
    viewportSwitchHidden: false,
    layoutSwitchHidden: true,
    arranging: true,
  });
  const s = read(actor);
  assert.deepEqual(s.nav, [
    { path: "/a", hidden: true },
    { path: "/b", hidden: false },
  ]);
  assert.equal(s.arranging, false, "a hidden switch forces arranging off");
  assert.equal(emitted.length, 1);
  assert.equal(saved.workshop.length, 1);
  assert.deepEqual({ ...emitted[0], type: undefined }, { ...s, type: undefined });
});

test("unhiding the switch keeps arranging off until the switch turns it on", () => {
  const { actor, emitted } = start(
    JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: true, arranging: false }),
  );
  // The sheet unhides, sending back the arranging it last saw (off).
  actor.send({ type: "settings.edited", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: false });
  assert.equal(read(actor).arranging, false, "unhiding does not turn arranging back on");
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(read(actor).arranging, true);
  assert.equal(emitted.length, 2);
});

test("layout.switched toggles arranging and emits", () => {
  const { actor, emitted } = start(null);
  actor.send({ type: "layout.switched", arranging: false });
  assert.equal(read(actor).arranging, false);
  assert.equal(emitted.length, 1);
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(read(actor).arranging, true);
  assert.equal(emitted.length, 2);
});

test("a hidden switch ignores layout.switched", () => {
  const { actor, emitted } = start(
    JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: true, arranging: false }),
  );
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(read(actor).arranging, false, "the desk stays unarrangeable while the switch is hidden");
  assert.equal(emitted.length, 0);
});

test("layout.switched on a no-op emits and saves nothing", () => {
  const { actor, saved, emitted } = start(null);
  actor.send({ type: "layout.switched", arranging: true });
  assert.equal(emitted.length, 0, "arranging is already on by default");
  assert.equal(saved.workshop.length, 0);
});

test("a repeat write emits and saves nothing", () => {
  const { actor, saved, emitted } = start(null);
  const same = {
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
  };
  actor.send({ type: "settings.edited", ...same });
  assert.equal(emitted.length, 0);
  assert.equal(saved.workshop.length, 0);
});

test("read replies a copy, not the live nav", () => {
  const { actor } = start(JSON.stringify({ nav: [{ path: "/a", hidden: true }] }));
  const a = read(actor);
  a.nav[0].hidden = false;
  assert.equal(read(actor).nav[0].hidden, true, "mutating a reply does not change the fact");
});

test("the product page starts in the product profile with its own defaults", () => {
  const { actor } = start(null, { product: true });
  assert.deepEqual(read(actor), {
    nav: [],
    viewportSwitchHidden: true,
    layoutSwitchHidden: true,
    arranging: false,
    vimKeys: false,
    editors: {},
    profile: "product",
  });
});

test("a workshop page ignores a stored product switch and stays workshop", () => {
  const { actor } = start(null, { product: false, profileStored: "product" });
  assert.equal(read(actor).profile, "workshop");
});

test("switching activates the other copy, persists, and emits it", () => {
  // A product page: product copy has no editor, workshop copy chose one.
  const { actor, saved, emitted } = start(
    JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: { "note-editor": "note-editor-cm6" } }),
    { product: true },
  );
  assert.equal(read(actor).profile, "product");
  assert.deepEqual(read(actor).editors, {}, "the product copy has its own editors");
  actor.send({ type: "profile.switched", profile: "workshop" });
  assert.equal(read(actor).profile, "workshop");
  assert.deepEqual(read(actor).editors, { "note-editor": "note-editor-cm6" }, "the workshop copy comes forward");
  assert.deepEqual(saved.profile, ["workshop"], "the switch is remembered");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].profile, "workshop");
});

test("an edit in one profile never shows in the other", () => {
  const { actor, saved } = start(null, { product: true });
  actor.send({
    type: "settings.edited",
    nav: [],
    viewportSwitchHidden: true,
    layoutSwitchHidden: true,
    arranging: false,
    editors: { "note-editor": "note-editor-cm6" },
  });
  assert.deepEqual(read(actor).editors, { "note-editor": "note-editor-cm6" });
  assert.equal(saved.product.length, 1, "the edit lands in the product copy");
  assert.equal(saved.workshop.length, 0, "the workshop copy is untouched");
  actor.send({ type: "profile.switched", profile: "workshop" });
  assert.deepEqual(read(actor).editors, {}, "the workshop copy never saw the product edit");
});

test("the switch is ignored on a workshop page", () => {
  const { actor, saved, emitted } = start(null, { product: false });
  actor.send({ type: "profile.switched", profile: "product" });
  assert.equal(read(actor).profile, "workshop");
  assert.equal(saved.profile.length, 0);
  assert.equal(emitted.length, 0);
});

test("switching to the already-active profile is a no-op", () => {
  const { actor, saved, emitted } = start(null, { product: true });
  actor.send({ type: "profile.switched", profile: "product" });
  assert.equal(saved.profile.length, 0);
  assert.equal(emitted.length, 0);
});

const edit = (actor, fields) =>
  actor.send({ type: "settings.edited", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, ...fields });

test("vimKeys is stored and announced; a repeat emits nothing", () => {
  const { actor, saved, emitted } = start(null);
  edit(actor, { vimKeys: true });
  assert.equal(read(actor).vimKeys, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].vimKeys, true);
  assert.equal(JSON.parse(saved.workshop[0]).vimKeys, true);
  edit(actor, { vimKeys: true });
  assert.equal(emitted.length, 1, "the same value again is no change");
  edit(actor, { vimKeys: false });
  assert.equal(read(actor).vimKeys, false);
  assert.equal(emitted.length, 2);
});

test("a stored vimKeys survives a reload; anything but true is off", () => {
  assert.equal(read(start(JSON.stringify({ vimKeys: true })).actor).vimKeys, true);
  assert.equal(read(start(JSON.stringify({ vimKeys: "yes" })).actor).vimKeys, false);
  assert.equal(read(start(JSON.stringify({ nav: [] })).actor).vimKeys, false, "a copy from before the switch is off");
});

test("vimKeys turned on in the product never shows in the workshop", () => {
  const { actor, saved } = start(null, { product: true });
  edit(actor, { viewportSwitchHidden: true, layoutSwitchHidden: true, arranging: false, vimKeys: true });
  assert.equal(read(actor).vimKeys, true);
  assert.equal(saved.workshop.length, 0);
  actor.send({ type: "profile.switched", profile: "workshop" });
  assert.equal(read(actor).vimKeys, false, "the workshop copy keeps its own");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
