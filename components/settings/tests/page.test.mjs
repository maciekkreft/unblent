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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// The sheet's own picture, from its shadow root.
const sheetRows = (page) =>
  page.evaluate(() =>
    [...document.querySelector("settings-sheet").shadowRoot.querySelectorAll(".row")].map((r) => ({
      title: r.querySelector(".title").textContent.trim(),
      path: r.querySelector("code").textContent.trim(),
      shown: r.querySelector('input[type="checkbox"]')?.checked ?? null,
    })),
  );
// The links page-nav shows, in order.
const navLinks = (page) =>
  page.evaluate(() =>
    [...document.querySelector("page-nav").shadowRoot.querySelectorAll("a")].map((a) => a.getAttribute("href")),
  );
const clickRow = (page, path, kind) =>
  page.evaluate(
    ({ path, kind }) => {
      const row = [...document.querySelector("settings-sheet").shadowRoot.querySelectorAll(".row")].find(
        (r) => r.querySelector("code").textContent.trim() === path,
      );
      if (kind === "shown") row.querySelector('input[type="checkbox"]').click();
      else row.querySelector(`button[aria-label$="${kind}"]`).click();
    },
    { path, kind },
  );
const clickSwitch = (page, which) =>
  page.evaluate((which) => {
    const labels = [...document.querySelector("settings-sheet").shadowRoot.querySelectorAll(".switches label")];
    labels.find((l) => l.textContent.includes(which)).querySelector("input").click();
  }, which);
const clickReset = (page) =>
  page.evaluate(() => document.querySelector("settings-sheet").shadowRoot.querySelector("button.reset").click());
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("settings") || "null"));
const switchGone = (page) =>
  page.evaluate(() => getComputedStyle(document.querySelector("viewport-switch")).display === "none");

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

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

const ready = (page) =>
  page.waitForFunction(() => document.querySelector("settings-sheet")?.shadowRoot?.querySelector(".row"));

async function open(engine, { phone = false } = {}) {
  // A fresh context starts with empty storage, so there is nothing to clear; the
  // choices the sheet writes must then survive a reload on their own.
  const browser = await engine.launch();
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  if (phone) await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/settings`);
  if (phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
  await ready(page);
  return { browser, page, problems };
}

// Every page the server lists, in its order: the same answer the sheet starts from.
async function listedPages() {
  const res = await fetch(`${BASE_URL}/api/pages`);
  assert.equal(res.status, 200);
  return (await res.json()).pages.map((p) => p.path);
}

const vimChecked = (page) =>
  page.evaluate(() =>
    [...document.querySelector("settings-sheet").shadowRoot.querySelectorAll(".switches label")]
      .find((l) => l.textContent.includes("Vim keys"))
      .querySelector("input").checked,
  );

const clean = (page) => page.evaluate(() => localStorage.clear());

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  // Browser: a reload against real storage.
  test(`the settings sheet reorders, hides, turns on Vim keys, and its choices survive a reload in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine);
    try {
      // Starting picture: every page the server lists (pages: list, 8), in its order,
      // all shown; the sheet's own page (/workshop/design/settings) keeps no Shown
      // control (the way back). The expected list is read from the server, so adding or
      // removing a page elsewhere never touches this test.
      const pages = await listedPages();
      const rows = await sheetRows(page);
      assert.deepEqual(rows.map((r) => r.path), pages);
      assert.equal(rows[0].path, "/workshop/design/tokens", "the tokens page leads (8)");
      assert.equal(rows[1].path, "/workshop/design/contracts", "then the contracts page (8)");
      // Any page other than this one will do for hiding; the last listed is an app.
      const hide = pages.findLast((p) => p !== "/workshop/design/settings");
      assert.equal(rows.find((r) => r.path === "/workshop/design/settings").shown, null, "the current page has no hide control");
      const startNav = await navLinks(page);

      // Move Tokens down: page-nav on the same page follows on the click (live
      // feedback), and the stored nav is the whole materialised order.
      await clickRow(page, "/workshop/design/tokens", "down");
      await until(async () => (await sheetRows(page))[0].path === "/workshop/design/contracts");
      const s = await stored(page);
      assert.equal(s.nav[0].path, "/workshop/design/contracts");
      assert.equal(s.nav[1].path, "/workshop/design/tokens");
      assert.equal(s.nav.length, pages.length, "reordering materialises every page's position");
      await until(async () => (await navLinks(page))[0] === "/workshop/design/contracts");
      assert.notDeepEqual(await navLinks(page), startNav);

      // Hide a page: it leaves page-nav (still reachable by URL) but stays a
      // row in the sheet, now unshown.
      await clickRow(page, hide, "shown");
      await until(async () => (await stored(page)).nav.find((r) => r.path === hide)?.hidden === true);
      await until(async () => !(await navLinks(page)).includes(hide));
      assert.equal((await sheetRows(page)).find((r) => r.path === hide).shown, false);

      // Hide the viewport switch: stored, and the switch leaves the page.
      await clickSwitch(page, "Viewport switch");
      await until(async () => (await stored(page)).viewportSwitchHidden === true);
      await until(async () => switchGone(page));

      // Turn Vim keys on (off by default): stored with the rest.
      assert.equal(await vimChecked(page), false, "Vim keys are off by default");
      await clickSwitch(page, "Vim keys");
      await until(async () => (await stored(page)).vimKeys === true);

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `settings-${engine.name}.png`), fullPage: true });

      // Reload: the choices are kept (3.1, local-only).
      await page.reload();
      await ready(page);
      assert.equal((await sheetRows(page))[0].path, "/workshop/design/contracts", "order survives a reload");
      assert.equal((await sheetRows(page)).find((r) => r.path === hide).shown, false);
      assert.equal(await navLinks(page).then((l) => l.includes(hide)), false);
      assert.ok(await switchGone(page), "the viewport switch stays hidden across a reload");
      await until(() => vimChecked(page));
      // No view declares a role, so the sheet offers no editor choice (the one "Vim keys"
      // switch replaced them); by now the catalog has answered.
      assert.equal(
        await page.evaluate(() => document.querySelector("settings-sheet").shadowRoot.querySelectorAll("label.select").length),
        0,
        "no editor dropdowns",
      );

      // Reset restores the defaults everywhere.
      await clickReset(page);
      await until(async () => (await stored(page)).nav.length === 0);
      await until(async () => (await sheetRows(page))[0].path === "/workshop/design/tokens");
      await until(async () => (await navLinks(page)).includes(hide));
      await until(async () => !(await switchGone(page)));

      await clean(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
