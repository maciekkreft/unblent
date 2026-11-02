import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Ollama in the Mac app (3.4): a local-edition server of this file's own, on a
// throwaway data directory, answered by a fake OpenAI-compatible server in this process
// that streams thinking, text and a tool call as Ollama does, and answers decisions at
// /v1/systemone as Ollama does for kev:0.8b-mlx-bf16. The same fake stands in for Jev under
// /jev, so choosing Jev is tried without reaching typesafe.ai. The local edition needs
// no cookie: every request belongs to its one account.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOCAL = "e".repeat(32);
const data = mkdtempSync(join(tmpdir(), "unblent-test-ollama-"));
const received = [];
const decided = [];
const MODELS = [{ id: "gemma3:latest", object: "model", created: 1, owned_by: "library" }, { id: "gemma4:e4b-mlx", object: "model", created: 1, owned_by: "library" }];
const KEV = { id: "kev:0.8b-mlx-bf16", object: "model", created: 1, owned_by: "library" };
// What the fake lists as downloaded, and the status its systemone answers with.
const fakeState = { kev: false, systemone: 200 };
let server;
let fake;
let base;
let ollama;
let dead;

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gemma4:e4b-mlx", choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;

// The first round thinks, writes, and asks for one call whose arguments arrive in two
// fragments; the round that brings the result back answers in text.
const answer = (body) => {
  const last = body.messages.at(-1);
  const out = [];
  if (last.role === "tool") {
    out.push(chunk({ role: "assistant", content: "It is about Stoics." }));
    out.push(chunk({}, { finish_reason: "stop" }));
  } else {
    out.push(chunk({ role: "assistant", content: "", reasoning: "Let me look." }));
    out.push(chunk({ content: "Checking." }));
    out.push(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "books__chapter", arguments: '{"book":' } }] }));
    out.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '"b1"}' } }] }));
    out.push(chunk({}, { finish_reason: "tool_calls" }));
  }
  out.push(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gemma4:e4b-mlx", choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 } })}\n\n`);
  out.push("data: [DONE]\n\n");
  return out.join("");
};

const fakeOllama = () =>
  createHttp(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: fakeState.kev ? [...MODELS, KEV] : MODELS }));
      return;
    }
    if (req.method === "POST" && (req.url === "/v1/systemone" || req.url === "/jev")) {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      decided.push({ url: req.url, authorization: req.headers.authorization ?? null, body });
      if (req.url === "/v1/systemone" && fakeState.systemone !== 200) {
        res.writeHead(fakeState.systemone, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `model "${body.model}" not found, try pulling it first` }));
        return;
      }
      // No confidence and no usage, as Ollama's systemone documents neither.
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: 0.75 };
        else {
          const names = Object.keys(q.criteria);
          answers[id] = { type: "choice", choice: names[1], probabilities: Object.fromEntries(names.map((n, i) => [n, i === 1 ? 0.9 : 0.1 / (names.length - 1)])) };
        }
      }
      if (req.url === "/jev") Object.values(answers).forEach((a) => a.type === "choice" && (a.confidence = 0.8));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/jev" ? { answers, usage: { input_tokens: 12 } } : { answers }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      received.push(body);
      if (!body.stream) {
        // A generator's one text in one go (llm: generate), not streamed.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "c2", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: " Stoic evenings " }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(answer(body));
      return;
    }
    res.writeHead(404).end();
  });

