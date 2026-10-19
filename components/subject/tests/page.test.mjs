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
const PAGE = `${BASE_URL}/workshop/design/subject`;

// Two valid ULIDs to seed notes with (the notes: list reply requires the ULID shape).
const NOTE_ONE = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const NOTE_TWO = "01ARZ3NDEKTSV4RRFFQ69G5FB2";

// The console lines trace prints (section 10) show subject is wired, not just
// rendered: on start it asks dock and books for the starting picture (D3, 4.3).

function watch(page, problems) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    // WebKit sometimes also reports that same reload abort as a page error naming
    // "access control checks"; a real access failure still fails its request, below.
    if (/due to access control checks/.test(err.message)) return;
    problems.push(`page error: ${err.message}`);
  });
  page.on("requestfailed", (req) => {
    // A reload aborts whatever pull was in flight (WebKit: "Load request cancelled",
    // Chromium: "net::ERR_ABORTED"); that abort is navigation, not a fault, the way the
    // book-reader test tolerates a reload aborting a book fetch. A real failure keeps its
    // own text, and a 4xx/5xx is still caught by the response handler below.
    const err = req.failure()?.errorText ?? "";
    if (/cancelled|ERR_ABORTED/i.test(err)) return;
    problems.push(`request failed: ${req.url()} ${err}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
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
      document.querySelector("note-list")?.shadowRoot &&
      document.querySelector("note-editor")?.shadowRoot,
  );

// A signed-in user: the same HMAC-over-user-id cookie server/user.py sets, forged only
// against a throwaway data directory (never :8080), the same guard the books test uses.
const forgeCookie = () => {
  const SECRET = process.env.SESSION_SECRET;
  assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
  assert.ok(
    process.env.UNBLENT_DATA,
    "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server",
  );
  const userId = `subject-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;
};

// The shelf's real tile ids, imports in flight excluded.
const tileIds = (page) =>
  page.evaluate(() =>
    [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile:not(.adding)")].map((t) => t.dataset.id),
  );

const openTile = (page, id) =>
  page.evaluate((id) => document.querySelector("book-shelf").shadowRoot.querySelector(`.tile[data-id="${id}"]`)?.click(), id);

// A user set up straight through the server (5), in milliseconds: the sample book
// imported under each of `books` (two ids make two books sharing a title), `open` the
// book the next load reopens, and `notes` with their links. Each test is its own user,
// so it reads only what it set up. Ids are fixed ULIDs.
const BOOK_ONE = "01K00000000000000000000BK1";
const BOOK_TWO = "01K00000000000000000000BK2";
const HIGHLIGHT = "01K0000000000000000000HGHT";
const seedUser = async ({ books = [], open = null, notes = [] } = {}) => {
  const cookie = forgeCookie();
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  for (const id of books) await put(`/api/books/${id}`, "application/epub+zip", readFileSync(SAMPLE));
  if (open) await put(`/api/books/${open}/opened`, "application/json", "{}");
  for (const { id, title = "", body = title, about } of notes) {
    await put(`/api/notes/${id}`, "application/json", JSON.stringify({ title, body, baseVersion: null, about }));
  }
  return cookie;
};
// The note the reader saves for a drag over "short opening" on the sample's first page.
const highlightOn = (book) => [{
  kind: "book",
  id: book,
  place: { chapter: 0, contentVersion: 1, start: { block: 2, offset: 2 }, end: { block: 2, offset: 15 } },
  quote: { exact: "short opening", prefix: "A ", suffix: " chapter, one page long. It link" },
}];

// The subject stem in a context of its own (11.2): the user's cookie, empty storage.
const openPage = async (browser, cookie, { phone = false, undoMs } = {}) => {
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addCookies([{ name: "unblent_session", value: cookie, url: BASE_URL }]);
  // A short undo window, so a removal test need not wait out the real one. book-reader
  // reads --duration-undo off its host at mount, so it must be in the cascade before
  // the element upgrades; an adopted stylesheet is applied at document start.
  if (undoMs != null)
    await context.addInitScript((ms) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`:root{--duration-undo:${ms}ms}`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }, undoMs);
  const page = await context.newPage();
  const problems = [];
  watch(page, problems);
  if (phone) await page.addInitScript(() => localStorage.setItem("viewport", "phone"));
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await ready(page);
  return { page, problems };
};

// The notes the server actually holds for this signed-in user, read from the page so
// the request carries the session cookie. Proves a write reached the server, links and
// all, not only the local cache.
const serverNotes = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error(`list ${res.status}`);
    return (await res.json()).notes;
  });

