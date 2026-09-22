import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, merge } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = {
  "settings.edited": JSON.parse(readFileSync(resolve(HERE, "..", "events", "settings.edited.json"), "utf8")),
  "llm.edited": JSON.parse(readFileSync(resolve(HERE, "..", "events", "llm.edited.json"), "utf8")),
  "tools.edited": JSON.parse(readFileSync(resolve(HERE, "..", "events", "tools.edited.json"), "utf8")),
};
// Every event the tests below emit, with the schema it must match (Testing, shape
// test); the final test validates them all.
const recorded = [];

const PAGES = [
  { path: "/a", title: "A", kind: "stem" },
  { path: "/b", title: "B", kind: "stem" },
  { path: "/c", title: "C", kind: "app" },
];

const COMPONENTS = [
  { name: "note-editor", role: "note-editor" },
  { name: "note-editor-cm6", role: "note-editor" },
  { name: "notes", role: null },
];

// The account picture as `llm` answers it (7.7): signed in, on the Echo test
// provider, with Anthropic offered but keyless.
const LLM_PICTURE = {
  signedIn: true,
  provider: "echo",
  providers: [
    { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
    { id: "echo", label: "Echo", keySet: true, needsKey: false },
  ],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: ["default", "low", "medium", "high", "xhigh", "max"],
  ttl: "1h",
};

// The tool vocabulary as `catalog: contracts` gives it (7.7): the queries whose owners
// marked them as tools become switches; a query with no `tool` entry is not a switch. The
// two below sort to books: read, notes: list.
const CONTRACTS = {
  events: [],
  commands: [],
  queries: [
    { target: "notes", name: "list", payload: {}, reply: {}, askers: [], tool: { description: "List the reader's notes.", label: "Reading the notes" } },
    { target: "books", name: "read", payload: {}, reply: {}, askers: [], tool: { description: "Open a book's details.", label: "Opening a book" } },
    { target: "subject", name: "read", payload: {}, reply: {}, askers: [] },
  ],
};

// The tool preferences as `conversations: tools` gives them (7.7): notes off, the rest on
// (a tool missing from the map is on).
const TOOLS = { tools: { "notes: list": false }, approval: "auto" };

// Drive the actor with a fake ask (4.2): pages, then settings, then catalog (list), and —
// only when the account section is shown — llm, the tool contracts and the tool
// preferences. `account` mirrors the tag attribute.
const start = (settings, current = "/a", { account = false, llm = LLM_PICTURE, contracts = CONTRACTS, tools = TOOLS } = {}) => {
  const ask = (target, name) =>
    Promise.resolve(
      target === "pages"
        ? { pages: PAGES }
        : target === "catalog"
          ? name === "contracts"
            ? contracts
            : { components: COMPONENTS }
          : target === "conversations"
            ? tools
            : target === "llm"
              ? llm
              : { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: {}, ...settings },
    );
  const actor = createActor(machine, { input: { ask, current, account } });
  const emitted = [];
  const emittedLlm = [];
  const emittedTools = [];
  actor.on("settings.edited", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: SCHEMAS["settings.edited"] });
  });
  actor.on("llm.edited", (e) => {
    emittedLlm.push(e);
    recorded.push({ value: e, schema: SCHEMAS["llm.edited"] });
  });
  actor.on("tools.edited", (e) => {
    emittedTools.push(e);
    recorded.push({ value: e, schema: SCHEMAS["tools.edited"] });
  });
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready") || s.matches("failed")) resolve({ actor, emitted, emittedLlm, emittedTools, snapshot: s });
    });
    actor.start();
  });
};

test("merge lists nav order first, then unlisted pages, keeping only real pages", () => {
  const rows = merge(PAGES, [
    { path: "/c", hidden: true },
    { path: "/gone", hidden: false },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.path, r.hidden]),
    [
      ["/c", true],
      ["/a", false],
      ["/b", false],
    ],
  );
});