const read = async () => (await fetch(`${base}/api/llm`)).json();
const edit = (body) => fetch(`${base}/api/llm`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const decide = async (body) => (await fetch(`${base}/api/llm/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const DECISION = {
  state: { text: "I want to be kind." },
  questions: [
    { id: "q", instructions: "Is it a value?", yes: "an ongoing way of acting", no: "something finished" },
    { id: "k", kind: "pick", instructions: "Goal or value?", options: [{ id: "g", name: "Goal" }, { id: "v", name: "Value", description: "never finished" }] },
  ],
};
const complete = async (body) => (await (await fetch(`${base}/api/llm/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).text()).trim().split("\n").map((line) => JSON.parse(line));

const generate = async (body) => (await fetch(`${base}/api/llm/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const WANTED = { model: "claude-haiku-5-5", prompt: "Name this chat.", text: "What did the Stoics do at night?" };

const ulid = (n) => `01TEST${String(n).padStart(20, "0")}`;
const TOOL = { target: "books", name: "chapter", description: "Read a chapter.", payload: { type: "object", properties: { book: { type: "string" } }, required: ["book"] } };
const question = { id: ulid(1), start: "you are a test", turns: [{ id: ulid(2), role: "user", text: "What is it about?" }], tools: [TOOL] };

// One group per file: the check runs every Node test file in one process, where a
// top-level before() would start this file's server ahead of the whole run and its
// time would be charged to whichever test runs first (11).
describe("Ollama in the local edition", () => {
  before(async () => {
    fake = fakeOllama();
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    ollama = `http://127.0.0.1:${fake.address().port}`;
    dead = `http://127.0.0.1:${await freePort()}`;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "ollama-test-secret", UNBLENT_LOCAL_USER: LOCAL, UNBLENT_JEV_URL: `${ollama}/jev` };
    delete env.UNBLENT_REMOTE;
    server = spawn(join(ROOT, ".venv/bin/uvicorn"), ["server.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${base}/static/bus/bus.js`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // The server's first request warms it up; done here, outside a test's budget.
    await read();
  }, { timeout: 30000 });

  after(async () => {
    server.kill();
    await new Promise((r) => (server.exitCode === null ? server.once("exit", r) : r()));
    await new Promise((r) => fake.close(r));
    rmSync(data, { recursive: true, force: true });
  });

  test("the Mac app offers Ollama first, at its default address; gemma4:e4b-mlx is the default model once Ollama answers", async () => {
    const fresh = await read();
    assert.equal(fresh.provider, "ollama");
    assert.equal(fresh.providers[0].id, "ollama");
    assert.deepEqual(fresh.efforts, ["on", "off"]);
    assert.equal(fresh.effort, "on");
    assert.equal(fresh.ollama.address, "http://localhost:11434");
    assert.deepEqual(fresh.jev, { keySet: false }, "Jev can be chosen to decide");
    assert.deepEqual(fresh.deciders, ["ollama", "jev"]);
    assert.equal(fresh.decider.provider, "ollama", "Ollama decides by default");
    const picture = await (await edit({ address: `${ollama}/` })).json();
    assert.deepEqual(picture.ollama, { address: ollama, running: true }, "kept without the trailing slash");
    assert.deepEqual(picture.models, [{ id: "gemma3:latest", label: "gemma3" }, { id: "gemma4:e4b-mlx", label: "gemma4:e4b-mlx" }]);
    assert.equal(picture.model, "gemma4:e4b-mlx");
    assert.equal((await edit({ address: "ftp://nowhere" })).status, 400, "only an http or https address");
    assert.equal((await read()).ollama.address, ollama);
  });

  test("with nothing listening at the address, Ollama is not running and an answer ends local-off", async () => {
    try {
      const picture = await (await edit({ address: dead })).json();
      assert.deepEqual(picture.ollama, { address: dead, running: false });
      assert.deepEqual(picture.models, []);
      const end = (await complete(question)).at(-1);
      assert.deepEqual([end.type, end.status, end.error], ["end", "failed", "local-off"]);
    } finally {
      await edit({ address: ollama });
    }
  });

  test("an answer streams thinking, text and one joined call, and the result goes back as a tool message", async () => {
    await edit({ address: ollama, effort: "on" });
    received.length = 0;
    const first = await complete(question);
    assert.deepEqual(first.filter((p) => p.type !== "end"), [
      { type: "thinking", text: "Let me look." },
      { type: "text", text: "Checking." },
      { type: "call", id: "call_1", target: "books", name: "chapter", payload: { book: "b1" } },
    ]);
    const end = first.at(-1);
    assert.deepEqual([end.status, end.provider, end.model], ["done", "ollama", "gemma4:e4b-mlx"]);
    assert.deepEqual(end.usage, { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 });
    assert.equal(received[0].reasoning_effort, "medium", "thinking on");
    assert.deepEqual(received[0].tools, [{ type: "function", function: { name: "books__chapter", description: "Read a chapter.", parameters: TOOL.payload } }]);
    assert.deepEqual(received[0].messages[0], { role: "system", content: "you are a test" });

    await edit({ effort: "off" });
    const turns = [
      ...question.turns,
      { id: ulid(3), role: "assistant", text: "Checking.", status: "done", calls: [{ id: "call_1", target: "books", name: "chapter", payload: { book: "b1" }, label: "Reading a chapter" }] },
      { id: ulid(4), role: "user", text: "", results: [{ callId: "call_1", content: "Stoics." }] },
    ];
    const second = await complete({ ...question, turns });
    assert.equal(second.filter((p) => p.type === "text").map((p) => p.text).join(""), "It is about Stoics.");
    assert.equal(received[1].reasoning_effort, "none", "thinking off");
    assert.deepEqual(received[1].messages.slice(2), [
      { role: "assistant", content: "Checking.", tool_calls: [{ id: "call_1", type: "function", function: { name: "books__chapter", arguments: '{"book": "b1"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "Stoics." },
    ]);
  });

  test("Ollama decides by default: kev:0.8b-mlx-bf16 answers yes/no and pick-one at /v1/systemone, with no key and no confidence", async () => {
    fakeState.kev = true;
    try {
      const picture = await (await edit({ address: ollama })).json();
      assert.deepEqual(picture.decider, {
        provider: "ollama", model: "kev:0.8b-mlx-bf16", ready: true,
        models: ["kev:0.8b-mlx-bf16", "gemma3:latest", "gemma4:e4b-mlx"].map((id) => ({ id, label: id })),
      }, "every downloaded model may make the checks, Kev first");
      decided.length = 0;
      const reply = await decide(DECISION);
      assert.deepEqual(reply.answers, [
        { id: "q", p: 0.75 },
        { id: "k", p: 0.9, choice: "v", probabilities: [{ id: "g", p: 0.1 }, { id: "v", p: 0.9 }] },
      ]);
      assert.equal(reply.inputTokens, 0, "Ollama reports no usage");
      assert.deepEqual([decided[0].url, decided[0].authorization, decided[0].body.model], ["/v1/systemone", null, "kev:0.8b-mlx-bf16"]);
      assert.deepEqual(decided[0].body.questions.k.criteria, { Goal: null, Value: "never finished" });
    } finally {
      fakeState.kev = false;
    }
  });

  test("a decision Ollama cannot give is local-off when nothing listens and no-model when kev:0.8b-mlx-bf16 is missing", async () => {
    try {
      const off = await (await edit({ address: dead })).json();
      assert.deepEqual(off.decider, { provider: "ollama", model: "kev:0.8b-mlx-bf16", ready: false, models: [] });
      assert.deepEqual(await decide(DECISION), { error: "local-off" });

      const missing = await (await edit({ address: ollama })).json();
      assert.equal(missing.decider.ready, false, "Ollama answers but has no kev:0.8b-mlx-bf16");
      assert.deepEqual(await decide(DECISION), { error: "no-model" });

      // Listed, yet Ollama's systemone says the model is not found.
      fakeState.kev = true;
      fakeState.systemone = 404;
      assert.deepEqual(await decide(DECISION), { error: "no-model" });
    } finally {
      Object.assign(fakeState, { kev: false, systemone: 200 });
      await edit({ address: ollama });
    }
  });

  test("with Jev chosen, a decision needs the Jev key and is sent to Jev with it", async () => {
    try {
      const chosen = await (await edit({ decider: "jev" })).json();
      assert.deepEqual(chosen.decider, { provider: "jev", model: "jev-latest", ready: false, models: [{ id: "jev-latest", label: "Jev" }] });
      assert.deepEqual(await decide(DECISION), { error: "no-key" });
      assert.equal((await edit({ decider: "anthropic" })).status, 400);
      const keyed = await (await edit({ jevKey: "jev-local-key" })).json();
      assert.equal(keyed.decider.ready, true);
      decided.length = 0;
      const reply = await decide(DECISION);
      assert.equal(reply.answers[1].confidence, 0.8);
      assert.equal(reply.inputTokens, 12);
      assert.deepEqual([decided[0].url, decided[0].authorization, decided[0].body.model], ["/jev", "Bearer jev-local-key", "jev-latest"]);
      assert.equal((await read()).decider.provider, "jev", "the choice is kept");
    } finally {
      await edit({ decider: "ollama", jevKey: "" });
    }
  });

  test("a generator runs on the chat model in Ollama, in one go and with no key, when Ollama lacks its own model", async () => {
    await edit({ address: ollama });
    received.length = 0;
    assert.deepEqual(await generate(WANTED), { text: "Stoic evenings" }, "the website's default runs on Gemma");
    assert.deepEqual([received[0].model, received[0].stream ?? false, received[0].reasoning_effort], ["gemma4:e4b-mlx", false, "none"]);
    assert.deepEqual(received[0].messages, [{ role: "system", content: WANTED.prompt }, { role: "user", content: WANTED.text }]);
    assert.deepEqual(await generate({ ...WANTED, model: "gemma3:latest" }), { text: "Stoic evenings" });
    assert.equal(received[1].model, "gemma3:latest", "a model Ollama has runs as chosen");
    assert.deepEqual(await generate({ ...WANTED, model: "echo" }), { text: "Echo: What did the Stoics do at night?" });
  });

  test("a generator on the Mac is unavailable while Ollama does not answer, and needs the key when the chat uses Anthropic", async () => {
    try {
      await edit({ address: dead });
      assert.deepEqual(await generate(WANTED), { error: "unavailable" });
      await edit({ address: ollama, provider: "anthropic" });
      assert.deepEqual(await generate(WANTED), { error: "no-key" });
    } finally {
      await edit({ address: ollama, provider: "ollama" });
    }
  });
});
