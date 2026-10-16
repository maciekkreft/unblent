import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
const PAGE = `${BASE_URL}/workshop/design/subject`;

// The "Vim keys" preference (12), seeded the way the settings fact stores it (one
// localStorage key, the workshop profile since the page is under /workshop/).
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });
const VIM = seed(true);
const PLAIN = seed(false);

function watch(page, problems) {
  page.on("console", (msg) => msg.type() === "error" && problems.push(`console error: ${msg.text()}`));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) => {
    const err = req.failure()?.errorText ?? "";
    if (/cancelled|ERR_ABORTED/i.test(err)) return; // a reload aborting a pull is navigation, not a fault
    problems.push(`request failed: ${req.url()} ${err}`);
  });
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

const ready = (page) =>
  page.waitForFunction(
    () =>
      document.querySelector("dock-desk")?.shadowRoot?.querySelector(".stage") &&
      document.querySelector("book-reader")?.shadowRoot &&
      document.querySelector("note-list")?.shadowRoot,
  );

// A signed-in user: the same HMAC-over-user-id cookie server/user.py sets, forged only
// against a throwaway data directory (never :8080), the guard the books test uses too.
const forgeCookie = () => {
  const SECRET = process.env.SESSION_SECRET;
  assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(
    process.env.UNBLENT_DATA,
    "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server",
  );
  const userId = `hn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
};

// A user set up straight through the server (5), in milliseconds: the sample book,
// open, and with `highlight` one highlight on its opening line (the note the reader
// saves for a drag over "short opening"), its comment empty. Ids are fixed ULIDs; each
// test is its own user.
const BOOK_ID = "01K00000000000000000000SMP";
const HIGHLIGHT_ID = "01K0000000000000000000HGHT";
const seedUser = async ({ highlight, earlier = 0 }) => {
  const cookie = forgeCookie();
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK_ID}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK_ID}/opened`, "application/json", "{}");
  if (highlight) {
    const about = [{
      kind: "book",
      id: BOOK_ID,
      place: { chapter: 0, contentVersion: 1, start: { block: 2, offset: 2 }, end: { block: 2, offset: 15 } },
      quote: { exact: "short opening", prefix: "A ", suffix: " chapter, one page long. It link" },
    }];
    await put(`/api/notes/${HIGHLIGHT_ID}`, "application/json", JSON.stringify({ title: "", body: "", baseVersion: null, about }));
  }
  // `earlier` highlights, one letter each of the chapter's heading, each with a three-line
  // comment, so the document is taller than its panel and a highlight made later in the
  // text lands below the fold.
  const heading = "Chapter One";
  for (let i = 0; i < earlier; i += 1) {
    const about = [{
      kind: "book",
      id: BOOK_ID,
      place: { chapter: 0, contentVersion: 1, start: { block: 0, offset: i }, end: { block: 0, offset: i + 1 } },
      quote: { exact: heading[i], prefix: heading.slice(0, i), suffix: heading.slice(i + 1) },
    }];
    const id = `01K00000000000000000000E${String(i).padStart(2, "0")}`;
    await put(`/api/notes/${id}`, "application/json", JSON.stringify({ title: "", body: `Earlier ${i}\nsecond\nthird`, baseVersion: null, about }));
  }
  return cookie;
};

const serverNotes = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error(`list ${res.status}`);
    return (await res.json()).notes;
  });

// The painted highlights in the reader, so the before hook can wait for the drag to land.
const marks = (page) =>
  page.evaluate(() =>
    [...document.querySelector("book-reader").shadowRoot.querySelectorAll(".strip mark")].map((m) => m.textContent),
  );

const readerHasText = (page) =>
  until(
    async () =>
      page.evaluate(() => {
        const s = document.querySelector("book-reader").shadowRoot.querySelector(".strip");
        return Boolean(s && s.children.length && s.textContent.trim().length > 20);
      }),
    8000,
  );

