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
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
// One chapter with a wide picture printed sideways, among paragraphs (make_plate.py).
const PLATE = resolve(HERE, "fixtures", "plate.epub");
const PLATE_ID = "01K00000000000000000000PTE";

// The turn is announced once it settles (throttled), routed to books (section 10).
const PROGRESSED = /event book\.progressed book-reader → .*\bbooks\b.* delivered/;

const forgeCookie = () => {
  const SECRET = process.env.SESSION_SECRET;
  assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");
  const userId = `book-reader-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
};

// A book added straight through the server (5): the import itself takes milliseconds,
// so a suite's shared books cost nothing in the browser. The id is a fixed ULID.
const SAMPLE_ID = "01K00000000000000000000SMP";
const importBook = async (cookie, id, file) => {
  const res = await fetch(`${BASE_URL}/api/books/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/epub+zip", Cookie: `unblent_session=${cookie}` },
    body: readFileSync(file),
  });
  assert.equal(res.status, 200, `importing ${file}`);
};
const putJson = async (cookie, path, body) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `PUT ${path}`);
};

function watch(page, problems) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
}

// Every wait runs inside the browser (waitForFunction with a fixed poll), so a busy
// host pays one round trip per wait rather than one per poll — what keeps each case
// inside the per-test budget. The reader's own footer is the source of truth.
const foot = () => {
  const r = document.querySelector("book-reader")?.shadowRoot;
  const chap = r?.querySelector(".footer .chap")?.textContent.trim() ?? "";
  const m = (r?.querySelector(".footer .pageno")?.textContent.trim() ?? "").match(/Page (\d+) of (\d+)/);
  return { chap, page: m ? Number(m[1]) : 0, pages: m ? Number(m[2]) : 0 };
};
const WAIT = { timeout: 4000, polling: 100 };
// The "Vim keys" preference (12), seeded the way settings stores it (the workshop
// profile, since the page is under /workshop/).
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });
const waitChapter = (page, chap) => page.waitForFunction((c) => { const r = document.querySelector("book-reader")?.shadowRoot; return r?.querySelector(".footer .chap")?.textContent.trim() === c; }, chap, WAIT);
const waitChapterPage = (page, chap, n) => page.waitForFunction(({ c, n }) => { const r = document.querySelector("book-reader")?.shadowRoot; if (r?.querySelector(".footer .chap")?.textContent.trim() !== c) return false; const m = (r?.querySelector(".footer .pageno")?.textContent.trim() ?? "").match(/Page (\d+)/); return m && Number(m[1]) === n; }, { c: chap, n }, WAIT);
const waitPagesAtLeast = (page, chap, min) => page.waitForFunction(({ c, min }) => { const r = document.querySelector("book-reader")?.shadowRoot; if (r?.querySelector(".footer .chap")?.textContent.trim() !== c) return false; const m = (r?.querySelector(".footer .pageno")?.textContent.trim() ?? "").match(/of (\d+)/); return m && Number(m[1]) >= min; }, { c: chap, min }, WAIT);
const waitTile = (page) => page.waitForFunction(() => [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile:not(.adding)") ?? [])].some((t) => t.querySelector(".title")?.textContent.trim() === "Sample Book"), undefined, { timeout: 8000, polling: 100 });
const rstate = (page) => page.evaluate(foot);
// The strip slides to a turned page; a gesture measured mid-slide lands off the text.
const waitStill = (page) =>
  page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot?.getAnimations().every((a) => a.playState !== "running"), undefined, WAIT);
// Until the reader is at rest: its deferred re-measure after a chapter loads has run (two
// frames, or its 120 ms fallback timer, whichever is later here), so a turn cannot race
// it, and no slide is still moving the strip. Waited in the page, in its own clock.
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = document.querySelector("book-reader").shadowRoot;
        const still = () => (r.getAnimations().every((a) => a.playState !== "running") ? resolve() : requestAnimationFrame(still));
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(still)), 130);
      }),
  );
const focusReader = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());
const clickTile = (page) =>
  page.evaluate(() => {
    const t = [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile:not(.adding)")].find(
      (x) => x.querySelector(".title")?.textContent.trim() === "Sample Book",
    );
    t?.click();
  });

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

