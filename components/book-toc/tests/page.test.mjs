import { test, describe, before, after } from "node:test";
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
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");

const WAIT = { timeout: 4000, polling: 100 };

const forgeCookie = () => {
  const SECRET = process.env.SESSION_SECRET;
  assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");
  const userId = `book-toc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
};

function watch(page, problems, ignore = false) {
  const skip = (t) => ignore && /\/api\/books\//.test(t ?? "");
  page.on("console", (msg) => {
    if (msg.type() === "error" && !skip(msg.text())) problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => !skip(err.message) && problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => !skip(req.url()) && problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400 && !skip(res.url())) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
}

// The contents rows, read from book-toc's shadow root: title, nesting level and whether
// the row is marked as the chapter now being read.
function tocRowsIn() {
  const r = document.querySelector("book-toc")?.shadowRoot;
  return [...(r?.querySelectorAll(".entry") ?? [])].map((e) => ({
    title: e.textContent.trim(),
    level: Number(e.closest('[role="treeitem"]')?.getAttribute("aria-level")),
    current: e.classList.contains("current"),
  }));
}
const tocRows = (page) => page.evaluate(tocRowsIn);
const readerChapter = (page) =>
  page.evaluate(() => document.querySelector("book-reader")?.shadowRoot?.querySelector(".footer .chap")?.textContent.trim() ?? "");

const waitTile = (page) =>
  page.waitForFunction(
    () => [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile:not(.adding)") ?? [])].some((t) => t.querySelector(".title")?.textContent.trim() === "Sample Book"),
    undefined,
    { timeout: 8000, polling: 100 },
  );
const clickTile = (page) =>
  page.evaluate(() => {
    const t = [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile:not(.adding)")].find(
      (x) => x.querySelector(".title")?.textContent.trim() === "Sample Book",
    );
    t?.click();
  });
const waitReaderReady = (page) =>
  page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot?.querySelector(".footer .chap")?.textContent.trim());
// The current-chapter highlight: the chapter the user just chose (marked at once), or
// the fact's saved position once it moves (a page turn or a jump's announcement, 4.3).
// Wait for it to name the chapter given.
const waitTocCurrent = (page, title) =>
  page.waitForFunction(
    (t) => [...(document.querySelector("book-toc")?.shadowRoot?.querySelectorAll(".entry.current") ?? [])].some((e) => e.textContent.trim() === t),
    title,
    WAIT,
  );
const waitReaderChapter = (page, title) =>
  page.waitForFunction((t) => document.querySelector("book-reader")?.shadowRoot?.querySelector(".footer .chap")?.textContent.trim() === t, title, WAIT);

// Show the Contents tab in the left dock (on the desk both book-shelf and book-toc live
// there as tabs); its view then paints. On the phone the tab sits in the open drawer.
const openContents = (page) =>
  page.evaluate(() => {
    const dd = document.querySelector("dock-desk").shadowRoot;
    const tab = [...dd.querySelectorAll('.dock.left [role="tab"]')].find((t) => t.textContent.trim() === "Contents");
    tab?.click();
  });
const clickEntry = (page, title) =>
  page.evaluate((t) => {
    const e = [...document.querySelector("book-toc").shadowRoot.querySelectorAll(".entry")].find((x) => x.textContent.trim() === t);
    e?.click();
  }, title);
const focusReader = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

for (const engine of ENGINES) {
  // One browser and one signed-in context per engine; the sample is imported once into
  // it (the launch and the import are the costly parts on a small host), then each case
  // opens a fresh page over the warm cache. The book stays at its first chapter, so a
  // fresh open shows Chapter One as current.
  describe(`the contents in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    before(async () => {
      browser = await engine.launch();
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      await page.locator("book-shelf input[type=file]").setInputFiles(SAMPLE);
      await waitTile(page);
      // Warm the reader path so no case pays the cold chapter fetch and pagination.
      await clickTile(page);
      await waitReaderReady(page);
      await page.close();
    }, { timeout: 40000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    const open = async (opts = {}) => {
      const problems = [];
      const page = await context.newPage();
      await page.setViewportSize(opts.viewport ?? { width: 1024, height: 768 });
      watch(page, problems, opts.ignoreAborts);
      if (opts.phone) await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-toc")?.shadowRoot && document.querySelector("book-shelf")?.shadowRoot && document.querySelector("book-reader")?.shadowRoot);
      if (opts.phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await waitTile(page);
      await clickTile(page);
      await waitReaderReady(page);
      return { page, problems };
    };

    test("lists the contents with nesting and marks the current chapter", async () => {
      const { page, problems } = await open();
      try {
        await openContents(page);
        await page.waitForFunction(() => (document.querySelector("book-toc")?.shadowRoot?.querySelectorAll(".entry").length ?? 0) >= 4, undefined, WAIT);
        assert.deepEqual(await tocRows(page), [
          { title: "Chapter One", level: 1, current: true },
          { title: "Chapter Two", level: 1, current: false },
          { title: "The Middle", level: 2, current: false },
          { title: "Chapter Three", level: 1, current: false },
        ]);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    test("the highlight follows a page turn into the next chapter", async () => {
      const { page, problems } = await open();
      try {
        await openContents(page);
        await waitTocCurrent(page, "Chapter One");
        // A page turn past the one-page first chapter loads the second; its place is
        // announced (throttled) and rides book.changed, so the highlight moves with it.
        await focusReader(page);
        await page.keyboard.press("ArrowRight");
        await waitReaderChapter(page, "Chapter Two");
        await waitTocCurrent(page, "Chapter Two");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    test("choosing a chapter moves the reader and the highlight", async () => {
      const { page, problems } = await open();
      try {
        await openContents(page);
        await clickEntry(page, "Chapter Three");
        // The click marks the chosen chapter at once (the jump), well before the
        // reader's settle and its ~600ms announcement travel back as a book.changed.
        await page.waitForFunction(
          () => [...(document.querySelector("book-toc")?.shadowRoot?.querySelectorAll(".entry.current") ?? [])].some((e) => e.textContent.trim() === "Chapter Three"),
          undefined,
          { timeout: 250, polling: 20 },
        );
        // Then the jump lands the reader on the chapter's first page, whose settled
        // place is announced, and the fact confirms the mark it already showed.
        await waitReaderChapter(page, "Chapter Three");
        await waitTocCurrent(page, "Chapter Three");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    test("on the phone the drawer's contents jump the reader, then fold away", async () => {
      const { page, problems } = await open({ phone: true });
      try {
        // The left dock is a drawer on the phone; open it if it is resting as a rail.
        await page.evaluate(() => {
          const dd = document.querySelector("dock-desk").shadowRoot;
          if (dd.querySelector(".dock.left")?.classList.contains("folded")) dd.querySelector(".dock.left .rail")?.click();
        });
        await page.waitForFunction(() => !document.querySelector("dock-desk").shadowRoot.querySelector(".dock.left")?.classList.contains("folded"), undefined, WAIT);
        await openContents(page);
        await clickEntry(page, "Chapter Three");
        await waitReaderChapter(page, "Chapter Three");
        // The scrim is the one-step, forgiving close: tap it and the drawer folds back
        // to its rail, uncovering the reader on the chosen chapter.
        await page.evaluate(() => document.querySelector("dock-desk").shadowRoot.querySelector(".scrim")?.click());
        await page.waitForFunction(() => {
          const s = document.querySelector("dock-desk").shadowRoot.querySelector(".scrim");
          return !s || getComputedStyle(s).visibility === "hidden";
        }, undefined, WAIT);
        await new Promise((r) => setTimeout(r, 350));
        assert.equal(await readerChapter(page), "Chapter Three", "the reader is on the chosen chapter");

        mkdirSync(SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(SCREENSHOTS, `books-toc-phone-${engine.name}.png`) });
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });
  });
}
