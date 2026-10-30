import { test, before, after } from "node:test";
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
// that streams thinking, text and a tool call as Ollama does. The local edition needs
// no cookie: every request belongs to its one account.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LOCAL = "e".repeat(32);
const data = mkdtempSync(join(tmpdir(), "unblent-test-ollama-"));
const received = [];
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

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "lfm3:latest", choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;

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
  out.push(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "lfm3:latest", choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 } })}\n\n`);
  out.push("data: [DONE]\n\n");
  return out.join("");
};

const fakeOllama = () =>
  createHttp(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "gemma3:latest", object: "model", created: 1, owned_by: "library" }, { id: "lfm3:latest", object: "model", created: 1, owned_by: "library" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      received.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(answer(body));
      return;
    }
    res.writeHead(404).end();
  });

const read = async () => (await fetch(`${base}/api/llm`)).json();
const edit = (body) => fetch(`${base}/api/llm`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const complete = async (body) => (await (await fetch(`${base}/api/llm/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).text()).trim().split("\n").map((line) => JSON.parse(line));

const ulid = (n) => `01TEST${String(n).padStart(20, "0")}`;
const TOOL = { target: "books", name: "chapter", description: "Read a chapter.", payload: { type: "object", properties: { book: { type: "string" } }, required: ["book"] } };
const question = { id: ulid(1), start: "you are a test", turns: [{ id: ulid(2), role: "user", text: "What is it about?" }], tools: [TOOL] };

before(async () => {
  fake = fakeOllama();
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  ollama = `http://127.0.0.1:${fake.address().port}`;
  dead = `http://127.0.0.1:${await freePort()}`;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, UNBLENT_DATA: data, SESSION_SECRET: "ollama-test-secret", UNBLENT_LOCAL_USER: LOCAL };
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

test("the Mac app offers Ollama first, at its default address, with no Jev; lfm3 is the default model once Ollama answers", async () => {
  const fresh = await read();
  assert.equal(fresh.provider, "ollama");
  assert.equal(fresh.providers[0].id, "ollama");
  assert.deepEqual(fresh.efforts, ["on", "off"]);
  assert.equal(fresh.effort, "on");
  assert.equal(fresh.ollama.address, "http://localhost:11434");
  assert.equal("jev" in fresh, false);
  const picture = await (await edit({ address: `${ollama}/` })).json();
  assert.deepEqual(picture.ollama, { address: ollama, running: true }, "kept without the trailing slash");
  assert.deepEqual(picture.models, [{ id: "gemma3:latest", label: "gemma3" }, { id: "lfm3:latest", label: "lfm3" }]);
  assert.equal(picture.model, "lfm3:latest");
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
  assert.deepEqual([end.status, end.provider, end.model], ["done", "ollama", "lfm3:latest"]);
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
