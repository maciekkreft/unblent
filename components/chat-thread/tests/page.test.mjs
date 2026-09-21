import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

function watch(page) {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  return problems;
}

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

const forge = (userId) => {
  const secret = process.env.SESSION_SECRET;
  assert.ok(secret, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory; never forge a cookie against the running server");
  return `${userId}.${crypto.createHmac("sha256", secret).update(userId).digest("hex")}`;
};

// A signed-in browser on the conversations page, its account on the Echo test provider
// (set over HTTP, since this page has no Settings). The chat box is then usable.
async function open(engine, name) {
  const browser = await engine.launch();
  const userId = `chat-${engine.name}-${name}-${Date.now()}`;
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addCookies([{ name: "unblent_session", value: forge(userId), url: BASE_URL }]);
  const put = await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } });
  assert.ok(put.ok(), "the account is set to Echo");
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
  await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector("textarea"))));
  return { browser, context, page, problems };
}

// Set the draft and send it. updateComplete waits for Lit to enable the Send button
// (it turns on once the draft has text) before the click, as a typing user would.
const send = (page, text) =>
  page.evaluate(async (text) => {
    const host = document.querySelector("chat-input");
    const area = host.shadowRoot.querySelector("textarea");
    area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    await host.updateComplete;
    host.shadowRoot.querySelector(".send").click();
  }, text);

const threadText = (page) =>
  page.evaluate(() => document.querySelector("chat-thread").shadowRoot.querySelector(".transcript").textContent);

const lastAnswer = (page) =>
  page.evaluate(() => {
    const answers = document.querySelector("chat-thread").shadowRoot.querySelectorAll(".turn.assistant .answer");
    return answers.length ? answers[answers.length - 1].textContent : "";
  });

// Stopping an answer and reloading mid-answer both cancel the in-flight streaming
// request on purpose (5: an answer still arriving when the page goes away is not kept);
// the browser records that cancellation as a failed request, which the reader never
// sees. These two tests drop that expected noise but
// keep every real error (a console error, an HTTP 4xx/5xx).
const ABORT_NOISE = /Load request cancelled|access control checks|NS_BINDING_ABORTED|aborted|cancelled/i;
const realProblems = (problems) => problems.filter((p) => !ABORT_NOISE.test(p));

const action = (page, label) =>
  page.evaluate(
    (label) =>
      [...document.querySelector("chat-input").shadowRoot.querySelectorAll(".action")].some((b) => b.textContent.trim() === label),
    label,
  );

for (const engine of ENGINES) {
  test(`a message is answered word by word in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "answer");
    try {
      await send(page, "hello there");
      await until(async () => (await lastAnswer(page)).includes("hello there")); // Echo repeats the text
      assert.match(await threadText(page), /hello there/);
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`thinking shows a live line and then an openable record in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "think");
    try {
      // The live "Thinking…" line shows only while the model thinks (a short window),
      // so an observer catches it rather than a poll that could miss it.
      await page.evaluate(() => {
        window.__sawThinking = false;
        const root = document.querySelector("chat-thread").shadowRoot;
        const note = () => {
          const w = root.querySelector(".working");
          if (w && w.textContent.includes("Thinking")) window.__sawThinking = true;
        };
        new MutationObserver(note).observe(root, { subtree: true, childList: true, characterData: true });
        note();
      });
      await send(page, "/think please");
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-thread").shadowRoot.querySelector("details.thinking"))));
      const record = await page.evaluate(() => {
        const d = document.querySelector("chat-thread").shadowRoot.querySelector("details.thinking");
        d.querySelector("summary").click(); // opens it (closed by default)
        return d.querySelector(".text").textContent;
      });
      assert.ok(record && record.length > 0, "the thinking record opens to show the thinking text");
      assert.ok(await page.evaluate(() => window.__sawThinking), "the live Thinking… line showed while the model thought");
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a slow answer can be stopped in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "stop");
    try {
      // A long answer, so it is still arriving when Escape stops it.
      await send(page, "/slow " + "the answer keeps arriving slowly here. ".repeat(3));
      await until(async () => (await lastAnswer(page)).length > 0); // an answer is arriving
      // Escape stops the answer (12), and is not subject to the button's change guard.
      await page.evaluate(() => document.querySelector("chat-input").shadowRoot.querySelector("textarea").focus());
      await page.keyboard.press("Escape");
      await until(async () => (await threadText(page)).includes("Stopped."));
      assert.deepEqual(realProblems(problems), [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`Enter while an answer arrives keeps the typed text in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "keepdraft");
    try {
      // A long answer, so it is still arriving. The box stays editable (12): a question
      // typed and sent with Enter now must survive, not be cleared by a doomed send.
      await send(page, "/slow " + "a long answer that keeps arriving here. ".repeat(3));
      await until(async () => (await lastAnswer(page)).length > 0); // an answer is arriving
      await page.evaluate(() => {
        const area = document.querySelector("chat-input").shadowRoot.querySelector("textarea");
        area.value = "a thought to send next";
        area.dispatchEvent(new Event("input", { bubbles: true }));
        area.focus();
      });
      await page.keyboard.press("Enter");
      const value = await page.evaluate(() => document.querySelector("chat-input").shadowRoot.querySelector("textarea").value);
      assert.equal(value, "a thought to send next", "the text stays in the box while an answer arrives");
      assert.deepEqual(realProblems(problems), [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a failed answer offers Try again in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "fail");
    try {
      await send(page, "/fail");
      await until(async () => await action(page, "Try again"));
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a finished chat survives a reload in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "reload");
    try {
      await send(page, "keep me");
      await until(async () => (await lastAnswer(page)).includes("keep me"));
      await until(async () => !(await threadText(page)).includes("Not saved yet")); // saved to the server
      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector("textarea"))));
      await until(async () => (await threadText(page)).includes("keep me"));
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `conversations-${engine.name}.png`), fullPage: true });
      assert.deepEqual(problems, [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });

  test(`a reload mid-answer ends at the question with Continue in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine, "continue");
    try {
      // A long answer, reloaded while it is still arriving: the question is saved but the
      // in-progress answer is not (5: an arriving answer is not kept when the page goes away).
      await send(page, "/slow " + "a long answer that is still arriving. ".repeat(3));
      // Arriving, and the question is on the server (not "Not saved yet"), so a reload
      // finds the chat ending at the question.
      await until(async () => {
        const t = await threadText(page);
        return (await lastAnswer(page)).length > 0 && !t.includes("Not saved yet");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector("textarea"))));
      await until(async () => await action(page, "Continue")); // the chat ends at the question
      assert.equal(await lastAnswer(page), "", "the in-progress answer was not kept");
      assert.deepEqual(realProblems(problems), [], problems.join("; "));
    } finally {
      await browser.close();
    }
  });
}
