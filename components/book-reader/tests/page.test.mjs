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

function watch(page, problems, ignore = false) {
  // A reload aborts whatever book fetch was in flight; that abort is not a fault, so a
  // test that reloads tolerates it, the way the shelf test tolerates a deliberate 422.
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
// A brief pause after a chapter loads, so its deferred re-measure has finished before
// the next turn — the reader cancels that measure on a turn, and this keeps the test
// clear of the narrow window where the two would race.
const settle = () => new Promise((r) => setTimeout(r, 350));
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
      await context.addCookies([{ name: "unblent_session", value: cookie, url: BASE_URL }]);
      const page = await context.newPage();
      await page.setViewportSize(opts.viewport ?? { width: 1024, height: 768 });
      watch(page, problems, opts.ignoreAborts);
      page.on("console", (msg) => msg.type() === "debug" && debug.push(msg.text()));
      if (opts.phone) await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
      if (opts.vimKeys != null) await page.addInitScript((v) => localStorage.setItem("settings", v), seed(opts.vimKeys));
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot && document.querySelector("book-shelf")?.shadowRoot);
      if (opts.phone) await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      await waitTile(page);
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

    test("with Vim keys on, Ctrl+f/Ctrl+b and Ctrl+d/Ctrl+u turn the page and G/gg reach the chapter's ends", async () => {
      const { page, problems } = await openAndRewind({ vimKeys: true });
      try {
        await page.keyboard.press("Control+f");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle();
        await page.keyboard.press("Control+d");
        await waitChapterPage(page, "Chapter Two", 2);
        await page.keyboard.press("Control+u");
        await waitChapterPage(page, "Chapter Two", 1);
        await page.keyboard.press("Control+f");
        await waitChapterPage(page, "Chapter Two", 2);
        await waitStill(page);
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

    test("with Vim keys off, Ctrl+f and l do not turn the page", async () => {
      const { page, problems } = await openAndRewind({ vimKeys: false });
      try {
        await page.keyboard.press("Control+f");
        await page.keyboard.press("l");
        await page.keyboard.press("G");
        await page.waitForTimeout(300);
        assert.deepEqual(await rstate(page), { chap: "Chapter One", page: 1, pages: 1 });
        assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
      } finally {
        await page.close();
      }
    });

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
        await settle();
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

    test("keeps the reading place across a reload", async () => {
      const { page, problems, debug } = await openAndRewind({ ignoreAborts: true });
      try {
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle();
        // Turn a few pages in, onto a page a normal paragraph begins (past the long
        // opening one, whose start page a saved block would reopen at): what is
        // persisted is the top block (section 12), so the block must start here for
        // the reopen to land past the first page.
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press("ArrowRight");
          await settle();
        }
        await waitChapterPage(page, "Chapter Two", 5);

        // The place is written to the browser cache the moment it is announced
        // (book.progressed, throttled) and books stores it; a reload reads it from
        // there, before any server pull. The 2 s network debounce is only for the
        // other device (5), so waiting for the announcement is enough.
        await waitForTrace(debug, PROGRESSED);
        await new Promise((r) => setTimeout(r, 200));

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

    test("keeps the same block when the viewport resizes", async () => {
      const { page, problems } = await openAndRewind();
      try {
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle();
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);
        // The footer turns at once; the strip is still sliding for a moment, and a block
        // measured mid-slide could be one on its way out.
        await settle();
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
    test("keeps the page across a dock fold", async () => {
      const { page, problems } = await openAndRewind({ viewport: { width: 760, height: 768 } });
      try {
        await ensureLeftOpen(page);
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle();
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);
        await settle();
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
        await settle();
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
    test("keeps the place inside a paragraph longer than a page", async () => {
      const { page, problems } = await openAndRewind({ viewport: { width: 760, height: 768 } });
      try {
        await ensureLeftOpen(page);
        // Into Chapter Two (past the one-page first chapter), then one turn more, into
        // the long paragraph: the page then shows it with no block starting on it.
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle();
        await page.keyboard.press("ArrowRight");
        await waitChapterPage(page, "Chapter Two", 2);
        await settle();

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
        await settle();
        assert.equal((await rstate(page)).chap, "Chapter Two", "still the same chapter while folded");

        await unfoldLeft(page);
        await waitReaderWidth(page, before.w);
        await settle();
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
    test("a late page sits on its column at a fractional page width", async () => {
      const { page, problems } = await openAndRewind();
      try {
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await page.evaluate(() => { document.querySelector("book-reader").shadowRoot.querySelector(".page").style.width = "200.5px"; });
        await waitPagesAtLeast(page, "Chapter Two", 8);
        await settle();
        await page.keyboard.press("End");
        await settle();
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

    test("a jump from the contents lands on the chapter's first page without sliding", async () => {
      const { page, problems } = await openAndRewind();
      try {
        // Leave the second chapter on its second page, so the strip is slid.
        await page.keyboard.press("ArrowRight");
        await waitPagesAtLeast(page, "Chapter Two", 3);
        await settle();
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
        await new Promise((r) => setTimeout(r, 400));
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
        await new Promise((r) => setTimeout(r, 350));
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
  });
}

// The product page's own behaviour (§12): the hidden door and what each profile shows.
// profile-switch (step 5) carries only a machine test, so its browser behaviour lives
// here, on the page where it is placed. WebKit first, then Chromium.
const navCount = (page) => page.evaluate(() => document.querySelector("page-nav").shadowRoot.querySelectorAll("a").length);
const navHeight = (page) => page.evaluate(() => document.querySelector("page-nav").getBoundingClientRect().height);
// The control tags the page slotted into the stage strip (6.4): their tag names in
// page order, each in its own named slot (a `button` child draws a pill instead, with
// no slot, so this lists the controls the header carries).
const stageControls = (page) =>
  page.evaluate(() => {
    const wrap = document.querySelector("dock-desk").shadowRoot.querySelector(".stage .strip .controls");
    return wrap ? [...wrap.querySelectorAll("slot")].flatMap((s) => s.assignedElements()).map((e) => e.localName) : null;
  });
const switchHidden = (page, tag) => page.evaluate((t) => getComputedStyle(document.querySelector(t)).display === "none", tag);
const arrangeControls = (page) => page.evaluate(() => document.querySelector("dock-desk").shadowRoot.querySelectorAll(".action:not(.fold)").length);
const sheetPicture = (page) =>
  page.evaluate(() => {
    const r = document.querySelector("settings-sheet").shadowRoot;
    const labels = [...r.querySelectorAll(".switches label")].map((l) => l.textContent);
    return {
      pages: Boolean(r.querySelector("h2")),
      viewport: labels.some((t) => /Viewport switch/.test(t)),
      layout: labels.some((t) => /Layout switch/.test(t)),
    };
  });
const doorPressed = (page) => page.evaluate(() => document.querySelector("profile-switch").shadowRoot.querySelector("button").getAttribute("aria-pressed"));
const doorOpacity = (page) => page.evaluate(() => getComputedStyle(document.querySelector("profile-switch").shadowRoot.querySelector("button")).opacity);

for (const engine of ENGINES) {
  test(`the product hides the workshop behind the toolbox in ${engine.name}`, async () => {
    const problems = [];
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1024, height: 768 });
      watch(page, problems);
      // Arm the cold sync waiters before the load so the reload below never aborts one.
      const synced = Promise.all([
        page.waitForResponse((r) => /\/api\/books\?since=/.test(r.url()), { timeout: WAIT.timeout }),
        page.waitForResponse((r) => /\/api\/notes\?since=/.test(r.url()), { timeout: WAIT.timeout }),
      ]);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.querySelector("profile-switch")?.shadowRoot?.querySelector("button") &&
          document.querySelector("settings-sheet")?.shadowRoot?.querySelector(".switches"),
        undefined,
        WAIT,
      );

      // Product: no links, both bar switches hidden, no arrange controls, and the sheet
      // is the production picture — the layout row alone, no Pages section, no viewport row.
      assert.equal(await navCount(page), 0, "no page links in the product");
      // The bar takes no space in the product (§8/§12): its controls live in the
      // stage header (6.4), in page order, so the desk starts at the top of the page.
      assert.equal(await navHeight(page), 0, "the empty nav bar takes no height in the product");
      assert.deepEqual(
        await stageControls(page),
        ["profile-switch", "layout-switch", "session-switch"],
        "the page controls sit in the stage header",
      );
      assert.ok(await switchHidden(page, "viewport-switch"), "the viewport switch is hidden");
      assert.ok(await switchHidden(page, "layout-switch"), "the layout switch is hidden");
      assert.equal(await arrangeControls(page), 0, "no arrange controls on the desk");
      assert.deepEqual(await sheetPicture(page), { pages: false, viewport: false, layout: true }, "the product sheet shows only the layout row");
      assert.equal(await doorPressed(page), "false", "the door reads as not engaged");

      // The door is transparent until hover reveals it (§12).
      assert.equal(await doorOpacity(page), "0", "the toolbox is invisible until hover");
      await page.locator("profile-switch button").hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector("profile-switch").shadowRoot.querySelector("button")).opacity === "1", undefined, WAIT);

      await synced;

      // Through the door into the workshop: the grouped nav and the bar switches return,
      // the sheet fills, and the door reads as engaged.
      await page.locator("profile-switch button").click();
      await page.waitForFunction(() => document.querySelector("page-nav").shadowRoot.querySelectorAll("a").length > 0, undefined, WAIT);
      assert.ok((await navHeight(page)) > 0, "the bar returns with height once it has links (the workshop)");
      assert.ok(!(await switchHidden(page, "viewport-switch")), "the viewport switch returns in the workshop");
      assert.ok(!(await switchHidden(page, "layout-switch")), "the layout switch returns in the workshop");
      assert.ok((await sheetPicture(page)).pages, "the sheet shows the Pages section in the workshop");
      assert.equal(await doorPressed(page), "true", "the door reads as engaged");
      const labels = await page.evaluate(() =>
        [...document.querySelector("page-nav").shadowRoot.querySelectorAll(".label")].map((l) => l.textContent.trim()),
      );
      assert.deepEqual(labels, ["Design", "Stems", "Apps"], "the nav groups the workshop pages");

      // The chosen profile survives a reload (§12, local-only).
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("page-nav")?.shadowRoot?.querySelectorAll("a").length > 0, undefined, WAIT);
      assert.equal(await doorPressed(page), "true", "the workshop profile survives a reload");

      // Back through the same door returns to the product: the links go again.
      await page.locator("profile-switch button").click();
      await page.waitForFunction(() => document.querySelector("page-nav").shadowRoot.querySelectorAll("a").length === 0, undefined, WAIT);
      assert.equal(await navCount(page), 0, "the product hides the links again");

      assert.deepEqual(problems, [], `reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
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
  }
  await settle();
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
async function waitForTrace(debug, pattern, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (debug.some((l) => pattern.test(l))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("trace line not seen");
}
