import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = resolve(HERE, "..", "..", "..", ".screenshots");
const FIXTURES = resolve(HERE, "..", "..", "books", "tests", "fixtures");
const SAMPLE = resolve(FIXTURES, "sample.epub");
const BROKEN = resolve(FIXTURES, "broken.epub");
const GAPS = resolve(FIXTURES, "gaps.epub");
// The "Vim keys" preference (12), seeded the way settings stores it (the workshop
// profile, since the page is under /workshop/).
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// The trace lines that prove the round trip through the bus (section 10): the shelf
// announces a gesture, books answers with its own news.
// A book added straight through the server (5), for a case about the shelf rather
// than the picker. The id is a fixed ULID; each case is its own user.
const SAMPLE_ID = "01K00000000000000000000SMP";
const importBook = async (cookie, id, file) => {
  const res = await fetch(`${BASE_URL}/api/books/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/epub+zip", Cookie: `unblent_session=${cookie}` },
    body: readFileSync(file),
  });
  assert.equal(res.status, 200, `importing ${file}`);
};

const REFUSED = /event book\.refused books → .*\bnotice-stack\b.* delivered/;
const CHANGED = /event book\.changed books → .*\bbook-shelf\b.* delivered/;
const DISCARDED = /event book\.discarded book-shelf → books delivered/;
const DELETED = /event book\.deleted books → .*\bbook-shelf\b.* delivered/;

async function until(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function watch(page, problems) {
  page.on("console", (msg) => {
    // A refused import is a 422 by design (an unreadable file); the browser logs that
    // response as a failed resource, which is expected here, not a fault.
    if (msg.type() === "error" && !/\/api\/books\//.test(msg.text()) && !/status of 422/.test(msg.text()))
      problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400 && !/\/api\/books\//.test(res.url())) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
}

// The shelf's own shadow, read as the user sees it: each real tile's title and
// whether it is the open one; imports in flight are the .adding tiles.
const tiles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile:not(.adding)")].map((t) => ({
      title: t.querySelector(".title").textContent.trim(),
      selected: t.getAttribute("aria-selected") === "true",
    })),
  );
const emptyText = (page) =>
  page.evaluate(() => document.querySelector("book-shelf").shadowRoot.querySelector(".empty p")?.textContent.trim() ?? null);
const noticeTexts = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("notice-stack")?.shadowRoot?.querySelectorAll(".notice p") ?? [])].map((p) =>
      p.textContent.trim(),
    ),
  );
const setFile = (page, path) => page.locator("book-shelf input[type=file]").setInputFiles(path);
const clickBin = (page, title) =>
  page.evaluate((title) => {
    const root = document.querySelector("book-shelf").shadowRoot;
    [...root.querySelectorAll(".tile")]
      .find((t) => t.querySelector(".title")?.textContent.trim() === title)
      ?.querySelector(".bin")
      ?.click();
  }, title);
const clickEdit = (page, title) =>
  page.evaluate((title) => {
    const root = document.querySelector("book-shelf").shadowRoot;
    [...root.querySelectorAll(".tile")]
      .find((t) => t.querySelector(".title")?.textContent.trim() === title)
      ?.querySelector(".edit")
      ?.click();
  }, title);
const clickUndo = (page, title) =>
  page.evaluate((title) => {
    const root = document.querySelector("book-shelf").shadowRoot;
    [...root.querySelectorAll(".tile")]
      .find((t) => t.querySelector(".title")?.textContent.trim() === title)
      ?.querySelector(".undo")
      ?.click();
  }, title);
// Shorten the undo window and remount the shelf so the actor reads the new value
// (--duration-undo is read once, at mount); the book itself is kept by the fact, so
// the remounted shelf re-queries books: list and shows it again.
const shortUndo = (page, ms = 150) =>
  page.evaluate((ms) => {
    const el = document.querySelector("book-shelf");
    el.style.setProperty("--duration-undo", `${ms}ms`);
    const parent = el.parentNode;
    const next = el.nextSibling;
    el.remove();
    parent.insertBefore(el, next);
  }, ms);

const forgeCookie = () => {
  const SECRET = process.env.SESSION_SECRET;
  assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");
  const userId = `book-shelf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
};

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

for (const engine of ENGINES) {
  // Signed out: the shelf invites a sign-in, and a picked file is refused (the fact
  // mints nothing anonymously, 5), which notice-stack shows.
  test(`the shelf refuses an import when signed out in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const debug = [];
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => msg.type() === "debug" && debug.push(msg.text()));
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);

      // session: read (asked by session-switch) settles the signed-out picture.
      await until(async () => (await emptyText(page)) === "Sign in to add books");

      await setFile(page, SAMPLE);
      await until(() => debug.some((l) => REFUSED.test(l)));
      await until(async () => (await noticeTexts(page)).includes("Sign in to continue."));
      assert.deepEqual(await tiles(page), [], "no tile is added when signed out");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // Signed in, the whole library lifecycle shares one browser per engine: the launch
  // is the costly part on a small host. Each case is a new user in a context of its
  // own, so its shelf holds only what it put there (11.2).
  describe(`the shelf imports, opens and deletes books in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    afterEach(async () => {
      await context?.close();
      context = null;
    });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    const open = async (opts = {}) => {
      const problems = [];
      const debug = [];
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: opts.cookie ?? forgeCookie(), url: BASE_URL }]);
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => msg.type() === "debug" && debug.push(msg.text()));
      if (opts.phone) await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
      if (opts.vimKeys != null) await page.addInitScript((v) => localStorage.setItem("settings", v), seed(opts.vimKeys));
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      if (opts.phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      return { page, problems, debug };
    };

    test("a picked epub becomes a tile with its cover", async () => {
      const { page, problems, debug } = await open();
      await setFile(page, SAMPLE);
      await until(() => debug.some((l) => CHANGED.test(l)));
      await until(async () => (await tiles(page)).some((t) => t.title === "Sample Book"));
      // The cover image loaded (watch flags any 4xx), so the tile is not the titled
      // placeholder: it holds an <img> that resolved.
      const hasCover = await page.evaluate(() => {
        const t = [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile")].find(
          (t) => t.querySelector(".title")?.textContent.trim() === "Sample Book",
        );
        const img = t?.querySelector(".cover img");
        return Boolean(img && img.naturalWidth > 0);
      });
      assert.ok(hasCover, "the cover image resolved");
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      await page.close();
    });

    test("renaming a book in place updates the tile and reaches the server (D11)", async () => {
      const { page, problems } = await open();
      await setFile(page, SAMPLE);
      await until(async () => (await tiles(page)).some((t) => t.title === "Sample Book"));
      // Let the import settle before editing: an in-flight import keeps re-rendering the
      // grid, which detaches the field mid-fill on a slower engine. No .adding tile means
      // the shelf is stable, so the edit lands on a tile that stays put.
      await until(async () =>
        page.evaluate(() => document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile.adding").length === 0),
      );

      await clickEdit(page, "Sample Book");
      const input = page.locator("book-shelf .title-input");
      await input.waitFor();
      await input.fill("My Renamed Book");
      // The write drains on its own debounce (5); wait for that ack so the round trip
      // is proven, not just the instant local change.
      const titledOk = page.waitForResponse(
        (res) => /\/api\/books\/[^/]+\/title$/.test(res.url()) && res.ok(),
        { timeout: 4000 },
      );
      await input.press("Enter");
      await until(async () => (await tiles(page)).some((t) => t.title === "My Renamed Book"));
      // Enter saves the title and nothing more: it does not open the book (a book.selected
      // the "Contents" tab follows), so the renamed tile is not selected.
      assert.ok(
        !(await tiles(page)).find((t) => t.title === "My Renamed Book").selected,
        "saving a rename did not open the book",
      );
      // A tab regaining focus drains at once (5), so the write need not wait out its
      // debounce window; this keeps the test well under its budget.
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await titledOk;
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      await page.close();
    });

    test("a broken file is refused with a message and no tile", async () => {
      const { page, problems } = await open();
      const before = (await tiles(page)).length;
      await setFile(page, BROKEN);
      await until(async () => (await noticeTexts(page)).includes("This file is not an epub."));
      // The placeholder that stood while the import was tried is gone again.
      await until(async () => (await page.evaluate(() => document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile.adding").length)) === 0);
      assert.equal((await tiles(page)).length, before, "no tile was added for a broken file");
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      await page.close();
    });

    test("delete offers undo, then commits when its window ends and stays gone", async () => {
      const cookie = forgeCookie();
      await importBook(cookie, SAMPLE_ID, SAMPLE);
      const { page, problems, debug } = await open({ cookie });
      await until(async () => (await tiles(page)).some((t) => t.title === "Sample Book"));

      // Undo brings the book straight back, and no book.discarded was ever emitted.
      await clickBin(page, "Sample Book");
      await until(async () =>
        page.evaluate(() => Boolean(document.querySelector("book-shelf").shadowRoot.querySelector(".tile.discarding"))),
      );
      await clickUndo(page, "Sample Book");
      await until(async () =>
        page.evaluate(() => !document.querySelector("book-shelf").shadowRoot.querySelector(".tile.discarding")),
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!debug.some((l) => DISCARDED.test(l)), "undo emits no discard");
      assert.ok((await tiles(page)).some((t) => t.title === "Sample Book"), "the book is still there");

      // A short window, so the bar drains and the delete becomes a fact; the book is
      // tombstoned and its files purged (the reader/image routes would 404 after).
      await shortUndo(page);
      await until(async () => (await tiles(page)).some((t) => t.title === "Sample Book"));
      // Wait for the tombstone's ack before reloading, so no write is left in flight to be
      // torn down (that would surface as a fault), and so the reload's pull sees the
      // tombstone on the server.
      const deletedOk = page.waitForResponse(
        (res) => /\/api\/books\/[^/]+\/deleted$/.test(res.url()) && res.ok(),
        { timeout: 4000 },
      );
      await clickBin(page, "Sample Book");
      await until(() => debug.some((l) => DISCARDED.test(l)) && debug.some((l) => DELETED.test(l)));
      await until(async () => !(await tiles(page)).some((t) => t.title === "Sample Book"));
      // A tab regaining focus drains at once (5), so the tombstone need not wait out its
      // debounce window. It then pulls; that pull must land too, or the reload cancels it.
      const pulled = page.waitForResponse((res) => /\/api\/books\?since=/.test(res.url()), { timeout: 4000 });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await deletedOk;
      await pulled;

      // A reload pulls the tombstone: the book does not come back (5).
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      await until(async () => (await emptyText(page)) !== null || (await tiles(page)).length >= 0);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!(await tiles(page)).some((t) => t.title === "Sample Book"), "it stays gone after a reload");
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      await page.close();
    });

    test("the phone preview lays the shelf out within the window", async () => {
      const { page, problems } = await open({ phone: true });
      await setFile(page, SAMPLE);
      await until(async () => (await tiles(page)).some((t) => t.title === "Sample Book"));
      const fits = await page.evaluate(() => {
        const el = document.querySelector("book-shelf");
        return el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1;
      });
      assert.ok(fits, "the shelf does not overflow sideways on the phone");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(SCREENSHOTS, `books-shelf-phone-${engine.name}.png`) });
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      await page.close();
    });
    const twoBooks = async (vimKeys) => {
      const cookie = forgeCookie();
      await importBook(cookie, SAMPLE_ID, SAMPLE);
      await importBook(cookie, "01K00000000000000000000GPS", GAPS);
      const opened = await open({ cookie, vimKeys });
      await until(async () => (await tiles(opened.page)).length === 2);
      return opened;
    };
    const focusedTile = (page) =>
      page.evaluate(() => document.querySelector("book-shelf").shadowRoot.activeElement?.querySelector(".title")?.textContent.trim() ?? null);
    // The roving tile, where Tab lands on the shelf: the first while no book is open.
    const focusShelf = (page) => page.evaluate(() => document.querySelector("book-shelf").shadowRoot.querySelector('.tile[tabindex="0"]').focus());

    // Which tile has focus, by its place in the grid, since the four books share a title.
    const focusedAt = (page) =>
      page.evaluate(() => {
        const root = document.querySelector("book-shelf").shadowRoot;
        return [...root.querySelectorAll(".tile")].indexOf(root.activeElement);
      });
    // The columns as the grid wrapped them at this width, read the way the shelf reads them.
    const columns = (page) =>
      page.evaluate(() => {
        const all = [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile")];
        return all.filter((t) => t.offsetTop === all[0].offsetTop).length;
      });
    const pressTo = async (page, key, at) => {
      await page.keyboard.press(key);
      await until(async () => (await focusedAt(page)) === at);
    };

    test("the keys move through the shelf as a grid, and with Vim keys on hjkl, G and gg do too", async () => {
      const cookie = forgeCookie();
      await Promise.all(
        ["01K00000000000000000000GR1", "01K00000000000000000000GR2", "01K00000000000000000000GR3", "01K00000000000000000000GR4"].map(
          (id) => importBook(cookie, id, SAMPLE),
        ),
      );
      const { page, problems } = await open({ cookie, vimKeys: true });
      await until(async () => (await tiles(page)).length === 4);
      const cols = await columns(page);
      assert.equal(cols, 2, "the desk's side panel wraps four tiles into two rows of two");
      await focusShelf(page);
      assert.equal(await focusedAt(page), 0);
      await pressTo(page, "ArrowRight", 1);
      await pressTo(page, "ArrowDown", 1 + cols);
      await pressTo(page, "ArrowUp", 1);
      await pressTo(page, "h", 0);
      await pressTo(page, "j", cols);
      await pressTo(page, "k", 0);
      await pressTo(page, "l", 1);
      await pressTo(page, "G", 3);
      await page.keyboard.press("g");
      await pressTo(page, "g", 0);
      await page.keyboard.press("Enter");
      await until(async () => (await tiles(page))[0].selected === true);
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      await page.close();
    });

    test("with Vim keys off, j does nothing on the shelf", async () => {
      const { page, problems } = await twoBooks(false);
      const [first] = (await tiles(page)).map((t) => t.title);
      await focusShelf(page);
      assert.equal(await focusedTile(page), first);
      await page.keyboard.press("j");
      await page.keyboard.press("G");
      await page.waitForTimeout(200);
      assert.equal(await focusedTile(page), first);
      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      await page.close();
    });
  });
}