// The note the editor is showing (its body is its whole text; a seeded note's body is
// its title). Empty string when the editor holds no note. Read from its CodeMirror
// view, reached through CM6's own handle on its content element.
const editorBody = (page) =>
  page.evaluate(
    () => document.querySelector("note-editor").shadowRoot.querySelector(".cm-content")?.cmView.rootView.view.state.doc.toString() ?? "",
  );

// The About line's text (12), "About: <book>" or "" when the line is empty.
const aboutText = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".about")?.textContent.trim() ?? "");

// Replace the editor's text as one edit, which the editor hears as the user's typing.
const typeInto = (page, text) =>
  page.evaluate((text) => {
    const view = document.querySelector("note-editor").shadowRoot.querySelector(".cm-content").cmView.rootView.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, text);

// Click the list's "New note" draft row, the gesture that opens a fresh note.
const clickNew = (page) =>
  page.evaluate(() => document.querySelector("note-list").shadowRoot.querySelector(".row.draft")?.click());

// Whether the editor's pin reads as pressed (pinned).
const pinPressed = (page) =>
  page.evaluate(
    () => document.querySelector("note-editor").shadowRoot.querySelector('.pin[aria-pressed="true"]') != null,
  );

const clickPin = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".pin")?.click());

// The titles the list actually shows (the next-note draft, the apart row and the fixed
// Highlights row excluded).
const shownTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("note-list").shadowRoot.querySelectorAll(".row:not(.draft):not(.apart):not(.highlights)")].map((r) =>
      r.querySelector(".name").textContent.trim(),
    ),
  );

const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// The Notes container's Back bar label (null when the list is shown, so no bar).
const notesBarLabel = (page) =>
  page.evaluate(() => {
    const b = document.querySelector("list-then-item#notes").shadowRoot.querySelector(".bar button span");
    return b ? b.textContent.trim() : null;
  });

// The fixed Highlights row (Decision 5): its count subtitle and whether it reads as the
// selected row, or null when the row is not shown.
const highlightsRow = (page) =>
  page.evaluate(() => {
    const r = document.querySelector("note-list").shadowRoot.querySelector(".row.highlights");
    return r
      ? { subtitle: r.querySelector(".subtitle").textContent.trim(), selected: r.getAttribute("aria-selected") }
      : null;
  });

// Click the Notes container's Back bar (return from the shown item to the list).
const clickNotesBack = (page) =>
  page.evaluate(() => document.querySelector("list-then-item#notes").shadowRoot.querySelector(".bar button").click());

// Whether the "New note" draft row reads as the selected one, or null when it is absent.
const draftSelected = (page) =>
  page.evaluate(
    () => document.querySelector("note-list").shadowRoot.querySelector(".row.draft")?.getAttribute("aria-selected") ?? null,
  );

// The reader's "Page N of M" footer, to prove a highlight never moves the text (D4).
const pageLabel = (page) =>
  page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".pageno")?.textContent ?? "");

// The text of every painted highlight in the reader (empty when none).
const marks = (page) =>
  page.evaluate(() =>
    [...document.querySelector("book-reader").shadowRoot.querySelectorAll(".strip mark")].map((m) => m.textContent),
  );

// The highlight bubble (session 3): its text (Copy · Remove, or Removed · Undo), whether
// the first mark is dimmed for removal, and clicking a mark or a bubble button. A mark
// opens its bubble on a real mouse click (its #pointerup), so the click goes through the
// mouse at the mark's centre, not mark.click() (which fires no pointer events).
const bubbleText = (page) =>
  page.evaluate(
    () => document.querySelector("book-reader").shadowRoot.querySelector(".bubble")?.textContent.replace(/\s+/g, " ").trim() ?? null,
  );
const markRemoving = (page) =>
  page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".strip mark")?.classList.contains("removing") ?? false);
