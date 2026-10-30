import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, merge, checksShown, ollamaView, addressOf } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = {
  "settings.edited": JSON.parse(readFileSync(resolve(HERE, "..", "events", "settings.edited.json"), "utf8")),
  "llm.edited": JSON.parse(readFileSync(resolve(HERE, "..", "events", "llm.edited.json"), "utf8")),
  "tools.edited": JSON.parse(readFileSync(resolve(HERE, "..", "events", "tools.edited.json"), "utf8")),
  "checks.edited": JSON.parse(readFileSync(resolve(HERE, "..", "events", "checks.edited.json"), "utf8")),
};
// Every event the tests below emit, with the schema it must match (Testing, shape
// test); the final test validates them all.
const recorded = [];

const PAGES = [
  { path: "/a", title: "A", kind: "stem" },
  { path: "/b", title: "B", kind: "stem" },
  { path: "/c", title: "C", kind: "app" },
];

// The real editors declare no role today; the made-up pair stands in for a future role
// so the grouping and the choice are still tested.
const COMPONENTS = [
  { name: "note-editor", role: null },
  { name: "highlight-notes", role: null },
  { name: "notes", role: null },
];
const WITH_ROLE = [
  ...COMPONENTS,
  { name: "example-a", role: "example-role" },
  { name: "example-b", role: "example-role" },
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
    { target: "evaluators", name: "active", payload: {}, reply: {}, askers: [], tool: { description: "List the evaluators.", label: "Listing your evaluators", switch: false } },
  ],
};

// The tool preferences as `conversations: tools` gives them (7.7): notes off, the rest on
// (a tool missing from the map is on).
const TOOLS = { tools: { "notes: list": false }, approval: "auto" };

// Drive the actor with a fake ask (4.2): pages, then settings, then catalog (list), and —
// only when the account section is shown — llm, the tool contracts and the tool
// preferences. `account` mirrors the tag attribute.
const start = (
  settings,
  current = "/a",
  { account = false, llm = LLM_PICTURE, contracts = CONTRACTS, tools = TOOLS, components = COMPONENTS, checks = { error: "no-answerer" }, evaluators = { evaluators: [] }, clock } = {},
) => {
  const ask = (target, name) =>
    Promise.resolve(
      target === "choice-point-checks"
        ? checks
        : target === "evaluators"
          ? evaluators
          : target === "pages"
        ? { pages: PAGES }
        : target === "catalog"
          ? name === "contracts"
            ? contracts
            : { components }
          : target === "conversations"
            ? tools
            : target === "llm"
              ? llm
              : { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: {}, ...settings },
    );
  const actor = createActor(machine, { input: { ask, current, account, undoMs: 3000 }, ...(clock ? { clock } : {}) });
  const emitted = [];
  const emittedLlm = [];
  const emittedTools = [];
  const emittedChecks = [];
  actor.on("checks.edited", (e) => {
    emittedChecks.push(e);
    recorded.push({ value: e, schema: SCHEMAS["checks.edited"] });
  });
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
      if (s.matches("ready") || s.matches("failed")) resolve({ actor, emitted, emittedLlm, emittedTools, emittedChecks, snapshot: s });
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
  actor.send({ type: "_toggleVim" });
  assert.equal(emitted[2].vimKeys, true);
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
    vimKeys: false,
    editors: {},
  });
});

test("catalog members are grouped by role", async () => {
  assert.deepEqual((await start()).snapshot.context.roles, {}, "no real editor declares a role");
  const { snapshot } = await start(undefined, "/a", { components: WITH_ROLE });
  assert.deepEqual(snapshot.context.roles, { "example-role": ["example-a", "example-b"] });
});

test("_setEditor emits the whole settings with the role's choice set", async () => {
  const { actor, emitted } = await start(undefined, "/a", { components: WITH_ROLE });
  actor.send({ type: "_setEditor", role: "example-role", component: "example-b" });
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].editors, { "example-role": "example-b" });
  // A second choice for another role would merge, not replace: start from the last.
  actor.send({ type: "settings.changed", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: { "example-role": "example-b" } });
  actor.send({ type: "_setEditor", role: "example-role", component: "example-a" });
  assert.deepEqual(emitted[1].editors, { "example-role": "example-a" });
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