const dragRect = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector("book-reader").shadowRoot.querySelector(".strip");
    const block = [...strip.children].find((el) => el.textContent.trim().split(/\s+/).length >= 4);
    const tn = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(tn, 2);
    range.setEnd(tn, Math.min(tn.data.length, 12));
    const r = range.getBoundingClientRect();
    return { x1: r.left + 1, x2: r.right - 1, y: r.top + r.height / 2 };
  });

const dragOver = async (page, r) => {
  await page.mouse.move(r.x1, r.y);
  await page.mouse.down();
  await page.mouse.move((r.x1 + r.x2) / 2, r.y, { steps: 5 });
  await page.mouse.move(r.x2, r.y, { steps: 5 });
  await page.mouse.up();
};

// Nudge `notes` to drain the outbox now instead of after its idle window (fact.js drains on
// visibilitychange), so a test need not wait out the debounce for a write to reach the server.
const drain = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
// Until the server holds what `holds` looks for, nudging the drain on every look: the
// editor's save lands a moment after its text shows, and a nudge before it finds an empty
// outbox and leaves the save to the idle window.
const synced = (page, holds, timeout = 4000) =>
  until(async () => {
    await drain(page);
    return holds(await serverNotes(page));
  }, timeout);

// The elements the Notes container (list-then-item#notes) has assigned to its slot: the
// list, or the item shown after a pick (4.1).
const assignedNotes = (page) =>
  page.evaluate(() =>
    document.querySelector("list-then-item#notes").shadowRoot.querySelector("slot").assignedElements().map((el) => el.localName),
  );

// Show the Highlights document: pick the Highlights row in the Notes list, then wait for
// the container to show the document in place of the editor. The row lives in Notes.
const showHighlights = async (page) => {
  await until(async () =>
    page.evaluate(() => Boolean(document.querySelector("note-list").shadowRoot.querySelector(".row.highlights"))),
  );
  await page.evaluate(() => document.querySelector("note-list").shadowRoot.querySelector(".row.highlights").click());
  await until(async () => (await assignedNotes(page)).includes("highlight-notes"));
};

// The highlights document read through the EditorView the .cm-content node carries.
const hnDoc = (page) =>
  page.evaluate(
    () => document.querySelector("highlight-notes").shadowRoot.querySelector(".cm-content")?.cmView?.view?.state?.doc?.toString() ?? "",
  );
const hnQuotes = (page) =>
  page.evaluate(() =>
    [...document.querySelector("highlight-notes").shadowRoot.querySelectorAll(".cm-quote-text")].map((m) => m.textContent),
  );
const hnHas = (page, selector) =>
  page.evaluate((s) => document.querySelector("highlight-notes").shadowRoot.querySelector(s) != null, selector);