const clickFirstMark = async (page) => {
  const box = await page.evaluate(() => {
    const m = document.querySelector("book-reader").shadowRoot.querySelector(".strip mark");
    const r = m.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
};
const clickBubble = (page, sel) =>
  page.evaluate((s) => document.querySelector("book-reader").shadowRoot.querySelector(`.bubble ${s}`)?.click(), sel);

// Wait until the reader's first chapter has laid out enough text to drag over.
const readerHasText = (page) =>
  until(
    async () =>
      page.evaluate(() => {
        const s = document.querySelector("book-reader").shadowRoot.querySelector(".strip");
        return Boolean(s && s.children.length && s.textContent.trim().length > 20);
      }),
    8000,
  );

// The client rect of a short run of text in the first roomy paragraph, to drag across.
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

// A synthetic mouse drag across the text: the highlight gesture (D3).
const dragOver = async (page, r) => {
  await page.mouse.move(r.x1, r.y);
  await page.mouse.down();
  await page.mouse.move((r.x1 + r.x2) / 2, r.y, { steps: 5 });
  await page.mouse.move(r.x2, r.y, { steps: 5 });
  await page.mouse.up();
};

// The elements the Notes container (list-then-item#notes) has assigned to its slot: the
// list, or the item shown after a pick. The pair is named by its instance id (4.1).
const assignedNotes = (page) =>
  page.evaluate(() =>
    document.querySelector("list-then-item#notes").shadowRoot.querySelector("slot").assignedElements().map((el) => el.localName),
  );

// Show the Highlights document: pick the Highlights row in the Notes list, then wait for
// the container to show the document in place of the editor (Decision 2). The row lives in
// Notes, so no dock tab need be brought forward.
const showHighlights = async (page) => {
  await until(async () =>
    page.evaluate(() => Boolean(document.querySelector("note-list").shadowRoot.querySelector(".row.highlights"))),
  );
  await page.evaluate(() => document.querySelector("note-list").shadowRoot.querySelector(".row.highlights").click());
  await until(async () => (await assignedNotes(page)).includes("highlight-notes"));
};

// Bring the docked Notes container to the stage: click the desk's "Return Notes to the
// stage" action (shown while the desk is being arranged; workshop arranges by default).
// The Highlights document lives inside Notes now, so staging Notes stages the document.
const stageNotes = (page) =>
  page.evaluate(() => {
    const btn = [...document.querySelector("dock-desk").shadowRoot.querySelectorAll("button")].find((b) =>
      /Return Notes to the stage/.test(b.getAttribute("aria-label") ?? ""),
    );
    btn?.click();
  });

// The label of the view shown on the stage (its active stage tab).
const stagedTab = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector("dock-desk")
        .shadowRoot.querySelector('.stage [role="tab"][aria-selected="true"]')
        ?.textContent.trim() ?? null,
  );

// The text of each painted quote line in the Highlights document.
const hnQuotes = (page) =>
  page.evaluate(() =>
    [...document.querySelector("highlight-notes").shadowRoot.querySelectorAll(".cm-quote-text")].map((m) => m.textContent),
  );
// Nudge `notes` to sync now instead of after its idle window: it drains the outbox on a
// visibilitychange (fact.js), so a test need not wait out the 2s debounce for a write to
// reach the server. The tab stays "visible", so this is a drain and a pull, as a focus is.
const drain = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
// Until the server holds what `holds` looks for, nudging the drain on every look: a save
// lands a moment after its text shows, and a nudge before it finds an empty outbox and
// leaves the save to the 2 s idle window.
const synced = (page, holds, timeout = 4000) =>
  until(async () => {
    await drain(page);
    return holds(await serverNotes(page));
  }, timeout);

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

for (const engine of ENGINES) {
  // Two instances of one view on one page (4.1): each container is its own tab, and a
  // tab click stores a layout that names both by their address, distinct because the
  // page gave distinct ids. This is the page-level check deferred from session 3, so it
  // runs once, in WebKit.
  if (engine.name === "webkit") {
    // Browser: a page's composition.
    test("the two containers are separate tabs named by address", async () => {
      const browser = await engine.launch();
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const problems = [];
        const page = await context.newPage();
        watch(page, problems);
        await page.goto(PAGE, { waitUntil: "domcontentloaded" });
        await ready(page);

        const tabLabels = () =>
          page.evaluate(() =>
            [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('[role="tab"]')].map((t) =>
              t.textContent.trim(),
            ),
          );
        await until(async () => {
          const labels = await tabLabels();
          return labels.includes("Books") && labels.includes("Notes");
        });

        // Click the Notes tab: a gesture, so `dock` stores the layout. It carries both
        // containers by their instance address.
        await page.evaluate(() =>
          [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('[role="tab"]')]
            .find((t) => t.textContent.trim() === "Notes")
            ?.click(),
        );
        await until(async () =>
          page.evaluate(() =>
            (localStorage.getItem("dock:" + location.pathname) ?? "").includes("list-then-item#notes"),
          ),
        );
        const layout = await page.evaluate(() => localStorage.getItem("dock:" + location.pathname));
        assert.ok(layout.includes("list-then-item#books"), "the layout names the books container by address");
        assert.ok(layout.includes("list-then-item#notes"), "the layout names the notes container by address");

        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await browser.close();
      }
    });
  }

  // Signed in, following the stage. Which notes the list shows and which the editor
  // opens as the stage moves, with the pin, is decided together in note-list's bus test;
  // here is what only the page shows across a reload. One browser per engine.
  describe(`the notes follow the stage in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    afterEach(async () => {
      await Promise.all(browser.contexts().map((c) => c.close()));
    });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Two books from the one fixture (distinct ids, same title), and a note about each.
    const twoBooks = () =>
      seedUser({
        books: [BOOK_ONE, BOOK_TWO],
        notes: [
          { id: NOTE_ONE, title: "About one", about: [{ kind: "book", id: BOOK_ONE }] },
          { id: NOTE_TWO, title: "About two", about: [{ kind: "book", id: BOOK_TWO }] },
        ],
      });

    // The About line names a note's book after a reload (fault the reload race left blank),
    // and names the stage's book on a new note before anything is typed (12).
    // One page kept open throughout, so the book stays staged and the subject stays set.
    // Browser: a reload against real storage.
    test("the About line survives a reload and names a new note", async () => {
      const { page, problems } = await openPage(browser, await twoBooks());
      await until(async () => (await tileIds(page)).length >= 2, 8000);
      const [first, second] = [BOOK_ONE, BOOK_TWO];

      // Open a book (one note is about each; both books share the title "Sample Book"):
      // the editor names it above the note about it.
      await openTile(page, second);
      await until(async () => (await editorBody(page)) !== "", 8000);
      const pinnedBody = await editorBody(page);
      assert.equal(await aboutText(page), "About: Sample Book");

      // Pin, then move the stage to the other book so the pinned note's book is no longer
      // on the stage — the case where the About line used to go blank after a reload.
      await clickPin(page);
      await until(async () => await pinPressed(page));
      const listBefore = await shownTitles(page);
      // The "open book" write for `first` must reach the server before the reload, so the
      // reload's own hidden-tab drain has nothing in flight for WebKit to cancel.
      const openedDone = page.waitForResponse(
        (r) => /\/opened$/.test(r.url()) && r.request().method() === "PUT",
        { timeout: 8000 },
      );
      await openTile(page, first);
      await until(async () => !sameSet(await shownTitles(page), listBefore));
      assert.equal(await editorBody(page), pinnedBody, "the pinned editor kept its note while the stage moved");
      await drain(page);
      await openedDone.catch(() => {});

      // Reload: the pinned note comes back, still pinned, and its About line still names
      // its own book though that book is not the one now on the stage.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await editorBody(page)) === pinnedBody, 8000);
      assert.ok(await pinPressed(page), "the pinned note came back pinned");
      assert.equal(await aboutText(page), "About: Sample Book", "its book is named though it was never on this page's stage");

      // Unpin, open a fresh note: the line names the book on the stage at
      // once, and it does not change once the note is saved (its own link names the same).
      await clickPin(page);
      await until(async () => !(await pinPressed(page)));
      await clickNew(page);
      await until(async () => (await editorBody(page)) === "");
      assert.equal(await aboutText(page), "About: Sample Book", "a new note names its book at once");
      await typeInto(page, "A new note about the open book");
      await until(async () => (await editorBody(page)) === "A new note about the open book");
      assert.equal(await aboutText(page), "About: Sample Book", "the line is unchanged once the note is saved");
      await until(async () => (await shownTitles(page)).includes("A new note about the open book"), 8000);

      // The new note's book link must reach the server, not only the local cache (the
      // fault: api.put dropped about, so a signed-in user's links never left the
      // browser). Poll until the server holds the note, then assert its link is there.
      let stored;
      await synced(page, (notes) => {
        stored = notes.find((n) => n.title === "A new note about the open book");
        return Boolean(stored);
      });
      assert.deepEqual(stored.about, [{ kind: "book", id: first }], "the new note's book link reached the server");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });

  // The reader makes and paints highlights (session 2, D3/D4). Signed in so the highlight
  // note reaches the server and a reload brings it back. One browser per engine.
  describe(`the reader highlights in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    afterEach(async () => {
      await Promise.all(browser.contexts().map((c) => c.close()));
    });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a gesture.
    test("a drag makes a highlight that holds the page count, stays off the list, and survives a reload", async () => {
      const { page, problems } = await openPage(browser, await seedUser({ books: [BOOK_ONE], open: BOOK_ONE }));
      await readerHasText(page);

      // Before the drag: where we are, and what the list shows (no book note yet).
      const pagesBefore = await pageLabel(page);
      const listBefore = await shownTitles(page);

      // Drag across a run of text: a highlight is painted, snapped to whole words.
      await dragOver(page, await dragRect(page));
      await until(async () => (await marks(page)).length > 0);
      const text = (await marks(page)).join("");
      assert.ok(text.trim().length > 0, "the mark holds the highlighted text");
      assert.equal(text, text.trim(), "the highlight is snapped, with no surrounding space");

      // Highlighting never moves the text (D4), and the list never grows a row for it (D2).
      assert.equal(await pageLabel(page), pagesBefore, "the page count is unchanged");
      assert.ok(sameSet(await shownTitles(page), listBefore), "the note list shows no new row");

      // The highlight note reaches the server, so a reload is deterministic.
      await synced(page, (notes) => notes.some((n) => (n.about ?? []).some((l) => l.place)));

      // Reload: the book reopens and its highlight is painted again.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await marks(page)).length > 0, 8000);
      assert.equal((await marks(page)).join(""), text, "the same highlight comes back");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // The bubble (session 3): a click on a mark opens Copy · Remove; Remove starts the
    // undo window (Removed · Undo, the mark dimmed), Undo brings it back, and a second
    // Remove that elapses takes the highlight for good — gone here and after a reload.
    // Browser: a gesture.
    test("the bubble's Undo brings a removed highlight back", async () => {
      const { page, problems } = await openPage(browser, await seedUser({ books: [BOOK_ONE], open: BOOK_ONE }));
      await readerHasText(page);
      await dragOver(page, await dragRect(page));
      await until(async () => (await marks(page)).length > 0);

      // Click the mark: its bubble opens reading Copy · Remove.
      await clickFirstMark(page);
      await until(async () => /Copy/.test(await bubbleText(page) ?? "") && /Remove/.test(await bubbleText(page) ?? ""));

      // Remove: the bubble reads Removed · Undo and the mark dims; Undo brings it back
      // inside the real window, which this test never waits out.
      await clickBubble(page, ".act.remove");
      await until(async () => /Removed/.test(await bubbleText(page) ?? "") && (await markRemoving(page)));
      await clickBubble(page, ".act.undo");
      await until(async () => /Copy/.test(await bubbleText(page) ?? "") && !(await markRemoving(page)));
      assert.ok((await marks(page)).length > 0, "the highlight is back after undo");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // Browser: a reload against real storage.
    test("a removed highlight stays gone after a reload", async () => {
      const { page, problems } = await openPage(browser, await seedUser({ books: [BOOK_ONE], open: BOOK_ONE }), { undoMs: 10 });
      await readerHasText(page);

      // Make a highlight, and let its note reach the server before the removal, so the
      // tombstone (below) is what a fresh load pulls — the reload stays deterministic.
      await dragOver(page, await dragRect(page));
      await until(async () => (await marks(page)).length > 0);
      await synced(page, (notes) => notes.some((n) => (n.about ?? []).some((l) => l.place)));

      // Remove; the short window elapses at once: the mark goes and the note becomes a
      // tombstone that reaches the server.
      await clickFirstMark(page);
      await until(async () => /Remove/.test(await bubbleText(page) ?? ""));
      await clickBubble(page, ".act.remove");
      await until(async () => (await marks(page)).length === 0);
      await synced(page, (notes) => notes.some((n) => n.deleted && (n.about ?? []).some((l) => l.place)));

      // A reload keeps it gone: the tombstone is pulled, and no mark is painted.
      const pulled = page.waitForResponse((res) => res.url().includes("/api/notes?since="));
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await readerHasText(page);
      // What the pull brought has been announced and painted.
      await pulled;
      await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
      assert.equal((await marks(page)).length, 0, "the removed highlight does not come back");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });

  // The Highlights tab (session 5) as the page composes it: the row in Notes, the document
  // in the Notes pair, the book kept the subject. What the document does itself (a
  // comment, the fixed quote line, removing with undo) is tested in highlight-notes.
  describe(`the highlights tab in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    afterEach(async () => {
      await Promise.all(browser.contexts().map((c) => c.close()));
    });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });
    // The sample, open, with one highlight on it, commented.
    const withHighlight = () =>
      seedUser({ books: [BOOK_ONE], open: BOOK_ONE, notes: [{ id: HIGHLIGHT, body: "A thought about this", about: highlightOn(BOOK_ONE) }] });

    // The Highlights row opens the document inside the Notes pair (Decision 1, 2, 5, 7):
    // it stands in the list showing the count, picking it shows the document under the
    // Notes Back bar, the highlight is never a plain note, and Back returns to the list with the row selected.
    // Browser: a page's composition.
    test("the Highlights row opens the document in the Notes pair and keeps the book the subject", async () => {
      const { page, problems } = await openPage(browser, await withHighlight());

      // The Highlights row stands in the list showing one highlight, not yet selected, and
      // no plain note is listed for it.
      await until(async () => (await highlightsRow(page))?.subtitle === "1 highlight", 8000);
      assert.deepEqual(await shownTitles(page), [], "the highlight is not among the plain notes");
      assert.equal((await highlightsRow(page)).selected, "false", "the row is not selected before it is picked");

      // Pick it: the document shows under the "Notes" Back bar, its quote the book's
      // highlight.
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);
      assert.equal(await notesBarLabel(page), "Notes", "the document opens under the Notes Back bar");
      assert.deepEqual(await shownTitles(page), [], "still no plain note for the highlight");

      // Back returns to the list, and the Highlights row reads as the open one.
      await clickNotesBack(page);
      await until(async () => (await assignedNotes(page)).includes("note-list"));
      await until(async () => (await highlightsRow(page))?.selected === "true");

      // Picking New note shows the editor, and the Highlights row is no longer selected.
      await clickNew(page);
      await until(async () => (await assignedNotes(page)).includes("note-editor"));
      await until(async () => (await highlightsRow(page))?.selected === "false");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // The document stays inside the Notes pair even when Notes is brought to the stage (12):
    // the book remains the subject and the highlight is never
    // listed as a plain note, whether the pair is docked or staged.
    // Browser: a page's composition.
    test("the highlights document holds the Notes pair when it is staged", async () => {
      const { page, problems } = await openPage(browser, await withHighlight());
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0, 8000);

      // Bring the Notes container to the stage: the document still shows there, Notes still
      // does not list the highlight (the book is the subject; the highlights document is a
      // view about it, not a thing of its own).
      await stageNotes(page);
      await until(async () => (await stagedTab(page)) === "Notes");
      await until(async () => (await hnQuotes(page)).length > 0);
      assert.deepEqual(await shownTitles(page), [], "Notes does not list the highlight with the document staged");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // Only one row is ever selected (Decision 7): opening a new note marks the New note row
    // as open; then picking Highlights must move the selection, not add a second one. This is
    // the New-note-first order, where the draft row is the open one when Highlights is picked.
    // Browser: a page's composition.
    test("opening New note then Highlights leaves only the Highlights row selected", async () => {
      const { page, problems } = await openPage(browser, await withHighlight());
      await until(async () => (await highlightsRow(page)) != null, 8000);

      // Open a new note, then return to the list: the New note row reads as the open one.
      await clickNew(page);
      await until(async () => (await assignedNotes(page)).includes("note-editor"));
      await clickNotesBack(page);
      await until(async () => (await assignedNotes(page)).includes("note-list"));
      await until(async () => (await draftSelected(page)) === "true");

      // Pick Highlights and come back: the selection moves to it, and the New note row is
      // no longer selected — never two selected rows at once.
      await showHighlights(page);
      await clickNotesBack(page);
      await until(async () => (await assignedNotes(page)).includes("note-list"));
      await until(async () => (await highlightsRow(page)).selected === "true");
      assert.equal(await draftSelected(page), "false", "the New note row is no longer selected");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // The phone preview shows either the list or the picked item in the Notes tab, so the
    // row opens the document and Back returns to the list there too (Decision, phone flow).
    if (engine.name === "webkit") {
      // Browser: rendering and layout.
      test("the Highlights row opens and closes on the phone preview", async () => {
        const { page, problems } = await openPage(browser, await withHighlight(), { phone: true });
        await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");

        await showHighlights(page);
        await until(async () => (await hnQuotes(page)).length > 0);
        assert.equal(await notesBarLabel(page), "Notes", "the document opens under the Notes Back bar");

        await clickNotesBack(page);
        await until(async () => (await assignedNotes(page)).includes("note-list"));
        assert.equal(await notesBarLabel(page), null, "Back returns to the list");

        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
        await page.close();
      });
    }
  });
}