test("vimKeys is adopted from the read and from settings.changed, missing means off", async () => {
  assert.equal((await start()).snapshot.context.settings.vimKeys, false);
  const { actor, snapshot, emitted } = await start({ vimKeys: true });
  assert.equal(snapshot.context.settings.vimKeys, true);
  actor.send({ type: "settings.changed", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: false });
  assert.equal(actor.getSnapshot().context.settings.vimKeys, false);
  actor.send({ type: "settings.changed", nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });
  actor.send({ type: "_toggleViewport" });
  assert.equal(emitted[0].vimKeys, true, "another gesture carries vimKeys along");
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
  actor.send({ type: "_setModel", model: "echo" });
  assert.deepEqual(emittedLlm[2], { type: "llm.edited", model: "echo" });
});

test("the Jev key gestures emit only jevKey, and an empty one removes it", async () => {
  const { actor, emittedLlm } = await start(undefined, "/a", { account: true });
  actor.send({ type: "_saveJevKey", key: "jev-typed" });
  assert.deepEqual(emittedLlm[0], { type: "llm.edited", jevKey: "jev-typed" });
  actor.send({ type: "llm.changed", ...LLM_PICTURE, jev: { keySet: true } });
  assert.deepEqual(actor.getSnapshot().context.llm.jev, { keySet: true }, "whether a Jev key is saved is adopted");
});

test("the thinking effort and cache lifetime each emit only their field (§13)", async () => {
  const { actor, emittedLlm } = await start(undefined, "/a", { account: true });
  actor.send({ type: "_setEffort", effort: "high" });
  assert.deepEqual(emittedLlm[0], { type: "llm.edited", effort: "high" });
  actor.send({ type: "_setTtl", ttl: "5m" });
  assert.deepEqual(emittedLlm[1], { type: "llm.edited", ttl: "5m" });
});

test("llm.changed is adopted after the starting ask (4.3)", async () => {
  const { actor } = await start(undefined, "/a", { account: true });
  const next = { ...LLM_PICTURE, provider: "anthropic", model: "claude-opus-5", models: [{ id: "claude-opus-5", label: "Claude Opus 5" }] };
  actor.send({ type: "llm.changed", ...next });
  assert.deepEqual(actor.getSnapshot().context.llm, next);
});

