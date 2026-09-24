// The test kit (10, Tests row): the helpers every test repeats, reached through
// UNBLENT_KIT, which the check sets, the way Playwright is reached through
// PLAYWRIGHT_MODULE. It knows no component: nothing here names one, so deleting a
// component is still deleting one directory (11.2, kit check). Anything about one
// component — a fixture, a selector, a tag — lives in that component's own tests.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// --- Node: real machines on the real bus ------------------------------------------

function schemas(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [f.slice(0, -5), JSON.parse(readFileSync(resolve(dir, f), "utf8"))]),
  );
}

// Mounts the named machines with their own schemas on the real bus (section 9: what
// two components do together, tested without a browser). Each machine's `ask` is the
// bus's, the way its browser entry would pass it; `inputs[name]` adds or replaces the
// rest of that machine's input. `records` receives every routing decision the bus
// makes (3.3). The bus is one per process, so a test calls `unwire()` in `finally`.
export async function wire(names, inputs = {}, { root = ROOT } = {}) {
  const { mount, unmount, ask, tap } = await import("bus");
  const records = [];
  const untap = tap((record) => records.push(record));
  const actors = {};
  const machines = {};
  const unwire = () => {
    for (const actor of Object.values(actors)) unmount(actor);
    untap();
  };
  try {
    for (const name of names) {
      const dir = resolve(root, "components", name);
      const { machine } = await import(pathToFileURL(resolve(dir, "machine.js")).href);
      const input = {
        ask: (target, query, payload) => ask(machine, target, query, payload),
        ...(inputs[name] ?? {}),
      };
      machines[name] = machine;
      actors[name] = mount(machine, { input, events: schemas(resolve(dir, "events")), queries: schemas(resolve(dir, "queries")) });
    }
  } catch (error) {
    unwire();
    throw error;
  }
  return { actors, machines, records, unwire };
}

// --- Browser ------------------------------------------------------------------------

// Playwright arrives lazily, so a pure-Node test can load the kit without it. A test
// keeps a literal `engine.launch()` in its source: that is how the check tells a
// browser test from a Node one.
async function playwright() {
  assert.ok(process.env.PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
  return import(process.env.PLAYWRIGHT_MODULE);
}

// WebKit first, then Chromium (10). Chromium needs the sandbox off on this host.
export const ENGINES = [
  { name: "webkit", launch: async () => (await playwright()).webkit.launch() },
  { name: "chromium", launch: async () => (await playwright()).chromium.launch({ chromiumSandbox: false }) },
];

export async function until(fn, timeout = 4000, step = 40) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("timed out");
}

// Nothing fails in the browser (11.2): a console error, a page error, a failed request
// or a 4xx/5xx response is a problem, except one matching an `ignore` pattern a test
// names as expected traffic (a 422 for a file it refuses on purpose).
export function watch(page, problems = [], { ignore = [] } = {}) {
  const expected = (text) => ignore.some((pattern) => pattern.test(text));
  const report = (text) => !expected(text) && problems.push(text);
  page.on("console", (msg) => msg.type() === "error" && report(`console error: ${msg.text()}`));
  page.on("pageerror", (err) => report(`page error: ${err.message}`));
  page.on("requestfailed", (req) => report(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => res.status() >= 400 && report(`HTTP ${res.status()}: ${res.url()}`));
  return problems;
}

// A forged session cookie for a throwaway server (10, Tests row): refused unless
// UNBLENT_DATA names a throwaway data directory, so nothing is ever forged against
// the running server.
export function forge(userId) {
  const secret = process.env.SESSION_SECRET;
  assert.ok(secret, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");
  return `${userId}.${createHmac("sha256", secret).update(userId).digest("hex")}`;
}

// A fresh user per test, so no two tests share server data.
export function forgeCookie(prefix = "test") {
  return forge(`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

export function signedIn(context, cookie, baseUrl = process.env.UNBLENT_URL) {
  assert.ok(baseUrl, "UNBLENT_URL must be set");
  return context.addCookies([{ name: "unblent_session", value: cookie, url: baseUrl }]);
}

// Shortens every undo window in the context before any element mounts: a view reads
// --duration-undo off its host once, at mount, so the short value must be in the
// cascade before the element upgrades. An adopted stylesheet is applied at document
// start (before <html> exists), unlike a style set on documentElement.
export function shortUndo(context, ms = 150) {
  return context.addInitScript((ms) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`:root{--duration-undo:${ms}ms}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, ms);
}
