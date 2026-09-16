import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const SCREENSHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".screenshots");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

const switchState = (page) =>
  page.evaluate(() => {
    const button = document.querySelector("session-switch")?.shadowRoot?.querySelector("button");
    return button ? { title: button.getAttribute("title"), cls: button.className } : null;
  });
const ready = (page) =>
  page.waitForFunction(() => document.querySelector("session-switch")?.shadowRoot?.querySelector("button"));

function watch(page) {
  const problems = [];
  page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));
  return problems;
}

// WebKit first, then Chromium: a Safari-class engine is the stricter check. This
// only renders the anonymous switch; the passkey ceremony needs a virtual
// authenticator (Chromium) and lives in ceremony.test.mjs (11.2).
for (const engine of ENGINES) {
  test(`the session switch shows the anonymous create-account control in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    const page = await context.newPage();
    const problems = watch(page);
    try {
      await page.goto(`${BASE_URL}/design/session`, { waitUntil: "domcontentloaded" });
      await ready(page);
      const state = await switchState(page);
      // Anonymous either way: the dashed glyph, the "anon" class. The label follows
      // capacity (MAX_USERS=1) — "Create account" while the registry has room, "Sign
      // in" once the ceremony test has filled it in this shared suite — because the
      // switch relabels on session.changed rather than keeping its mount-time guess.
      assert.equal(state.cls, "anon");
      assert.ok(
        ["Create account", "Sign in"].includes(state.title),
        `an anonymous label, saw ${state.title}`,
      );
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `session-${engine.name}.png`) });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