// The Mac app's picture (3.4): Ollama chosen, running, with the address it answered at.
const OLLAMA_PICTURE = {
  signedIn: true,
  provider: "ollama",
  providers: [
    { id: "ollama", label: "Ollama", keySet: true, needsKey: false },
    { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
  ],
  model: "lfm3:latest",
  models: [
    { id: "gemma3:latest", label: "gemma3" },
    { id: "lfm3:latest", label: "lfm3" },
  ],
  effort: "on",
  efforts: ["on", "off"],
  ttl: "1h",
  ollama: { address: "http://localhost:11434", running: true },
};

test("the Ollama rows say running, not running, or that lfm3 is missing (3.4)", () => {
  assert.equal(ollamaView(LLM_PICTURE), null, "no ollama in the picture, no rows");
  assert.deepEqual(ollamaView(OLLAMA_PICTURE), { address: "localhost:11434", running: true, lfm3Missing: false });
  const off = { ...OLLAMA_PICTURE, models: [], model: "", ollama: { address: "http://localhost:11434", running: false } };
  assert.equal(ollamaView(off).running, false);
  assert.equal(ollamaView(off).lfm3Missing, false, "not running says only that");
  assert.equal(ollamaView({ ...OLLAMA_PICTURE, models: [{ id: "gemma3:latest", label: "gemma3" }] }).lfm3Missing, true);
});

test("Change address saves the typed address with its scheme, and Try again re-sends the current one", async () => {
  assert.equal(addressOf(" localhost:9999 "), "http://localhost:9999");
  assert.equal(addressOf("https://box.local:11434"), "https://box.local:11434");
  assert.equal(addressOf(""), "", "empty brings back the default");
  const { actor, emittedLlm } = await start(undefined, "/a", { account: true, llm: OLLAMA_PICTURE });
  actor.send({ type: "_setAddress", address: "localhost:9999" });
  assert.deepEqual(emittedLlm[0], { type: "llm.edited", address: "http://localhost:9999" });
  actor.send({ type: "_retryOllama" });
  assert.deepEqual(emittedLlm[1], { type: "llm.edited", address: "http://localhost:11434" });
  actor.send({ type: "llm.changed", ...OLLAMA_PICTURE, ollama: { address: "http://localhost:9999", running: false } });
  assert.deepEqual(actor.getSnapshot().context.llm.ollama, { address: "http://localhost:9999", running: false }, "adopted");
});

test("without the account attribute the tools are never loaded", async () => {
  const { snapshot } = await start();
  assert.deepEqual(snapshot.context.toolList, [], "no account section, no tool contracts asked");
  assert.deepEqual(snapshot.context.tools, {}, "and no tool preferences");
});

test("the Vim keys list names the chat box only where conversations answers", async () => {
  assert.equal((await start(undefined, "/a", { account: true })).snapshot.context.chat, true);
  const without = await start(undefined, "/a", { account: true, tools: { error: "no-answerer" } });
  assert.equal(without.snapshot.context.chat, false, "a page without a chat, such as the Mac page");
  assert.equal((await start()).snapshot.context.chat, false, "no account section, no chat asked");
});

test("with the account attribute the tools are listed and the off ones known (7.7)", async () => {
  const { snapshot } = await start(undefined, "/a", { account: true });
  assert.deepEqual(
    snapshot.context.toolList.map((t) => t.key),
    ["books: read", "notes: list"],
    "the tool queries, sorted by key; a query with no tool entry, or one that is always on, is left out",
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

// The choice point checks: one evaluator of two questions, a pick then a yes / no, and
// all four boxes unset, as `choice-point-checks: read` gives them without a day.
const E1 = "01HZZZZZZZZZZZZZZZZZZZZZE1";
const E2 = "01HZZZZZZZZZZZZZZZZZZZZZE2";
const Q1 = "01HZZZZZZZZZZZZZZZZZZZZZQ1";
const Q2 = "01HZZZZZZZZZZZZZZZZZZZZZQ2";
const Q3 = "01HZZZZZZZZZZZZZZZZZZZZZQ3";
const Q4 = "01HZZZZZZZZZZZZZZZZZZZZZQ4";
const YV = "0000000000000000000000YVAS";
const BEH = "01HZZZZZZZZZZZZZZZZZZZZZ0B";
const EMO = "01HZZZZZZZZZZZZZZZZZZZZZ0E";
const BOOK = "01HZZZZZZZZZZZZZZZZZZZZB00";
const question = (id, kind, options = []) => ({ id, kind, text: id, yes: "", no: "", options });
const EVALUATORS = [
  {
    id: E1,
    book: BOOK,
    name: "Therapy Goal",
    on: true,
    questions: [
      question(Q1, "pick", [
        { id: BEH, name: "Behavioral Goal", description: "" },
        { id: EMO, name: "Emotional Goal", description: "" },
      ]),
      question(Q2, "yesno"),
    ],
    version: 1,
    pending: false,
    removing: false,
  },
  { id: E2, book: BOOK, name: "Other", on: true, questions: [question(Q3, "yesno")], version: 1, pending: false, removing: false },
];
const unsetBox = { evaluator: null, questions: [] };
const CHECKS = { settings: { away: unsetBox, towards: unsetBox, situation: unsetBox, thoughts: unsetBox }, choicePoints: [] };
const withChecks = { account: true, checks: CHECKS, evaluators: { evaluators: EVALUATORS } };
const adoptBox = (actor, field, box) =>
  actor.send({ type: "checks.changed", settings: { ...actor.getSnapshot().context.checks, [field]: box } });

test("without choice-point-checks the part's settings stay null, so it is hidden", async () => {
  const { snapshot } = await start(undefined, "/a", { account: true });
  assert.equal(snapshot.context.checks, null);
  assert.ok(snapshot.matches("ready"));
});

test("choosing an evaluator emits the box with every question shown", async () => {
  const { actor, emittedChecks } = await start(undefined, "/a", withChecks);
  actor.send({ type: "_setChecker", field: "towards", evaluator: E1 });
  assert.deepEqual(emittedChecks, [
    {
      type: "checks.edited",
      field: "towards",
      evaluator: E1,
      questions: [
        { id: Q1, show: true, expect: null, when: null, icons: {} },
        { id: Q2, show: true, expect: null, when: null, icons: {} },
      ],
      also: [],
    },
  ]);
  actor.send({ type: "_setChecker", field: "away", evaluator: null });
  assert.equal(emittedChecks.length, 1, "choosing what the box already has emits nothing");
});

test("a question's change emits the whole box, and only a real change; the answer expected is never set here", async () => {
  const { actor, emittedChecks } = await start(undefined, "/a", withChecks);
  adoptBox(actor, "towards", { evaluator: E1, questions: [{ id: Q1, show: true, expect: null, when: null, icons: {} }] });
  actor.send({ type: "_setQuestion", field: "towards", id: Q1, patch: { show: false } });
  assert.deepEqual(emittedChecks.at(-1).questions, [
    { id: Q1, show: false, expect: null, when: null, icons: {} },
    { id: Q2, show: false, expect: null, when: null, icons: {} },
  ], "a question the box holds no setting for is written as not shown");
  adoptBox(actor, "towards", { evaluator: E1, questions: emittedChecks.at(-1).questions });
  actor.send({ type: "_setQuestion", field: "towards", id: Q1, patch: { show: false } });
  actor.send({ type: "_setQuestion", field: "towards", id: Q1, patch: { expect: BEH } });
  assert.equal(emittedChecks.length, 1, "the same setting again, or an expected answer, emits nothing");
  actor.send({ type: "_setQuestion", field: "towards", id: Q2, patch: { show: true, when: { question: Q1, option: BEH } } });
  assert.deepEqual(emittedChecks.at(-1).questions[1], { id: Q2, show: true, expect: null, when: { question: Q1, option: BEH }, icons: {} });
  const stored = [{ id: Q1, show: true, expect: BEH, when: null, icons: { [EMO]: "warning" } }];
  adoptBox(actor, "towards", { evaluator: E1, questions: stored });
  actor.send({ type: "_setQuestion", field: "towards", id: Q1, patch: { show: false } });
  assert.deepEqual(
    [emittedChecks.at(-1).questions[0].expect, emittedChecks.at(-1).questions[0].icons],
    [BEH, { [EMO]: "warning" }],
    "what a box stored before passes through untouched",
  );
  const before = emittedChecks.length;
  actor.send({ type: "_setQuestion", field: "towards", id: Q1, icon: { option: EMO, icon: "check" } });
  assert.equal(emittedChecks.length, before, "Settings no longer sets an answer's icon");
});

test("choosing a box's earlier evaluator again brings back its settings", async () => {
  const { actor, emittedChecks } = await start(undefined, "/a", withChecks);
  const tuned = [
    { id: Q1, show: true, expect: BEH, when: null, icons: {} },
    { id: Q2, show: false, expect: null, when: null, icons: {} },
  ];
  adoptBox(actor, "away", { evaluator: E1, questions: tuned });
  actor.send({ type: "_setChecker", field: "away", evaluator: E2 });
  adoptBox(actor, "away", { evaluator: E2, questions: emittedChecks.at(-1).questions });
  actor.send({ type: "_setChecker", field: "away", evaluator: E1 });
  assert.deepEqual(emittedChecks.at(-1), { type: "checks.edited", field: "away", evaluator: E1, questions: tuned, also: [] });
});

test("Also check with emits the box with its further evaluator, and None takes it away", async () => {
  const yours = { id: YV, book: BOOK, name: "Your values", on: true, questions: [question(Q4, "pick", [{ id: BEH, name: "Serves", description: "" }, { id: EMO, name: "Goes against", description: "" }])], version: 1, pending: false, removing: false, derivedFrom: "values", combined: true };
  const { actor, emittedChecks } = await start(undefined, "/a", { ...withChecks, evaluators: { evaluators: [...EVALUATORS, yours] } });
  const own = [{ id: Q1, show: true, expect: null, when: null, icons: {} }, { id: Q2, show: false, expect: null, when: null, icons: {} }];
  adoptBox(actor, "towards", { evaluator: E1, questions: own, also: [] });
  actor.send({ type: "_setAlso", field: "towards", evaluator: YV });
  assert.deepEqual(emittedChecks.at(-1), { type: "checks.edited", field: "towards", evaluator: E1, questions: own, also: [{ evaluator: YV, questions: [] }] }, "a combined evaluator has no question settings");
  adoptBox(actor, "towards", { evaluator: E1, questions: own, also: [{ evaluator: YV, questions: [] }] });
  actor.send({ type: "_setAlso", field: "towards", evaluator: YV });
  assert.equal(emittedChecks.length, 1, "choosing what the box already has emits nothing");
  actor.send({ type: "_setAlso", field: "towards", evaluator: E2 });
  assert.deepEqual(emittedChecks.at(-1).also, [{ evaluator: E2, questions: [{ id: Q3, show: true, expect: null, when: null, icons: {} }] }], "any other evaluator with every question shown");

  // Switching the box's evaluator keeps it; Not checked clears it with the rest.
  actor.send({ type: "_setChecker", field: "towards", evaluator: E2 });
  assert.deepEqual(emittedChecks.at(-1).also, [{ evaluator: YV, questions: [] }]);
  actor.send({ type: "_setChecker", field: "towards", evaluator: null });
  assert.deepEqual(emittedChecks.at(-1).also, []);

  actor.send({ type: "_setAlso", field: "towards", evaluator: null });
  assert.deepEqual(emittedChecks.at(-1), { type: "checks.edited", field: "towards", evaluator: E1, questions: own, also: [] }, "None takes it away");

  actor.send({ type: "_setChecker", field: "towards", evaluator: YV });
  assert.deepEqual(emittedChecks.at(-1), { type: "checks.edited", field: "towards", evaluator: YV, questions: [], also: [] }, "as the box's own evaluator it has no question settings either");
});

test("evaluator.changed and evaluator.deleted keep the list to choose from (4.3)", async () => {
  const { actor } = await start(undefined, "/a", withChecks);
  actor.send({ type: "evaluator.changed", evaluator: { ...EVALUATORS[1], name: "Renamed" } });
  actor.send({ type: "evaluator.deleted", id: E1, book: BOOK });
  assert.deepEqual(actor.getSnapshot().context.evaluators.map((e) => e.name), ["Renamed"]);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above emitted events");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value)} against its schema: ${JSON.stringify(result.errors?.[0])}`);
  }
});

test("Remove on a key waits out the undo window; Undo keeps the key", async () => {
  const clock = new SimulatedClock();
  const { actor, emittedLlm } = await start(undefined, "/a", { account: true, clock });
  actor.send({ type: "_removeKey" });
  actor.send({ type: "_removeJevKey" });
  assert.deepEqual(actor.getSnapshot().context.removing, ["key", "jevKey"]);
  clock.increment(2999);
  assert.deepEqual(emittedLlm, [], "nothing is removed inside the window");
  actor.send({ type: "_undoRemove", field: "key" });
  clock.increment(1);
  assert.deepEqual(emittedLlm, [{ type: "llm.edited", jevKey: "" }], "an empty key removes it when the window ends");
  clock.increment(5000);
  assert.equal(emittedLlm.length, 1, "Undo kept the API key");
  assert.deepEqual(actor.getSnapshot().context.removed, ["jevKey"]);
  actor.send({ type: "llm.changed", ...LLM_PICTURE, jev: { keySet: false } });
  assert.deepEqual(actor.getSnapshot().context.removed, [], "the new picture shows the key gone");
});

test("the choice point checks part is hidden while flags hides choice points or evaluators, or before it answers", () => {
  const checks = {};
  assert.equal(checksShown({ checks, hidden: [] }), true);
  assert.equal(checksShown({ checks: null, hidden: [] }), false, "no choice-point-checks on the page");
  assert.equal(checksShown({ checks, hidden: null }), false, "flags has not answered");
  assert.equal(checksShown({ checks, hidden: ["choice-points"] }), false);
  assert.equal(checksShown({ checks, hidden: ["evaluators"] }), false);
  assert.equal(checksShown({ checks, hidden: ["chats", "highlights"] }), true);
});
