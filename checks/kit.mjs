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

// --- Journeys (9) -------------------------------------------------------------------

// A journey's budget (11): five seconds per step and a minute in all, in place of the five
// seconds of a test. Under `check.py --isolate` a step also loads its own page and is
// brought to its starting state, so it gets that setup on top.
export const STEP_MS = 5000;
export const JOURNEY_MS = 60000;
export const ISOLATED_STEP_MS = 3 * STEP_MS;
const ISOLATED = process.env.UNBLENT_ISOLATE === "1";

const TRAIL = "what the user saw, step by step:";

// One browser test that loads its page once and goes through its steps in order, each a
// subtest (9). journey() gives the test's options and body, so the test is declared in the
// test file and is reported under it; the file keeps the literal launch, so the check still
// sorts it as a browser test:
//
//   test(`the lists on / in ${engine.name}`, ...journey({
//     launch: () => engine.launch(),
//     open: async (browser) => ({ page, problems, close }),  // a fresh context, its account
//                                                            // seeded, its page loaded
//     look: (visit) => state,                                // what the user sees, as JSON
//   }, [
//     { name: "j moves down", run: async (v) => { ...; await v.see((s) => complaint || null); } },
//     { name: "G in a long list",
//       from: { state: "the keyboard on a row of Notes", check: (s) => complaint || null,
//               reach: async (v) => { ... } },
//       run: async (v) => { ... } },
//   ]));
//
// A step without `from` continues from where the step before it ended. A step with `from`
// first checks the state it expects at its start, and fails naming the step before it when
// the page is not in that state. `v.see(check)` waits until what the user sees passes the
// check (a function returning a complaint, or nothing): a journey waits for what the user
// should see, never for a fixed time. A visit's `problems` (from watch) must stay empty.
// After a failed step the rest are skipped. With `--isolate` every step with `from` runs
// alone instead, in a visit of its own brought to its start by `reach`, and the others are
// skipped: a step that passes alone but fails in the journey was broken by an earlier one.
export function journey({ launch, open, look }, steps) {
  const timeout = ISOLATED ? steps.length * ISOLATED_STEP_MS : JOURNEY_MS;
  return [{ timeout }, async (t) => {
    const browser = await launch();
    try {
      if (ISOLATED) await isolated(t, browser, { open, look }, steps);
      else await together(t, browser, { open, look }, steps);
    } finally {
      await browser.close();
    }
  }];
}

// The visit a step drives: what `open` returned, with `see` and `look` added, and every
// state seen recorded on the trail under the step that saw it.
function walk(visit, look, trail) {
  const v = Object.create(visit);
  v.step = null;
  v.look = async () => {
    const state = await look(visit);
    trail.push({ step: v.step, ...state });
    return state;
  };
  v.see = async (check, wait = STEP_MS - 1000) => {
    const start = Date.now();
    let complaint = "nothing was seen";
    for (;;) {
      const state = await look(visit);
      complaint = check(state);
      if (!complaint || Date.now() - start > wait) {
        trail.push({ step: v.step, ...state });
        if (complaint) throw new Error(complaint);
        return state;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  return v;
}

function told(v, trail, error) {
  const lines = trail.map((entry) => `  ${JSON.stringify(entry)}`).join("\n");
  return new Error(`step "${v.step}": ${error?.message ?? error}\n${TRAIL}\n${lines}`, { cause: error });
}

// A step stopped by its own clock just inside node's, so its failure still lists the trail.
async function within(ms, work) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still not done after ${ms / 1000}s, the budget of a step (11)`)), ms - 300);
  });
  try {
    return await Promise.race([work(), late]);
  } finally {
    clearTimeout(timer);
  }
}

function clean(visit) {
  const problems = visit.problems ?? [];
  if (problems.length) throw new Error(`the browser reported: ${problems.join("; ")}`);
}

async function together(t, browser, { open, look }, steps) {
  const trail = [];
  const visit = await open(browser);
  try {
    const v = walk(visit, look, trail);
    let previous = "the page load";
    let broken = null;
    for (const step of steps) {
      const skip = broken ? `"${broken}" failed before it` : false;
      let passed = false;
      await t.test(step.name, { timeout: STEP_MS, skip }, async () => {
        v.step = step.name;
        try {
          if (step.from) {
            const complaint = step.from.check(await v.look());
            if (complaint) {
              throw new Error(`expected at its start ${step.from.state}, but ${complaint}: ` +
                `the step before it, "${previous}", left the page in another state`);
            }
          }
          await within(STEP_MS, () => step.run(v));
          clean(visit);
          passed = true;
        } catch (error) {
          throw told(v, trail, error);
        }
      });
      // A step node stopped at its time limit never reached the catch above.
      if (!skip && !passed) broken ??= step.name;
      previous = step.name;
    }
  } finally {
    await visit.close();
  }
}

async function isolated(t, browser, { open, look }, steps) {
  for (const step of steps) {
    if (!step.from) {
      await t.test(step.name, { skip: "continues from the step before it, so it runs only in the journey" }, () => {});
      continue;
    }
    await t.test(step.name, { timeout: ISOLATED_STEP_MS }, async () => {
      const trail = [];
      const visit = await open(browser);
      const v = walk(visit, look, trail);
      try {
        v.step = `${step.name} (reaching its start: ${step.from.state})`;
        await within(ISOLATED_STEP_MS, async () => {
          await step.from.reach(v);
          await v.see(step.from.check);
          v.step = step.name;
          await step.run(v);
        });
        clean(visit);
      } catch (error) {
        throw told(v, trail, error);
      } finally {
        await visit.close();
      }
    });
  }
}
