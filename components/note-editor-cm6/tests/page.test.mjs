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
// choice the way the settings fact stores it (one localStorage key), so a reload
// restores the same picture (§5, verification step 5).
const settings = (editor) =>
  JSON.stringify({
    nav: [],
    viewportSwitchHidden: false,
    layoutSwitchHidden: false,
    arranging: true,
    editors: { "note-editor": editor },
  });
const CM6 = settings("note-editor-cm6");

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

// The element the dock has slotted for the note-editor role (12).
const slotted = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("dock-desk").shadowRoot;
    const el = root.querySelector('slot[name="note-editor"]')?.assignedElements?.()[0];
    return el ? { tag: el.localName, role: el.dataset.role ?? null } : null;
  });

// The document as the user sees it: each CM6 line's text and classes, marker-free.
const lines = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("note-editor-cm6").shadowRoot;
    return [...root.querySelectorAll(".cm-line")].map((l) => ({ text: l.textContent, className: l.className }));
  });

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  describe(`note-editor-cm6 in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("edits under Vim: line one is a Title, \\2 makes a Heading, no markers in the buffer", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), CM6);
      await page.goto(`${BASE_URL}/apps/notes`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor-cm6")?.shadowRoot?.querySelector(".cm-content"));
      assert.deepEqual(await slotted(page), { tag: "note-editor-cm6", role: "note-editor" });

      // Vim boots in normal mode: enter insert, type two lines, return to normal.
      await page.locator("note-editor-cm6 .cm-content").click();
      await page.keyboard.press("i");
      await page.keyboard.type("Alpha");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Beta");
      await page.keyboard.press("Escape");
      await until(async () => (await lines(page)).map((l) => l.text).join("\n") === "Alpha\nBeta");

      // The caret is on line two (Beta): the leader map \2 makes it a Heading.
      await page.keyboard.type("\\2");
      await until(async () => (await lines(page))[1]?.className.includes("cm-level-heading"));

      const shown = await lines(page);
      assert.equal(shown.map((l) => l.text).join("\n"), "Alpha\nBeta", "the buffer holds no marker characters");
      assert.ok(shown[0].className.includes("cm-level-title"), "line one is a Title (the first-line default)");
      assert.ok(shown[1].className.includes("cm-level-heading"), "line two became a Heading");

      const sizes = await page.evaluate(() => {
        const root = document.querySelector("note-editor-cm6").shadowRoot;
        const px = (sel) => parseFloat(getComputedStyle(root.querySelector(sel)).fontSize);
        return { title: px(".cm-level-title"), heading: px(".cm-level-heading") };
      });
      assert.ok(sizes.title > sizes.heading, `Title larger than Heading, saw ${sizes.title} vs ${sizes.heading}`);

      await until(async () => (await page.locator("note-editor-cm6 .status").textContent())?.trim() === "Saved");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    test("the composer swaps cm6 in place, carrying a note written in the plain editor", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);

      // Write and save on the page default (plain note-editor).
      await page.goto(`${BASE_URL}/apps/notes`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector("textarea"));
      assert.deepEqual(await slotted(page), { tag: "note-editor", role: null }, "default is the plain editor");
      await page.evaluate(() => {
        const ta = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
        ta.value = "Carried note\nsecond line";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("blur"));
      });
      await until(async () => (await page.locator("note-editor .status").textContent())?.trim() === "Saved");

      // Choose cm6 and reload: the composer mounts it in the same slot.
      await page.evaluate((v) => localStorage.setItem("settings", v), CM6);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor-cm6")?.shadowRoot?.querySelector(".cm-content"));
      assert.deepEqual(await slotted(page), { tag: "note-editor-cm6", role: "note-editor" }, "cm6 took the slot");

      await until(async () => (await page.locator("note-editor-cm6 .status").textContent())?.trim() === "Saved");
      const shown = await lines(page);
      assert.equal(shown.map((l) => l.text).join("\n"), "Carried note\nsecond line", "the note carried across the swap");
      // A note the plain editor wrote has no markers, so cm6 shows it all as Body.
      assert.ok(!shown.some((l) => l.className.includes("cm-level-")), "unmarked lines load as Body");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });

    test("cm6 mounts on the phone", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => {
        localStorage.setItem("viewport", "phone");
        localStorage.setItem("settings", v);
      }, CM6);
      await page.goto(`${BASE_URL}/apps/notes`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelector("note-editor-cm6")?.shadowRoot?.querySelector(".cm-content"));
      await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      assert.deepEqual(await slotted(page), { tag: "note-editor-cm6", role: "note-editor" });
      const fits = await page.evaluate(() => {
        const el = document.querySelector("note-editor-cm6");
        return el.scrollWidth <= el.clientWidth + 1;
      });
      assert.ok(fits, "cm6 must not overflow sideways on the phone");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `notes-cm6-phone-${engine.name}.png`) });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await context.close();
    });
  });
}
