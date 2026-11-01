import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, shown, changed, modelsFor, modelOf, keySet, note, signedIn, IDS, RUN } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const GENERATORS = [
  { id: "chat-title", name: "Chat title", on: true, model: "claude-haiku-5-5", prompt: "Name this chat.", version: 1 },
  { id: "journal-summary", name: "Journal summary", on: true, model: "claude-haiku-5-5", prompt: "Summarise the day.", version: 1 },
];
const LLM = {
  signedIn: true,
  provider: "anthropic",
  providers: [{ id: "anthropic", label: "Anthropic", keySet: true, needsKey: true }],
  model: "claude-opus-5",
  models: [
    { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    { id: "claude-opus-5", label: "Opus 5" },
  ],
  effort: "default",
  efforts: ["default"],
  ttl: "1h",
};

// The tab with its four facts faked: who is signed in decides what it shows.
async function start(session = { userId: "u1", registrationOpen: false }) {
  const asked = [];
  const answers = { "flags read": { off: [], hidden: [] }, "generators list": { generators: GENERATORS }, "llm read": LLM, "session read": session, "settings read": { vimKeys: true } };
  const actor = createActor(machine, {
    input: { ask: async (t, n, p) => (asked.push(`${t}: ${n}`), structuredClone(answers[`${t} ${n}`])), throttleMs: 20, askedMs: 30 },
  });
  const emitted = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted, asked };
}

test("it asks its five facts once and takes their pictures", async () => {
  const { actor, asked } = await start();
  assert.deepEqual(asked.sort(), ["flags: read", "generators: list", "llm: read", "session: read", "settings: read"]);
  const { context } = actor.getSnapshot();
  assert.equal(context.signedIn, true);
  assert.equal(context.vimKeys, true);
  assert.equal(context.generators.length, 2);
});

test("each of the three generators has a row with its own Run", () => {
  assert.deepEqual(IDS, ["chat-title", "journal-summary", "value-suggestion"]);
  for (const id of IDS) assert.ok(RUN[id]?.label && RUN[id]?.asked, id);
  assert.deepEqual(RUN["value-suggestion"], { label: "Run on your values", asked: "Asked for new suggestions for your values." });
});

test("Could be shows only while flags shows Values and Choice Points, and not before it answers", () => {
  const generators = [...GENERATORS, { id: "value-suggestion", name: "Could be", on: false, model: "claude-haiku-5-5", prompt: "Suggest.", version: 2 }];
  const context = (hidden) => ({ generators, pending: {}, hidden });
  assert.equal(shown(context(null), "value-suggestion"), null);
  assert.equal(shown(context(["choice-points"]), "value-suggestion"), null);
  assert.equal(shown(context(["choice-points"]), "chat-title").name, "Chat title", "the others stay");
  assert.equal(shown(context([]), "value-suggestion").on, false, "shown again as it was saved");
});

test("signed out or as a guest the tab is the sign-in line", async () => {
  assert.equal(signedIn({ userId: null }), false);
  assert.equal(signedIn({ userId: "g", guest: true }), false);
  assert.equal(signedIn({ userId: "u" }), true);
  assert.equal(signedIn({ error: "no-answerer" }), true, "a page without session never hides the generators");
  const { actor } = await start({ userId: null, registrationOpen: true });
  assert.equal(actor.getSnapshot().context.signedIn, false);
  actor.send({ type: "session.changed", userId: "u1" });
  assert.equal(actor.getSnapshot().context.signedIn, true, "signing in shows them without a reload");
});

test("typing saves only the fields changed, once the throttle ends", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_type", id: "chat-title", field: "prompt", value: "Name it" });
  actor.send({ type: "_type", id: "chat-title", field: "prompt", value: "Name it well." });
  assert.deepEqual(emitted, [], "nothing leaves while typing");
  await wait(40);
  assert.deepEqual(emitted, [{ type: "generator.edited", id: "chat-title", prompt: "Name it well." }]);
  // Typing back to what is saved saves nothing.
  actor.send({ type: "_type", id: "chat-title", field: "prompt", value: "Name it well." });
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 1);
});

test("leaving a field saves at once, each generator with its own fields", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_type", id: "journal-summary", field: "name", value: "Day in a line" });
  actor.send({ type: "_type", id: "chat-title", field: "prompt", value: "Short title." });
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted, [
    { type: "generator.edited", id: "journal-summary", name: "Day in a line" },
    { type: "generator.edited", id: "chat-title", prompt: "Short title." },
  ]);
});