test("a rejected pages load fails the view", async () => {
  const actor = createActor(machine, { input: { ask: () => Promise.reject(new Error("x")), current: "/a" } });
  const s = await new Promise((resolve) => {
    actor.subscribe((snap) => snap.matches("failed") && resolve(snap));
    actor.start();
  });
  assert.equal(s.value, "failed");
});

test("_down materialises the whole order and swaps", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_down", path: "/a" });
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].nav, [
    { path: "/b", hidden: false },
    { path: "/a", hidden: false },
    { path: "/c", hidden: false },
  ]);
});

test("_up at the top and _down at the bottom are guarded out", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_up", path: "/a" });
  actor.send({ type: "_down", path: "/c" });
  assert.equal(emitted.length, 0);
});

test("hiding the current page is guarded out; another page hides", async () => {
  const { actor, emitted } = await start(undefined, "/a");
  actor.send({ type: "_hide", path: "/a" });
  assert.equal(emitted.length, 0, "the sheet's own page keeps no hide control");
  actor.send({ type: "_hide", path: "/b" });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].nav.find((r) => r.path === "/b").hidden, true);
});

test("the switch toggles flip their flag", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_toggleViewport" });
  assert.equal(emitted[0].viewportSwitchHidden, true);
  actor.send({ type: "_toggleLayout" });
  assert.equal(emitted[1].layoutSwitchHidden, true);
});

test("_reset emits the defaults", async () => {
  const { actor, emitted } = await start({ nav: [{ path: "/a", hidden: true }], viewportSwitchHidden: true });
  actor.send({ type: "_reset" });
  assert.deepEqual(emitted[0], {
    type: "settings.edited",
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
    editors: {},
  });
});

test("catalog members are grouped by role", async () => {
  const { snapshot } = await start();
  assert.deepEqual(snapshot.context.roles, { "note-editor": ["note-editor", "note-editor-cm6"] });
});

test("_setEditor emits the whole settings with the role's choice set", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_setEditor", role: "note-editor", component: "note-editor-cm6" });
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].editors, { "note-editor": "note-editor-cm6" });
  // A second choice for another role would merge, not replace: start from the last.
  actor.send({ type: "settings.changed", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: { "note-editor": "note-editor-cm6" } });
  actor.send({ type: "_setEditor", role: "note-editor", component: "note-editor" });
  assert.deepEqual(emitted[1].editors, { "note-editor": "note-editor" });
});

test("the profile is adopted from the read and defaults to workshop", async () => {
  const workshop = await start();
  assert.equal(workshop.snapshot.context.profile, "workshop", "absent profile means workshop");
  const product = await start({ profile: "product" });
  assert.equal(product.snapshot.context.profile, "product");
});

test("settings.changed carries the profile", async () => {
  const { actor } = await start();
  actor.send({
    type: "settings.changed",
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
    profile: "product",
  });
  assert.equal(actor.getSnapshot().context.profile, "product");
});

test("settings.changed is adopted (4.3, fourth rule)", async () => {
  const { actor } = await start();
  actor.send({
    type: "settings.changed",
    nav: [{ path: "/c", hidden: false }],
    viewportSwitchHidden: true,
    layoutSwitchHidden: false,
    arranging: true,
  });
  assert.equal(actor.getSnapshot().context.settings.viewportSwitchHidden, true);
  assert.deepEqual(actor.getSnapshot().context.settings.nav, [{ path: "/c", hidden: false }]);
});

test("without the account attribute the llm picture is never loaded", async () => {
  const { snapshot } = await start();
  assert.equal(snapshot.context.account, false);
  assert.equal(snapshot.context.llm, null, "no account section, no llm ask");
});

test("with the account attribute the llm picture is loaded (7.7)", async () => {
  const { snapshot } = await start(undefined, "/a", { account: true });
  assert.equal(snapshot.context.account, true);
  assert.deepEqual(snapshot.context.llm, LLM_PICTURE);
});

