import { test, describe, before, after } from "node:test";
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
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");

// The composer (3.6) mounts the chosen editor for the note-editor role. Seed the
// choice the way the settings fact stores it (one localStorage key), so the picture
// is the same one a reload restores (§5, verification step 5).
const RICH = JSON.stringify({
  nav: [],
  viewportSwitchHidden: false,
  layoutSwitchHidden: false,
  arranging: true,
  editors: { "note-editor": "note-editor-rich" },
});

function watch(page, problems) {
  page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));
}

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

// The element the dock has slotted for the note-editor role, read as the user sees
// it: the swap must keep the same slot (12).
const slotted = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("dock-desk").shadowRoot;
    const el = root.querySelector('slot[name="note-editor"]')?.assignedElements?.()[0];
    return el ? { tag: el.localName, role: el.dataset.role ?? null } : null;
  });

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  describe(`the composer swaps the note editor in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("choosing the rich editor swaps it in place and keeps the note", async () => {
      const context = await browser.newContext();
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);

      // Start on the page default (plain note-editor), write and save a note.
      await page.goto(`${BASE_URL}/apps/notes`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea"));
      assert.deepEqual(await slotted(page), { tag: "note-editor", role: null }, "default is the plain editor");
      await page.evaluate(() => {
        const ta = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
        ta.value = "Kept Title\nacross the swap";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("blur"));
      });
      await until(async () => (await page.locator("note-editor .status").textContent())?.trim() === "Saved");

      // Choose the rich editor and reload: the composer reads settings.editors on
      // load and mounts it from the first frame (verification step 5).
      await page.evaluate((v) => localStorage.setItem("settings", v), RICH);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor-rich")?.shadowRoot?.querySelector(".region"));

      // The rich editor holds the slot the plain one held (12), carrying data-role.
      assert.deepEqual(await slotted(page), { tag: "note-editor-rich", role: "note-editor" }, "the rich editor took the slot");

      // The note is preserved: both members reopen the newest note on start (§5).
      await until(async () => (await page.locator("note-editor-rich .status").textContent())?.trim() === "Saved");
      const body = await page.evaluate(
        () => document.querySelector("note-editor-rich").shadowRoot.querySelector(".region").textContent,
      );
      assert.equal(body, "Kept Title\nacross the swap", "the note carried across the swap");

      // The first line is drawn as a title: larger than the body text (Step 4).
      const sizes = await page.evaluate(() => {
        const r = document.querySelector("note-editor-rich").shadowRoot.querySelector(".region");
        return {
          first: parseFloat(getComputedStyle(r, "::first-line").fontSize),
          base: parseFloat(getComputedStyle(r).fontSize),
        };
      });
      assert.ok(sizes.first > sizes.base, `the title line is larger, saw ${sizes.first} vs ${sizes.base}`);

      // Switching back to the default reverts in place, note still intact.
      await page.evaluate(() =>
        localStorage.setItem(
          "settings",
          JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: { "note-editor": "note-editor" } }),
        ),
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea"));
      await until(async () => (await page.locator("note-editor .status").textContent())?.trim() === "Saved");
      assert.equal(await page.locator("note-editor textarea").inputValue(), "Kept Title\nacross the swap");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    test("the rich editor mounts on the phone", async () => {
      const context = await browser.newContext();
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => {
        localStorage.setItem("viewport", "phone");
        localStorage.setItem("settings", v);
      }, RICH);
      await page.goto(`${BASE_URL}/apps/notes`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor-rich")?.shadowRoot?.querySelector(".region"));
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      assert.deepEqual(await slotted(page), { tag: "note-editor-rich", role: "note-editor" });
      const fits = await page.evaluate(() => {
        const el = document.querySelector("note-editor-rich");
        return el.scrollWidth <= el.clientWidth + 1;
      });
      assert.ok(fits, "the rich editor must not overflow sideways on the phone");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `notes-rich-phone-${engine.name}.png`) });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });
  });
}
