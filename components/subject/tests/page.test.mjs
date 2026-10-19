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

// The subject stem in a context of its own (11.2): the user's cookie, empty storage.
const openPage = async (browser, cookie) => {
  const context = await browser.newContext();
  context.setDefaultTimeout(4000);
  await context.addCookies([{ name: "unblent_session", value: cookie, url: BASE_URL }]);
  const page = await context.newPage();
  const problems = [];
  watch(page, problems);
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

      // The note opened is pinned without a press (the pin starts on). Move the stage to
      // the other book so the pinned note's book is no longer on the stage — the case
      // where the About line used to go blank after a reload.
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
}