for (const engine of ENGINES) {
  // One browser and one user per engine (the launch is the costly part on a small
  // host); the sample is imported once on the server for that user, and each case
  // opens it in a context of its own, so no case starts from another's storage (11.2).
  describe(`the reader in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let cookie;
    let context;
    before(async () => {
      browser = await engine.launch();
      cookie = forgeCookie();
      await importBook(cookie, SAMPLE_ID, SAMPLE);
    }, { timeout: 30000 });
    afterEach(async () => {
      await context?.close();
      context = null;
    });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Open the book from the shelf and rewind to the first page (openAndRewind). Home
    // jumps to the top of a chapter and ArrowLeft steps to the previous one, so three
    // pairs reach Chapter One from anywhere in this three-chapter book without paging
    // through it.
    const open = async (opts = {}) => {
      const problems = [];
      const debug = [];
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: opts.cookie ?? cookie, url: BASE_URL }]);
      const page = await context.newPage();
      await page.setViewportSize(opts.viewport ?? { width: 1024, height: 768 });
      watch(page, problems);
      page.on("console", (msg) => msg.type() === "debug" && debug.push(msg.text()));
      if (opts.phone) await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
      if (opts.vimKeys != null) await page.addInitScript((v) => localStorage.setItem("settings", v), seed(opts.vimKeys));
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot && document.querySelector("book-shelf")?.shadowRoot);
      if (opts.phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      if (opts.shelf !== false) await waitTile(page);
      return { page, problems, debug };
    };
    const openAndRewind = async (opts) => {
      const ctx = await open(opts);
      await clickTile(ctx.page);
      await ctx.page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot?.querySelector(".footer .chap")?.textContent.trim());
      await focusReader(ctx.page);
      for (let i = 0; i < 3; i++) {
        await ctx.page.keyboard.press("Home");
        await ctx.page.keyboard.press("ArrowLeft");
      }
      await waitChapterPage(ctx.page, "Chapter One", 1);
      return ctx;
    };
    // A user of the test's own, set up through the server, whose book is open at the
    // start of Chapter Two: the reader reopens it there on load, with no click and no
    // turn into the chapter first. For a test about what happens inside a chapter.
    const openInChapterTwo = async (opts = {}) => {
      const own = forgeCookie();
      await importBook(own, SAMPLE_ID, SAMPLE);
      await Promise.all([
        putJson(own, `/api/books/${SAMPLE_ID}/position`, { chapter: 1, block: 0 }),
        putJson(own, `/api/books/${SAMPLE_ID}/opened`, {}),
      ]);
      const ctx = await open({ ...opts, cookie: own });
      await waitPagesAtLeast(ctx.page, "Chapter Two", 3);
      assert.equal((await rstate(ctx.page)).page, 1, "the book reopens at the start of Chapter Two");
      await focusReader(ctx.page);
      await settle(ctx.page);
      return ctx;
    };

    // Browser: focus and keys.
    test("with Vim keys on, Ctrl+f and Ctrl+d/Ctrl+u turn the page, across a chapter too", async () => {
      const { page, problems } = await openAndRewind({ vimKeys: true });
      try {
        await page.keyboard.press("Control+f");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle(page);
        await page.keyboard.press("Control+d");
        await waitChapterPage(page, "Chapter Two", 2);
        await page.keyboard.press("Control+u");
        await waitChapterPage(page, "Chapter Two", 1);
        await page.keyboard.press("Control+f");
        await waitChapterPage(page, "Chapter Two", 2);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, G and gg reach the chapter's ends and Ctrl+b turns back across a chapter", async () => {
      const { page, problems } = await openInChapterTwo({ vimKeys: true });
      try {
        await page.keyboard.press("G");
        const { pages } = await rstate(page);
        await waitChapterPage(page, "Chapter Two", pages);
        await waitStill(page);
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        await waitChapterPage(page, "Chapter Two", 1);
        await waitStill(page);
        await page.keyboard.press("Control+b");
        await waitChapterPage(page, "Chapter One", 1);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys off, Ctrl+f and l do not turn the page", async () => {
      const { page, problems } = await openAndRewind({ vimKeys: false });
      try {
        await page.keyboard.press("Control+f");
        await page.keyboard.press("l");
        await page.keyboard.press("G");
        await settle(page);
        assert.deepEqual(await rstate(page), { chap: "Chapter One", page: 1, pages: 1 });
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: rendering and layout.
    test("opens a selected book at its first page, paginates a long chapter, turns a page, and announces the place", async () => {
      const { page, problems, debug } = await openAndRewind();
      try {
        assert.deepEqual(await rstate(page), { chap: "Chapter One", page: 1, pages: 1 }, "shows the first chapter's one page");
        // Next past the one-page first chapter crosses into the second, which slides in
        // like any turn (Norman): watch every frame across the turn for the leaving strip
        // and a moving one (the slide is on the translate property, both strips at once).
        await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          window.__slid = { leaving: false, moved: false };
          const t0 = performance.now();
          const tick = () => {
            if (r.querySelector(".strip.leaving")) window.__slid.leaving = true;
            for (const s of r.querySelectorAll(".strip")) {
              const t = getComputedStyle(s).translate;
              if (t && t !== "none") window.__slid.moved = true;
            }
            if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        assert.equal((await rstate(page)).page, 1, "the new chapter opens at its first page");

        // A turn within the chapter advances the page; its top block is not the first.
        await settle(page);
        assert.ok(
          await page.evaluate(() => window.__slid.leaving && window.__slid.moved),
          "crossing into the next chapter slid a fresh strip in",
        );
        const rest = await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          return { count: r.querySelectorAll(".strip").length, translate: getComputedStyle(r.querySelector(".strip")).translate };
        });
        assert.equal(rest.count, 1, "the leaving strip is gone once the slide ends");
        assert.equal(rest.translate, "none", "the settled strip sits at rest");
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);

        // The turn is announced once it settles (throttled), routed to books.
        await waitForTrace(debug, PROGRESSED);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: a reload against real storage.
    test("keeps the reading place across a reload", async () => {
      const { page, problems, debug } = await openAndRewind();
      try {
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle(page);
        // Turn a few pages in, onto a page a normal paragraph begins (past the long
        // opening one, whose start page a saved block would reopen at): what is
        // persisted is the top block (section 12), so the block must start here for
        // the reopen to land past the first page.
        for (let page_ = 2; page_ <= 4; page_++) {
          await page.keyboard.press("ArrowRight");
          await waitChapterPage(page, "Chapter Two", page_);
        }
        const seen = debug.length;
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 5);

        // The place is announced once the last turn settles (book.progressed, throttled)
        // and books keeps it; a nudge sends it to the server at once rather than after
        // the 2 s network debounce (5), and its answer is the sign the place is kept.
        await waitForTrace(debug, PROGRESSED, 3000, seen);
        // A visible tab's sync drains, then pulls; the reload waits for both answers.
        const kept = page.waitForResponse((res) => /\/api\/books\/[^/]+\/position$/.test(new URL(res.url()).pathname));
        const pulled = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/books" && res.request().method() === "GET");
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await Promise.all([kept, pulled]);

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
        await waitTile(page);
        // No click: the open book is a fact `books` owns now, so the reader reopens it
        // on its own after a reload, where it was left — the same chapter, past its
        // first page (the block was kept; the exact page number is per device, section
        // 12, so the invariant is the chapter and a non-first page, not a fixed number).
        await page.waitForFunction(() => {
          const r = document.querySelector("book-reader")?.shadowRoot;
          if (r?.querySelector(".footer .chap")?.textContent.trim() !== "Chapter Two") return false;
          const m = (r?.querySelector(".footer .pageno")?.textContent.trim() ?? "").match(/Page (\d+)/);
          return m && Number(m[1]) >= 2;
        }, undefined, WAIT);
        // The shelf shows the same book as the open one, without a gesture.
        await page.waitForFunction(() =>
          [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile") ?? [])].some(
            (t) => t.getAttribute("aria-selected") === "true" && t.querySelector(".title")?.textContent.trim() === "Sample Book",
          ),
        );
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: rendering and layout.
    test("keeps the same block when the viewport resizes", async () => {
      const { page, problems } = await openAndRewind();
      try {
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle(page);
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);
        // The footer turns at once; the strip is still sliding for a moment, and a block
        // measured mid-slide could be one on its way out.
        await settle(page);
        const before = await topText(page);
        assert.ok(before.length > 0, "there is a top block to keep");

        // The narrower, taller page re-paginates from the chapter's start, so the block
        // cannot be promised the top of a page; what is promised is that the page shown
        // is the one holding it (section 12).
        await page.setViewportSize({ width: 760, height: 900 });
        await page.waitForFunction((t) => {
          const r = document.querySelector("book-reader").shadowRoot;
          const vp = r.querySelector(".viewport").getBoundingClientRect();
          return [...r.querySelector(".strip").children].some((b) => {
            const x = b.getBoundingClientRect();
            return x.right > vp.left + 1 && x.left < vp.right - 1 && b.textContent.trim().slice(0, 40) === t;
          });
        }, before, WAIT);
        assert.equal((await rstate(page)).chap, "Chapter Two", "still in the same chapter after a resize");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Folding the left dock widens the reader, which re-paginates the chapter, exactly
    // as opening the right dock narrows it on the product page. The place must survive the
    // round trip: the same page and the same first line after fold then unfold.
    // Browser: rendering and layout.
    test("keeps the page across a dock fold", async () => {
      const { page, problems } = await openInChapterTwo({ viewport: { width: 760, height: 768 } });
      try {
        await ensureLeftOpen(page);
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);
        await settle(page);
        const before = { ...(await rstate(page)), top: await topText(page), w: await readerWidth(page) };
        assert.ok(before.top.length > 0, "there is a top line to keep");

        await foldLeft(page);
        await waitReaderWider(page, before.w);
        assert.equal((await rstate(page)).chap, "Chapter Two", "still the same chapter while folded");
        await page.waitForFunction((t) => {
          const r = document.querySelector("book-reader").shadowRoot;
          const vp = r.querySelector(".viewport").getBoundingClientRect();
          return [...r.querySelector(".strip").children].some((b) => {
            const x = b.getBoundingClientRect();
            return x.right > vp.left + 1 && x.left < vp.right - 1 && b.textContent.trim().slice(0, 40) === t;
          });
        }, before.top, WAIT);

        await unfoldLeft(page);
        await waitReaderWidth(page, before.w);
        await settle(page);
        const after = { ...(await rstate(page)), top: await topText(page) };
        assert.equal(after.page, before.page, "the same page number after the round trip");
        assert.equal(after.top, before.top, "the same first line after the round trip");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // A paragraph longer than a page: a reader page sits inside it, with no block
    // starting there. Only a character offset can name that place; a block-only anchor
    // would jump to the paragraph's start after a fold. (Chapter Two opens with one
    // paragraph that outruns a page, so a page turn into it lands inside it.)
    // Browser: rendering and layout.
    test("keeps the place inside a paragraph longer than a page", async () => {
      const { page, problems } = await openInChapterTwo({ viewport: { width: 760, height: 768 } });
      try {
        await ensureLeftOpen(page);
        // One turn into Chapter Two, into the long paragraph: the page then shows it with
        // no block starting on it.
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);
        await settle(page);

        // The shown page is inside the long paragraph: no block starts on it, so the
        // place is a character offset, not a block. (This is the page a block-only
        // anchor cannot name: it would fall back to the paragraph's start.)
        await page.waitForFunction(insideLongParagraph, undefined, WAIT);
        const before = { ...(await rstate(page)), w: await readerWidth(page) };

        // Fold, which widens and re-paginates, then unfold back. Folding may bring the
        // offset onto the paragraph's first page (a wider column holds more of it), so
        // the proof is the round trip: it returns to the very same page, inside the
        // paragraph. A block anchor would have come back to its start instead.
        await foldLeft(page);
        await waitReaderWider(page, before.w);
        await settle(page);
        assert.equal((await rstate(page)).chap, "Chapter Two", "still the same chapter while folded");

        await unfoldLeft(page);
        await waitReaderWidth(page, before.w);
        await settle(page);
        assert.equal((await rstate(page)).page, before.page, "the same page number after the round trip");
        assert.ok(await page.evaluate(insideLongParagraph), "back inside the long paragraph after the round trip, not at its start");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // WebKit resolves a transform's percentage against the pixel-snapped box, so a
    // slide written in the strip's own 100% fell a fraction short of every column and
    // the text crept sideways page by page. A fractional, narrow page makes it show.
    // Browser: rendering and layout.
    test("a late page sits on its column at a fractional page width", async () => {
      const { page, problems } = await openAndRewind();
      try {
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await page.evaluate(() => { document.querySelector("book-reader").shadowRoot.querySelector(".page").style.width = "200.5px"; });
        await waitPagesAtLeast(page, "Chapter Two", 8);
        await settle(page);
        await page.keyboard.press("End");
        await settle(page);
        const { shown, off } = await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const pg = r.querySelector(".page");
          const left = pg.getBoundingClientRect().left + parseFloat(getComputedStyle(pg).paddingLeft);
          const lefts = [...r.querySelector(".strip").children].flatMap((b) => [...b.getClientRects()].map((x) => x.left - left));
          return { shown: Number(r.querySelector(".strip").style.getPropertyValue("--page")), off: lefts.reduce((a, x) => (Math.abs(x) < Math.abs(a) ? x : a), Infinity) };
        });
        assert.ok(shown >= 7, `the last page is a late one (page ${shown})`);
        assert.ok(Math.abs(off) < 0.1, `the column sits on the page's edge (off by ${off}px on page ${shown})`);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: rendering and layout.
    test("a jump from the contents lands on the chapter's first page without sliding", async () => {
      const { page, problems } = await openAndRewind();
      try {
        // Leave the second chapter on its second page, so the strip is slid.
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle(page);
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);

        // Sample the strip's transform every frame across the jump, in the browser: from
        // the frame the footer names the new chapter, the strip must already sit at its
        // first page, never in motion from where the old chapter was left.
        await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const strip = r.querySelector(".strip");
          window.__slid = [];
          const t0 = performance.now();
          const tick = () => {
            const m = getComputedStyle(strip).transform;
            const tr = getComputedStyle(strip).translate;
            // A jump has nowhere to slide from: neither the transform (page within a
            // chapter) nor the translate (a chapter-crossing slide) ever moves, and no
            // leaving strip is ever handed over.
            if (r.querySelector(".footer .chap").textContent.trim() === "Chapter Three" && m !== "none" && m !== "matrix(1, 0, 0, 1, 0, 0)") window.__slid.push(m);
            if (r.querySelector(".strip.leaving") || (tr && tr !== "none")) window.__slid.push(tr);
            if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.evaluate(() => {
          const dd = document.querySelector("dock-desk").shadowRoot;
          [...dd.querySelectorAll('.dock.left [role="tab"]')].find((t) => t.textContent.trim() === "Contents")?.click();
        });
        await page.evaluate(() => [...document.querySelector("book-toc").shadowRoot.querySelectorAll(".entry")].find((e) => e.textContent.trim() === "Chapter Three")?.click());
        await waitChapterPage(page, "Chapter Three", 1);
        await settle(page);
        assert.deepEqual(await page.evaluate(() => window.__slid), [], "the strip was never in motion over the new chapter");

        // The inline emoji is a text-height glyph, and its long code line stays within
        // the column instead of leaking onto the next page (the reader's image and
        // pre rules). The emoji is on the chapter's first page beside its listing.
        const glyph = await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const img = [...r.querySelectorAll(".strip img")].find((i) => /Smiling face emoji/.test(i.alt));
          if (!img) return null;
          const pre = img.closest("pre");
          const ps = getComputedStyle(pre);
          return {
            h: img.getBoundingClientRect().height,
            em: parseFloat(getComputedStyle(img).fontSize),
            preOverflow: pre.scrollWidth - pre.clientWidth,
            face: ps.fontFamily,
            size: parseFloat(ps.fontSize),
            prose: parseFloat(getComputedStyle(r.querySelector(".strip p")).fontSize),
            ground: ps.backgroundColor,
          };
        });
        // A book may caption a figure with a heading (the O'Reilly h6); it reads as a
        // caption, not a section — the mute size of a <figcaption>, not a heading's.
        const caps = await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const one = (sel) => {
            const el = r.querySelector(sel);
            const cs = getComputedStyle(el);
            return { size: parseFloat(cs.fontSize), weight: cs.fontWeight, color: cs.color };
          };
          return { fc: one(".strip figcaption"), h6: one(".strip figure h6"), h1: one(".strip h1"), prose: one(".strip p") };
        });
        assert.ok(Math.abs(caps.h6.size - caps.fc.size) <= 0.5, `a heading caption (${caps.h6.size}) is set like a figcaption (${caps.fc.size})`);
        assert.ok(caps.h6.size < caps.prose.size, `a caption (${caps.h6.size}) is smaller than the prose (${caps.prose.size})`);
        assert.equal(caps.h6.weight, "400", `a caption is not bold (${caps.h6.weight})`);
        assert.equal(caps.h6.color, caps.fc.color, "a heading caption is muted like a figcaption");
        // A real heading is still a heading at desk width: larger than the prose.
        assert.ok(caps.h1.size > caps.prose.size, `a chapter heading (${caps.h1.size}) stays a heading (prose ${caps.prose.size})`);
        // A definition list reads as pairs: the term set apart in weight, the
        // definition indented beneath it (the reader's dl rules).
        const dl = await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const dt = r.querySelector(".strip dt");
          const dd = r.querySelector(".strip dd");
          if (!dt || !dd) return null;
          return { dt: dt.getBoundingClientRect().left, dd: dd.getBoundingClientRect().left, weight: getComputedStyle(dt).fontWeight };
        });
        assert.ok(dl, "the definition list is on the page");
        assert.ok(dl.dd > dl.dt + 1, `a definition (${dl.dd}) is indented past its term (${dl.dt})`);
        assert.ok(Number(dl.weight) >= 600, `a term is set apart in weight (${dl.weight})`);
        assert.ok(glyph, "the inline emoji image is on the page");
        // A listing reads as code: the mono face, smaller than the prose, on its own ground.
        assert.match(glyph.face, /monospace/, `a listing is set in the mono face (${glyph.face})`);
        assert.ok(glyph.size < glyph.prose, `a listing (${glyph.size}) is smaller than the prose (${glyph.prose})`);
        assert.notEqual(glyph.ground, "rgba(0, 0, 0, 0)", "a listing has its own ground");
        assert.ok(Math.abs(glyph.h - glyph.em) <= 1, `emoji height ${glyph.h} tracks the text size ${glyph.em}`);
        assert.ok(glyph.preOverflow <= 1, `the code line stays in the column (overflow ${glyph.preOverflow})`);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: a gesture.
    test("a swipe turns a page on the phone", async () => {
      const { page, problems } = await openAndRewind({ phone: true });
      try {
        // The shelf opened as a drawer over the stage; close it to read, and wait for
        // the fold to settle so the scrim no longer intercepts the swipe.
        await page.evaluate(() => document.querySelector("dock-desk").shadowRoot.querySelector(".scrim")?.click());
        await page.waitForFunction(() => {
          const s = document.querySelector("dock-desk").shadowRoot.querySelector(".scrim");
          return !s || getComputedStyle(s).visibility === "hidden";
        }, undefined, WAIT);
        await page.waitForFunction(() => document.querySelector("dock-desk").shadowRoot.getAnimations().every((a) => a.playState !== "running"), undefined, WAIT);
        assert.equal((await rstate(page)).chap, "Chapter One", "starts on the first chapter");

        const box = await page.evaluate(() => {
          const vp = document.querySelector("book-reader").shadowRoot.querySelector(".viewport").getBoundingClientRect();
          return { x: vp.x, y: vp.y, w: vp.width, h: vp.height };
        });
        // A leftward finger swipe across the page turns forward — past the one-page
        // first chapter, into the second. Synthetic touch pointer events, since only
        // a finger or pen swipes (a mouse selects) and Playwright's touchscreen has
        // only tap().
        await page.evaluate((b) => {
          const vp = document.querySelector("book-reader").shadowRoot.querySelector(".viewport");
          const y = b.y + b.h / 2;
          const send = (type, x) => vp.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true }));
          send("pointerdown", b.x + b.w * 0.8);
          for (let i = 1; i <= 6; i++) send("pointermove", b.x + b.w * 0.8 - i * 28);
          send("pointerup", b.x + b.w * 0.8 - 6 * 28);
        }, box);
        await waitChapter(page, "Chapter Two");

        // A narrow page steps a heading down (the @container rule): the chapter heading
        // is smaller than the desk heading token, yet still larger than the prose.
        const heads = await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const px = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) * 16;
          return {
            h1: parseFloat(getComputedStyle(r.querySelector(".strip h1")).fontSize),
            prose: parseFloat(getComputedStyle(r.querySelector(".strip p")).fontSize),
            deskHeading: px("--text-heading"),
          };
        });
        assert.ok(heads.h1 < heads.deskHeading, `a phone heading (${heads.h1}) is stepped below the desk heading (${heads.deskHeading})`);
        assert.ok(heads.h1 > heads.prose, `a phone heading (${heads.h1}) is still larger than the prose (${heads.prose})`);

        mkdirSync(SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(SCREENSHOTS, `books-reader-phone-${engine.name}.png`) });
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: a gesture.
    test("a mouse drag selects text and does not turn", async () => {
      const { page, problems } = await openAndRewind();
      try {
        await waitStill(page);
        const before = await rstate(page);
        // Drag across a real line of text in the first block, so the gesture both
        // selects and is long enough (>= SWIPE) to have turned before this change.
        const box = await page.evaluate(() => {
          const sr = document.querySelector("book-reader").shadowRoot;
          const p = sr.querySelector(".strip p, .strip li, .strip h1, .strip h2");
          const r = p.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        // Leftward, so before the change it would have turned forward off the
        // one-page first chapter into the second.
        const y = box.y + box.h / 2;
        const step = Math.max(28, (box.w - 8) / 6);
        await page.mouse.move(box.x + box.w - 4, y);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.w - 4 - i * step, y);
        await page.mouse.up();
        const after = await rstate(page);
        // A leftward drag of this length would have turned before the change; the
        // mouse now selects instead, so the place is untouched.
        assert.equal(after.chap, before.chap, "the chapter did not change");
        assert.equal(after.page, before.page, "the page did not turn");
        // The drag left a text selection (user-select: text on a fine pointer). Read
        // by toString(): WebKit reports a shadow selection collapsed but its text
        // present, so isCollapsed is not portable, its string is.
        const selected = await page.evaluate(() => {
          const sr = document.querySelector("book-reader").shadowRoot;
          const sel = sr.getSelection ? sr.getSelection() : document.getSelection();
          return (sel?.toString() ?? "").trim().length > 0;
        });
        assert.ok(selected, "the drag selected text instead of turning");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // A user of the test's own whose open book is the plate, set up through the server,
    // so the reader opens on the page that holds the wide picture.
    const openPlate = async (opts = {}) => {
      const own = forgeCookie();
      await importBook(own, PLATE_ID, PLATE);
      await Promise.all([putJson(own, `/api/books/${PLATE_ID}/position`, { chapter: 0, block: 0 }), putJson(own, `/api/books/${PLATE_ID}/opened`, {})]);
      const ctx = await open({ ...opts, cookie: own, shelf: false });
      await waitChapterPage(ctx.page, "The Plate", 1);
      await ctx.page.waitForFunction(() => document.querySelector("book-reader").shadowRoot.querySelector(".strip img")?.complete);
      await settle(ctx.page);
      return ctx;
    };
    const plateBox = (page) =>
      page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot.querySelector(".strip img").getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
    const viewer = (page) =>
      page.evaluate(() => {
        const f = document.querySelector("book-reader").shadowRoot.querySelector(".figure");
        if (!f) return null;
        const img = f.querySelector("img");
        const r = img.getBoundingClientRect();
        const b = f.getBoundingClientRect();
        const prop = (n) => f.style.getPropertyValue(n);
        return { rotate: getComputedStyle(img).rotate, turn: prop("--turn"), zoom: prop("--zoom"), x: prop("--x"), img: { w: r.width, h: r.height, x: r.x, y: r.y }, box: { w: b.width, h: b.height, x: b.x, y: b.y } };
      });
    const waitViewer = (page, open) => page.waitForFunction((o) => Boolean(document.querySelector("book-reader").shadowRoot.querySelector(".figure")) === o, open, WAIT);
    const firstText = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".strip p").textContent);

    // Browser: a gesture.
    test("a tap on a picture at either edge opens it, never a page turn, and a tap beside it closes it", async () => {
      const { page, problems } = await openPlate();
      try {
        const before = await rstate(page);
        assert.ok(before.pages > 1, "the plate chapter has a page to turn to");
        const img = await plateBox(page);
        const vp = await page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot.querySelector(".viewport").getBoundingClientRect();
          return { x: r.x, w: r.width };
        });
        const left = img.x + 3;
        const right = img.x + img.w - 3;
        assert.ok((left - vp.x) / vp.w <= 0.3 && (right - vp.x) / vp.w >= 0.7, "both ends of the picture lie where a tap turns the page");
        for (const x of [left, right]) {
          await page.mouse.click(x, img.y + img.h / 2);
          await waitViewer(page, true);
          assert.deepEqual(await rstate(page), before, "the page did not turn");
          const v = await viewer(page);
          await page.mouse.click(v.box.x + v.box.w / 2, v.box.y + v.box.h - 4);
          await waitViewer(page, false);
        }
        // A finger's tap at the edge, too.
        await page.evaluate(({ x, y }) => {
          const target = document.querySelector("book-reader").shadowRoot.querySelector(".strip img");
          for (const type of ["pointerdown", "pointerup"])
            target.dispatchEvent(new PointerEvent(type, { pointerId: 2, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, composed: true }));
        }, { x: right, y: img.y + img.h / 2 });
        await waitViewer(page, true);
        assert.deepEqual(await rstate(page), before, "a finger's tap did not turn the page");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: rendering and layout.
    test("the picture turns clockwise a quarter at a time, on past a full turn, fitted to the long side, and the page under it is unchanged", async () => {
      const { page, problems } = await openPlate();
      try {
        // The turn's own motion is not what is measured here; without it each turn lands
        // at once.
        await page.emulateMedia({ reducedMotion: "reduce" });
        const before = await rstate(page);
        const text = await firstText(page);
        const img = await plateBox(page);
        await page.mouse.click(img.x + img.w / 2, img.y + img.h / 2);
        await waitViewer(page, true);
        const flat = await viewer(page);
        const inside0 = (v) => v.img.x >= v.box.x - 1 && v.img.y >= v.box.y - 1 && v.img.x + v.img.w <= v.box.x + v.box.w + 1 && v.img.y + v.img.h <= v.box.y + v.box.h + 1;
        const angles = [];
        for (let i = 1; i <= 4; i++) {
          await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".figure .rotate").click());
          await page.waitForFunction((n) => document.querySelector("book-reader").shadowRoot.querySelector(".figure").style.getPropertyValue("--turn") === String(n), i, WAIT);
          await waitStill(page);
          const v = await viewer(page);
          angles.push(v.rotate);
          // Turned or not, the picture's box lies within the viewer: its long side
          // follows the viewer's height while it stands upright, and nothing is cut.
          const inside = (a, b) => a.x >= b.x - 2 && a.y >= b.y - 2 && a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2;
          assert.ok(inside(v.img, v.box), `turn ${i}: the picture fits the viewer (${JSON.stringify(v)})`);
        }
        assert.ok(inside0(flat), "lying flat, the picture fits the viewer");
        assert.deepEqual(angles, ["90deg", "180deg", "270deg", "360deg"], "every turn goes on clockwise");
        await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".figure .close").click());
        await waitViewer(page, false);
        assert.deepEqual(await rstate(page), before, "the reader is on the same page");
        assert.equal(await firstText(page), text, "the text under the picture is unchanged");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: focus and keys.
    test("while a picture is open the page keys do nothing, and Escape closes it and gives the reader the keyboard", async () => {
      const { page, problems } = await openPlate();
      try {
        const before = await rstate(page);
        const img = await plateBox(page);
        await page.mouse.click(img.x + img.w / 2, img.y + img.h / 2);
        await waitViewer(page, true);
        await page.waitForFunction(() => document.querySelector("book-reader").shadowRoot.activeElement?.classList.contains("rotate"), undefined, WAIT);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("PageDown");
        await page.keyboard.press("End");
        assert.deepEqual(await rstate(page), before, "the page did not turn");
        await page.keyboard.press("Escape");
        await waitViewer(page, false);
        await page.waitForFunction(() => document.querySelector("book-reader").shadowRoot.activeElement?.classList.contains("reader"), undefined, WAIT);
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "The Plate", 2);
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

    // Browser: a gesture.
    test("a double click zooms the picture, a drag moves it, and another double click fits it again", async () => {
      const { page, problems } = await openPlate();
      try {
        const img = await plateBox(page);
        await page.mouse.click(img.x + img.w / 2, img.y + img.h / 2);
        await waitViewer(page, true);
        const v = await viewer(page);
        const cx = v.img.x + v.img.w / 2;
        const cy = v.img.y + v.img.h / 2;
        await page.mouse.dblclick(cx, cy);
        assert.equal((await viewer(page)).zoom, "2", "zoomed to twice");
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) await page.mouse.move(cx + i * 20, cy);
        await page.mouse.up();
        assert.notEqual((await viewer(page)).x, "0px", "the drag moved the picture");
        await page.mouse.dblclick(cx, cy);
        const back = await viewer(page);
        assert.deepEqual([back.zoom, back.x], ["1", "0px"], "fitted again");
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });
  });
}

// The block at the top of the shown page, by its text: the one thing kept across a
// resize even as the page number moves (Decision 4, section 12). Defined in the browser
// so a resize can be awaited in-page without a round trip per poll.
function topBlockText() {
  const r = document.querySelector("book-reader").shadowRoot;
  const vp = r.querySelector(".viewport").getBoundingClientRect();
  const block = [...r.querySelector(".strip").children].find((b) => {
    const x = b.getBoundingClientRect();
    return x.right > vp.left + 1 && x.left < vp.right - 1;
  });
  return block?.textContent.trim().slice(0, 40) ?? "";
}
const topText = (page) => page.evaluate(topBlockText);

// The reader's own viewport width, the honest signal that a dock fold has re-flowed
// the stage; awaited in-page so a settle is a width, not a fixed pause.
const READER_W = () => document.querySelector("book-reader").shadowRoot.querySelector(".viewport").getBoundingClientRect().width;
const readerWidth = (page) => page.evaluate(READER_W);
const waitReaderWider = (page, w) => page.waitForFunction((w) => document.querySelector("book-reader").shadowRoot.querySelector(".viewport").getBoundingClientRect().width > w + 1, w, WAIT);
const waitReaderWidth = (page, w) => page.waitForFunction((w) => Math.abs(document.querySelector("book-reader").shadowRoot.querySelector(".viewport").getBoundingClientRect().width - w) < 1, w, WAIT);

// The left dock (shelf and contents) on the desk, folded by its bar's Fold button and
// unfolded by the rail's Unfold; ensureLeftOpen makes the starting state definite.
const leftFolded = (page) => page.evaluate(() => document.querySelector("dock-desk").shadowRoot.querySelector(".dock.left")?.classList.contains("folded"));
const clickAria = (page, aria) => page.evaluate((a) => document.querySelector("dock-desk").shadowRoot.querySelector(`.dock.left .fold[aria-label="${a}"]`)?.click(), aria);
const foldLeft = (page) => clickAria(page, "Fold");
const unfoldLeft = (page) => clickAria(page, "Unfold");
async function ensureLeftOpen(page) {
  if (await leftFolded(page)) {
    await unfoldLeft(page);
    await page.waitForFunction(() => !document.querySelector("dock-desk").shadowRoot.querySelector(".dock.left")?.classList.contains("folded"), undefined, WAIT);
    await settle(page);
  }
}

// The page shown sits inside the fixture's over-long paragraph: its first visible block
// opens "A paragraph that outruns" and runs in from an earlier page (its left edge lies
// before the viewport), so no block starts here and only an offset can name the place.
function insideLongParagraph() {
  const r = document.querySelector("book-reader").shadowRoot;
  const vp = r.querySelector(".viewport").getBoundingClientRect();
  const b = [...r.querySelector(".strip").children].find((el) => {
    const x = el.getBoundingClientRect();
    return x.right > vp.left + 1 && x.left < vp.right - 1;
  });
  return Boolean(b && b.textContent.trim().startsWith("A paragraph that outruns") && b.getBoundingClientRect().left < vp.left - 1);
}

// The trace is a console stream, not page state; poll the captured lines in Node.
async function waitForTrace(debug, pattern, timeout = 3000, from = 0) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (debug.slice(from).some((l) => pattern.test(l))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("trace line not seen");
}