test("a no-answerer or signed-out llm leaves the account picture null", async () => {
  const { snapshot } = await start(undefined, "/a", { account: true, llm: { error: "no-answerer" } });
  assert.equal(snapshot.context.llm, null, "the account section then shows the sign-in line");
});

test("each account gesture emits only the field it changed (7.7)", async () => {
  const { actor, emittedLlm } = await start(undefined, "/a", { account: true });
  actor.send({ type: "_setProvider", provider: "anthropic" });
  assert.deepEqual(emittedLlm[0], { type: "llm.edited", provider: "anthropic" });
  actor.send({ type: "_saveKey", key: "sk-typed" });
  assert.deepEqual(emittedLlm[1], { type: "llm.edited", key: "sk-typed" });
  actor.send({ type: "_removeKey" });
  assert.deepEqual(emittedLlm[2], { type: "llm.edited", key: "" }, "an empty key removes it");
  actor.send({ type: "_setModel", model: "echo" });
  assert.deepEqual(emittedLlm[3], { type: "llm.edited", model: "echo" });
});

test("llm.changed is adopted after the starting ask (4.3)", async () => {
  const { actor } = await start(undefined, "/a", { account: true });
  const next = { ...LLM_PICTURE, provider: "anthropic", model: "claude-opus-5", models: [{ id: "claude-opus-5", label: "Claude Opus 5" }] };
  actor.send({ type: "llm.changed", ...next });
  assert.deepEqual(actor.getSnapshot().context.llm, next);
});

test("without the account attribute the tools are never loaded", async () => {
  const { snapshot } = await start();
  assert.deepEqual(snapshot.context.toolList, [], "no account section, no tool contracts asked");
  assert.deepEqual(snapshot.context.tools, {}, "and no tool preferences");
});

test("with the account attribute the tools are listed and the off ones known (7.7)", async () => {
  const { snapshot } = await start(undefined, "/a", { account: true });
  assert.deepEqual(
    snapshot.context.toolList.map((t) => t.key),
    ["books: read", "notes: list"],
    "the tool queries, sorted by key; a query with no tool entry is left out",
  );
  assert.deepEqual(snapshot.context.toolList[0], { key: "books: read", label: "Opening a book", description: "Open a book's details." });
  assert.deepEqual(snapshot.context.tools, { "notes: list": false }, "the preference map says notes is off, the rest on");
});

test("toggling a tool emits tools.edited with only that switch (7.7)", async () => {
  const { actor, emittedTools } = await start(undefined, "/a", { account: true });
  actor.send({ type: "_toggleTool", key: "books: read", on: false });
  assert.deepEqual(emittedTools[0], { type: "tools.edited", tools: { "books: read": false } });
  actor.send({ type: "_toggleTool", key: "notes: list", on: true });
  assert.deepEqual(emittedTools[1], { type: "tools.edited", tools: { "notes: list": true } });
});

test("tools.changed is adopted after the starting ask (4.3)", async () => {
  const { actor } = await start(undefined, "/a", { account: true });
  actor.send({ type: "tools.changed", tools: { "books: read": false, "notes: list": false }, approval: "auto" });
  assert.deepEqual(actor.getSnapshot().context.tools, { "books: read": false, "notes: list": false });
});

test("an unavailable catalog or tools reply leaves the switches empty", async () => {
  const { snapshot } = await start(undefined, "/a", {
    account: true,
    contracts: { error: "unavailable" },
    tools: { error: "no-answerer" },
  });
  assert.deepEqual(snapshot.context.toolList, [], "no tools listed when the catalog is unavailable");
  assert.deepEqual(snapshot.context.tools, {}, "and the preference map stays empty (all on)");
  assert.ok(snapshot.matches("ready"), "the sheet still reaches ready");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above emitted events");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value)} against its schema: ${JSON.stringify(result.errors?.[0])}`);
  }
});
