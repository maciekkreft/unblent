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

// One labelled select in the account section, read as the user sees it.
const accountSelect = (page, name) =>
  page.evaluate((name) => {
    const root = document.querySelector("settings-sheet").shadowRoot;
    const field = [...root.querySelectorAll(".account .field")].find(
      (f) => f.querySelector("span")?.textContent.trim() === name,
    );
    const sel = field?.querySelector("select");
    return sel ? { options: [...sel.options].map((o) => o.value), value: sel.value } : null;
  }, name);

const pickAccount = (page, name, value) =>
  page.evaluate(
    ({ name, value }) => {
      const root = document.querySelector("settings-sheet").shadowRoot;
      const field = [...root.querySelectorAll(".account .field")].find(
        (f) => f.querySelector("span")?.textContent.trim() === name,
      );
      const sel = field.querySelector("select");
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { name, value },
  );

// The whole account section as text (the sign-in line, or the fields).
const accountText = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("settings-sheet").shadowRoot;
    return [...root.querySelectorAll("p.hint, .account")].map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
  });

const forge = (userId) => {
  const secret = process.env.SESSION_SECRET;
  assert.ok(secret, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory; never forge a cookie against the running server");
  return `${userId}.${crypto.createHmac("sha256", secret).update(userId).digest("hex")}`;
};

const ready = (page) =>
  page.waitForFunction(() => document.querySelector("settings-sheet")?.shadowRoot?.querySelector("h3"));

for (const engine of ENGINES) {
  test(`signed out, the account section invites a sign-in in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/llm`, { waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await accountText(page)).includes("Sign in to set up the chat"));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  test(`the account section sets the provider and model and keeps them across a reload in ${engine.name}`, async () => {
    const browser = await engine.launch();
    // Sign in without a passkey ceremony (as api.test.mjs does): a fresh user gets
    // its own throwaway per-user llm.db, so the settings it saves are its own.
    const userId = `llm-page-${engine.name}-${Date.now()}`;
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    await context.addCookies([{ name: "unblent_session", value: forge(userId), url: BASE_URL }]);
    try {
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/llm`, { waitUntil: "domcontentloaded" });
      await ready(page);

      // A fresh account is on Anthropic (needs a key). The workshop profile also
      // offers the Echo test provider; no key is needed for it.
      await until(async () => (await accountSelect(page, "Provider")) !== null);
      const provider = await accountSelect(page, "Provider");
      assert.deepEqual(provider.options, ["anthropic", "echo"], "the workshop offers Echo beside Anthropic");
      assert.equal(provider.value, "anthropic", "a fresh account starts on Anthropic");
      assert.equal(await accountSelect(page, "Model"), null, "no models until a key is set");

      // Switch to Echo: it needs no key, so a model appears and stays chosen.
      await pickAccount(page, "Provider", "echo");
      await until(async () => (await accountSelect(page, "Provider"))?.value === "echo");
      await until(async () => (await accountSelect(page, "Model"))?.value === "echo");

      // Thinking effort and cache lifetime (§13) render from the same picture: a fresh
      // account starts at the provider default and the 1-hour cache, and a change to each
      // is chosen the same way. The server round trip itself is covered by api.test.mjs.
      const effort = await accountSelect(page, "Thinking effort");
      assert.deepEqual(effort.options, ["default", "low", "medium", "high", "xhigh", "max"]);
      assert.equal(effort.value, "default", "a fresh account uses the provider default");
      const ttl = await accountSelect(page, "Cache lifetime");
      assert.deepEqual(ttl.options, ["5m", "1h"]);
      assert.equal(ttl.value, "1h", "a fresh account caches for an hour");
      await pickAccount(page, "Thinking effort", "high");
      await until(async () => (await accountSelect(page, "Thinking effort"))?.value === "high");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `llm-${engine.name}.png`), fullPage: true });

      // Kept on the server (7.7): a reload reads the same picture back.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await accountSelect(page, "Provider"))?.value === "echo", 6000);
      await until(async () => (await accountSelect(page, "Model"))?.value === "echo");
      await until(async () => (await accountSelect(page, "Thinking effort"))?.value === "high");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