// Put the caret at the end (an empty comment line) or start (the quote line) of the
// document, then focus, so a key acts where the test aims it.
const hnCaret = (page, where) =>
  page.evaluate((where) => {
    const view = document.querySelector("highlight-notes").shadowRoot.querySelector(".cm-content").cmView.view;
    view.focus();
    view.dispatch({ selection: { anchor: where === "end" ? view.state.doc.length : 0 } });
  }, where);

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium. One browser per engine (the launch is the costly part
// on a small host); each test is its own user, set up through the server, in a context
// of its own (11.2), and its page reopens the book the server says is open.
for (const engine of ENGINES) {
  describe(`highlight-notes in ${engine.name}`, { timeout: 120000 }, () => {
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

    const open = async ({ highlight = true, earlier, settings }) => {
      const problems = [];
      const cookie = await seedUser({ highlight, earlier });
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: cookie, url: BASE_URL }]);
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), settings);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);
      return { page, problems };
    };

    // A highlight made in the book appears in the document, and Vim normal-mode editing
    // of the comment saves through notes to the server. The highlight is created here, in one page, so its create and comment never
    // hand a note version across page loads (which would race a stale write into a conflict).
    test(`a highlight appears and a Vim comment saves in ${engine.name}`, async () => {
      const { page, problems } = await open({ highlight: false, settings: VIM });
      await readerHasText(page);

      // Make a highlight in the book, then pick the Highlights row.
      await dragOver(page, await dragRect(page));
      await until(async () => (await marks(page)).length > 0);
      await page.waitForFunction(() => document.querySelector("highlight-notes")?.shadowRoot?.querySelector(".cm-content"));
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);

      // The highlight note must reach the server before its comment is written, so the
      // comment's save is based on a real version, not the null of a note still being created.
      await synced(page, (notes) => notes.some((n) => (n.about ?? []).some((l) => l.place)));

      // Focus the editor; Vim boots in normal mode and draws its block cursor (polled, since
      // Vim arrives with the settings reply and the cursor layer renders a beat after).
      await hnCaret(page, "end");
      await until(async () => hnHas(page, ".cm-fat-cursor"));

      // Normal mode: `i` to insert, type the comment, `Escape` back to normal.
      await page.keyboard.press("i");
      await page.keyboard.type("A Vim thought");
      await page.keyboard.press("Escape");
      await until(async () => (await hnDoc(page)).includes("A Vim thought"));

      await synced(page, (notes) => notes.some((n) => (n.body ?? "").includes("A Vim thought")));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // With Vim keys on, Enter in insert mode is the editor's: it starts a paragraph, and the
    // blank line before it is drawn as a gap.
    test(`with Vim keys Enter in a comment starts a paragraph in ${engine.name}`, async () => {
      const { page, problems } = await open({ settings: VIM });
      await page.waitForFunction(() => document.querySelector("highlight-notes")?.shadowRoot?.querySelector(".cm-content"));
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);

      await hnCaret(page, "end");
      await until(async () => hnHas(page, ".cm-fat-cursor"));
      await page.keyboard.press("A");
      await page.keyboard.type("One");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Two");
      await page.keyboard.press("Escape");
      await until(async () => (await hnDoc(page)).endsWith("\nOne\n\nTwo"));
      assert.ok(await hnHas(page, ".cm-line.cm-gap"), "the blank line is drawn as a gap");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // Enter starts a paragraph, drawn after a short gap; Shift+Enter breaks the line with
    // none. The empty comment line under a quote, where a comment is typed, is never a gap.
    test(`Enter makes a paragraph and Shift+Enter a line break in ${engine.name}`, async () => {
      const { page, problems } = await open({ settings: PLAIN });
      await page.waitForFunction(() => document.querySelector("highlight-notes")?.shadowRoot?.querySelector(".cm-content"));
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);
      const gaps = () =>
        page.evaluate(() => document.querySelector("highlight-notes").shadowRoot.querySelectorAll(".cm-line.cm-gap").length);
      assert.equal(await gaps(), 0, "the empty comment line under the quote is a full line");

      await hnCaret(page, "end");
      await page.keyboard.type("One");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Two");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("Three");
      await until(async () => (await hnDoc(page)).endsWith("\nOne\n\nTwo\nThree"));
      assert.equal(await gaps(), 1, "one gap, from Enter; none from Shift+Enter");
      await synced(page, (notes) => notes.some((n) => n.body === "One\n\nTwo\nThree"));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // The quote line is protected: `x` on it is refused and flashes; `dd` on the only
    // comment line empties it to one blank line and keeps the highlight.
    test(`the quote line refuses an edit and dd empties a one-line comment in ${engine.name}`, async () => {
      const { page, problems } = await open({ settings: VIM });
      await page.waitForFunction(() => document.querySelector("highlight-notes")?.shadowRoot?.querySelector(".cm-content"));
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);
      const quote = (await hnQuotes(page))[0];

      // Give the highlight a one-line comment to work on.
      await hnCaret(page, "end");
      await until(async () => hnHas(page, ".cm-fat-cursor"));
      await page.keyboard.press("i");
      await page.keyboard.type("Line to delete");
      await page.keyboard.press("Escape");
      await until(async () => (await hnDoc(page)).includes("Line to delete"));

      // `x` on the quote line: the document does not change, and the line flashes.
      const before = await hnDoc(page);
      await hnCaret(page, "start");
      await page.keyboard.press("x");
      await until(async () => hnHas(page, ".cm-refused"), 2000);
      assert.equal(await hnDoc(page), before, "the quote line refused the edit");

      // `dd` on the only comment line: the highlight stays with one blank comment line.
      await hnCaret(page, "end");
      await page.keyboard.press("d");
      await page.keyboard.press("d");
      await until(async () => (await hnDoc(page)) === `${quote}\n`);
      assert.equal((await hnQuotes(page)).length, 1, "the highlight is still there after its comment was emptied");

      // The emptied comment reaches the server.
      await synced(page, (notes) => {
        const n = notes.find((x) => (x.about ?? []).some((l) => l.place));
        return n && (n.body ?? "") === "";
      });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // `dd` on a quote line removes the highlight through the same undo window as the bin,
    // and `u` brings it back.
    test(`dd on a quote line discards with undo in ${engine.name}`, async () => {
      const { page, problems } = await open({ settings: VIM });
      await page.waitForFunction(() => document.querySelector("highlight-notes")?.shadowRoot?.querySelector(".cm-content"));
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);

      // `dd` on the quote line starts the window (Undo shown, the lines dimmed).
      await hnCaret(page, "start");
      await page.keyboard.press("d");
      await page.keyboard.press("d");
      await until(async () => (await hnHas(page, ".cm-undo")) && (await hnHas(page, ".cm-discarding")));
      // `u` takes the removal back before the window ends.
      await page.keyboard.press("u");
      await until(async () => (await hnHas(page, ".cm-bin")) && !(await hnHas(page, ".cm-undo")));
      assert.ok((await hnQuotes(page)).length > 0, "the highlight came back");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // With Vim keys off the same document takes plain keys: no block cursor, and selecting
    // a whole quote line and pressing Delete removes that highlight through the undo window,
    // the same rule as `dd` (one rule in both modes); Undo brings it back. A comment saves.
    test(`without Vim keys a deleted quote line is undoable and a comment saves in ${engine.name}`, async () => {
      const { page, problems } = await open({ settings: PLAIN });
      await page.waitForFunction(() => document.querySelector("highlight-notes")?.shadowRoot?.querySelector(".cm-content"));
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);

      // The first quote line and its line break, selected, then Delete.
      await page.evaluate(() => {
        const view = document.querySelector("highlight-notes").shadowRoot.querySelector(".cm-content").cmView.view;
        view.focus();
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.line(2).from } });
      });
      assert.equal(await hnHas(page, ".cm-fat-cursor"), false, "no block cursor without Vim keys");
      await page.keyboard.press("Delete");
      await until(async () => (await hnHas(page, ".cm-undo")) && (await hnHas(page, ".cm-discarding")));
      await page.evaluate(() => document.querySelector("highlight-notes").shadowRoot.querySelector(".cm-undo").click());
      await until(async () => (await hnHas(page, ".cm-bin")) && !(await hnHas(page, ".cm-undo")));
      assert.ok((await hnQuotes(page)).length > 0, "the highlight came back");

      // Plain typing goes straight into the comment, no `i` first.
      await hnCaret(page, "end");
      await page.keyboard.type("A plain thought");
      await until(async () => (await hnDoc(page)).includes("A plain thought"));
      await synced(page, (notes) => notes.some((n) => (n.body ?? "").includes("A plain thought")));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // A highlight made below the fold of a long Highlights document is scrolled into view
    // with the comment line under it, where the user writes next.
    test(`a new highlight below the fold is scrolled into view in ${engine.name}`, async () => {
      const { page, problems } = await open({ highlight: false, earlier: 10, settings: PLAIN });
      await readerHasText(page);
      await showHighlights(page);
      await until(async () => (await hnDoc(page)).includes("Earlier 9"));

      await dragOver(page, await dragRect(page));
      const shown = () =>
        page.evaluate(() => {
          const root = document.querySelector("highlight-notes").shadowRoot;
          const box = root.querySelector(".cm-scroller").getBoundingClientRect();
          const quote = [...root.querySelectorAll(".cm-quote")].find((l) => l.textContent.trim().length > 1);
          const comment = quote?.nextElementSibling?.getBoundingClientRect();
          return Boolean(comment && quote.getBoundingClientRect().top >= box.top && comment.bottom <= box.bottom);
        });
      await until(shown);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });
}