test("the tick box and the model are saved at once and only when they change", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_switch", id: "chat-title", on: false });
  actor.send({ type: "_switch", id: "chat-title", on: false });
  actor.send({ type: "_model", id: "journal-summary", model: "claude-opus-5" });
  actor.send({ type: "_model", id: "journal-summary", model: "claude-opus-5" });
  assert.deepEqual(emitted, [
    { type: "generator.edited", id: "chat-title", on: false },
    { type: "generator.edited", id: "journal-summary", model: "claude-opus-5" },
  ]);
});

test("a change from the fact never overwrites what is being typed", async () => {
  const { actor } = await start();
  actor.send({ type: "_type", id: "chat-title", field: "prompt", value: "Mine" });
  actor.send({ type: "generator.changed", generator: { ...GENERATORS[0], prompt: "Theirs", on: false, version: 2 } });
  const { context } = actor.getSnapshot();
  assert.equal({ ...context.generators[0], ...context.pending["chat-title"] }.prompt, "Mine");
  assert.equal(context.generators[0].on, false, "the rest of the change is taken");
});

test("Run saves what is typed first, asks for the text, and says so for a moment", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_type", id: "chat-title", field: "prompt", value: "New prompt." });
  actor.send({ type: "_run", id: "chat-title" });
  assert.deepEqual(emitted, [
    { type: "generator.edited", id: "chat-title", prompt: "New prompt." },
    { type: "generation.requested", generator: "chat-title" },
  ]);
  assert.equal(actor.getSnapshot().context.asked, "chat-title");
  await wait(50);
  assert.equal(actor.getSnapshot().context.asked, null, "the line goes after a few seconds");
});

test("the model choice shows the stored model even when the key does not offer it", () => {
  assert.deepEqual(modelsFor(LLM, "claude-haiku-5-5"), LLM.models);
  assert.deepEqual(modelsFor(null, "claude-haiku-5-5"), [{ id: "claude-haiku-5-5", label: "claude-haiku-5-5" }]);
  assert.equal(keySet(null), null);
  assert.equal(keySet(LLM), true);
  assert.equal(keySet({ ...LLM, providers: [{ id: "anthropic", label: "Anthropic", keySet: false, needsKey: true }] }), false);
  assert.deepEqual(changed(GENERATORS[0], { name: "Chat title", prompt: "x" }), { prompt: "x" });
});

// The Mac's picture (3.4): Ollama is the chat's provider, gemma4:e4b-mlx its model.
const MAC = {
  provider: "ollama",
  providers: [
    { id: "ollama", label: "Ollama", keySet: true, needsKey: false },
    { id: "anthropic", label: "Anthropic", keySet: false, needsKey: true },
  ],
  model: "gemma4:e4b-mlx",
  models: [{ id: "gemma3:latest", label: "gemma3" }, { id: "gemma4:e4b-mlx", label: "gemma4:e4b-mlx" }],
  ollama: { address: "http://localhost:11434", running: true },
};

test("on the Mac a generator shows the chat model while its own is not offered, and its own when it is", () => {
  assert.equal(modelOf(MAC, "claude-haiku-5-5"), "gemma4:e4b-mlx");
  assert.deepEqual(modelsFor(MAC, "claude-haiku-5-5"), MAC.models, "the website's default is not offered as a choice");
  assert.equal(modelOf(MAC, "gemma3:latest"), "gemma3:latest");
  assert.equal(modelOf({ ...MAC, models: [], model: "" }, "claude-haiku-5-5"), "claude-haiku-5-5", "Ollama off: the stored model stays");
  assert.equal(modelOf(LLM, "claude-sonnet-5"), "claude-sonnet-5", "the website always shows the stored model");
});

test("the line above the generators: Ollama on the Mac, the Anthropic key elsewhere when it is missing", () => {
  assert.equal(note(MAC), "ollama");
  assert.equal(note(null), null);
  assert.equal(note(LLM), null);
  const noKey = { ...LLM, providers: [{ id: "anthropic", label: "Anthropic", keySet: false, needsKey: true }] };
  assert.equal(note(noKey), "key");
  assert.equal(note({ ...MAC, provider: "anthropic", models: [], model: "" }), "key", "a Mac chatting on Anthropic needs its key");
});
