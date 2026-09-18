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

const clean = (page) => page.evaluate(() => localStorage.clear());

// The Note editor swap select (Step 5), read from the sheet's shadow root.
const editorSelect = (page) =>
  page.evaluate(() => {
    const sel = document.querySelector("settings-sheet").shadowRoot.querySelector("label.select select");
    return sel ? { options: [...sel.options].map((o) => o.value), value: sel.value } : null;
  });
const pickEditor = (page, value) =>
  page.evaluate((value) => {
    const sel = document.querySelector("settings-sheet").shadowRoot.querySelector("label.select select");
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the settings sheet reorders, hides, and its choices survive a reload in ${engine.name}`, async () => {
    const { browser, page, problems } = await open(engine);
    try {
      // Starting picture: every page listed, in pages: list order, all shown; the
      // sheet's own page (/workshop/design/settings) keeps no Shown control (the way back).
      const rows = await sheetRows(page);
      assert.deepEqual(
        rows.map((r) => r.path),
        ["/workshop/design/tokens", "/workshop/design/contracts", "/workshop/design/components", "/workshop/design/books", "/workshop/design/dock",
         "/workshop/design/notes", "/workshop/design/session", "/workshop/design/settings", "/workshop/design/trace", "/workshop/design/work-desk", "/", "/workshop/apps/notes"],
      );
      assert.equal(rows.find((r) => r.path === "/workshop/design/settings").shown, null, "the current page has no hide control");
      const startNav = await navLinks(page);

      // Move Tokens down: page-nav on the same page follows on the click (live
      // feedback), and the stored nav is the whole materialised order.
      await clickRow(page, "/workshop/design/tokens", "down");
      await until(async () => (await sheetRows(page))[0].path === "/workshop/design/contracts");
      const s = await stored(page);
      assert.equal(s.nav[0].path, "/workshop/design/contracts");
      assert.equal(s.nav[1].path, "/workshop/design/tokens");
      assert.equal(s.nav.length, 12, "reordering materialises every page's position");
      await until(async () => (await navLinks(page))[0] === "/workshop/design/contracts");
      assert.notDeepEqual(await navLinks(page), startNav);

      // Hide /workshop/design/notes: it leaves page-nav (still reachable by URL) but stays a
      // row in the sheet, now unshown.
      await clickRow(page, "/workshop/design/notes", "shown");
      await until(async () => (await stored(page)).nav.find((r) => r.path === "/workshop/design/notes")?.hidden === true);
      await until(async () => !(await navLinks(page)).includes("/workshop/design/notes"));
      assert.equal((await sheetRows(page)).find((r) => r.path === "/workshop/design/notes").shown, false);

      // Hide the viewport switch: stored, and the switch leaves the page.
      await clickSwitch(page, "Viewport switch");
      await until(async () => (await stored(page)).viewportSwitchHidden === true);
      await until(async () => switchGone(page));

      // The Note editor select lists the note-editor role's members, defaults to the
      // plain editor, and its choice is stored under editors (Step 5, 3.6).
      await until(async () => (await editorSelect(page)) !== null);
      const sel = await editorSelect(page);
      assert.deepEqual(sel.options, ["note-editor", "note-editor-cm6"], "the role's members are listed");
      assert.equal(sel.value, "note-editor", "the plain editor is the default");
      await pickEditor(page, "note-editor-cm6");
      await until(async () => (await stored(page)).editors?.["note-editor"] === "note-editor-cm6");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `settings-${engine.name}.png`), fullPage: true });

      // Reload: the choices are kept (3.1, local-only).
      await page.reload();
      await ready(page);
      assert.equal((await sheetRows(page))[0].path, "/workshop/design/contracts", "order survives a reload");
      assert.equal((await sheetRows(page)).find((r) => r.path === "/workshop/design/notes").shown, false);
      assert.equal(await navLinks(page).then((l) => l.includes("/workshop/design/notes")), false);
      assert.ok(await switchGone(page), "the viewport switch stays hidden across a reload");
      await until(async () => (await editorSelect(page))?.value === "note-editor-cm6");

      // Reset restores the defaults everywhere.
      await clickReset(page);
      await until(async () => (await stored(page)).nav.length === 0);
      await until(async () => (await editorSelect(page))?.value === "note-editor");
      await until(async () => (await sheetRows(page))[0].path === "/workshop/design/tokens");
      await until(async () => (await navLinks(page)).includes("/workshop/design/notes"));
      await until(async () => !(await switchGone(page)));

      await clean(page);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
