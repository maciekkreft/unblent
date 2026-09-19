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
const PAGE = `${BASE_URL}/workshop/design/subject`;

// Two valid ULIDs to seed notes with (the notes: list reply requires the ULID shape).
const NOTE_ONE = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const NOTE_TWO = "01ARZ3NDEKTSV4RRFFQ69G5FB2";

// The console lines trace prints (section 10) show subject is wired, not just
// rendered: on start it asks dock and books for the starting picture (D3, 4.3).
const ASKS_DOCK = /query read subject → dock/;
const ASKS_BOOKS = /query open subject → books/;

function watch(page, problems) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
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

// Import the sample epub and return the id of the tile it adds. The fixture can be
// imported more than once: each import mints a fresh id, so two tiles share a title
// but are distinct books.
const importBook = async (page) => {
  const before = await tileIds(page);
  await page.locator("book-shelf input[type=file]").setInputFiles(SAMPLE);
  let id = null;
  await until(async () => {
    id = (await tileIds(page)).find((x) => !before.includes(x)) ?? null;
    return Boolean(id);
  });
  return id;
};

const openTile = (page, id) =>
  page.evaluate((id) => document.querySelector("book-shelf").shadowRoot.querySelector(`.tile[data-id="${id}"]`)?.click(), id);

// Seed a note straight to the server with its links (the editor does not yet link a new
// note to the subject — that is slice 5), so the list has notes to filter after a reload.
const seedNote = (page, { id, title, about }) =>
  page.evaluate(
    async ({ id, title, about }) => {
      const res = await fetch(`/api/notes/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body: title, baseVersion: null, about }),
      });
      if (!res.ok) throw new Error(`seed ${res.status}`);
    },
    { id, title, about },
  );

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
// its title). Empty string when the editor holds no note.
const editorBody = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector("textarea")?.value ?? "");

// The About line's text (12), "About: <book>" or "" when the line is empty.
const aboutText = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".about")?.textContent.trim() ?? "");

// Type into the editor's textarea through its input event (the gesture the editor hears).
const typeInto = (page, text) =>
  page.evaluate((text) => {
    const t = document.querySelector("note-editor").shadowRoot.querySelector("textarea");
    t.value = text;
    t.dispatchEvent(new Event("input", { bubbles: true }));
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

// Whether the editor's pin is flashing its danger border (a refusal, D7).
const pinFlashing = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".pin.flashing") != null);

// Click a note-list row by its note id, the gesture that emits note.selected.
const clickRow = (page, id) =>
  page.evaluate((id) => document.querySelector("note-list").shadowRoot.querySelector(`.row[data-id="${id}"]`)?.click(), id);

// The text of every notice showing in the stack (empty when none).
const noticeText = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("notice-stack")?.shadowRoot?.querySelectorAll(".notice p") ?? [])]
      .map((p) => p.textContent)
      .join(" "),
  );

// The titles the list actually shows (the next-note draft and the apart row excluded).
const shownTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("note-list").shadowRoot.querySelectorAll(".row:not(.draft):not(.apart)")].map((r) =>
      r.querySelector(".name").textContent.trim(),
    ),
  );

// The title of the row kept apart (the open note not about the subject), or null. Its
// aria-selected tells whether it reads as the open row.
const apartRow = (page) =>
  page.evaluate(() => {
    const r = document.querySelector("note-list").shadowRoot.querySelector(".row.apart");
    return r ? { title: r.querySelector(".name").textContent.trim(), selected: r.getAttribute("aria-selected") } : null;
  });

// Whether the list is showing a scope switch at all. There is none any more: the list
// shows the notes about the subject, with no "all notes" fallback.
const hasSwitch = (page) =>
  page.evaluate(() => Boolean(document.querySelector("note-list").shadowRoot.querySelector(".scope")));

const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

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

// Show the Highlights tab in the right dock (its tab may sit in the open strip or, on a
// narrow desk, in the folded rail): click whichever "Highlights" tab is visible.
const showHighlights = (page) =>
  page.evaluate(() => {
    const tabs = [...document.querySelector("dock-desk").shadowRoot.querySelectorAll('[role="tab"]')].filter(
      (t) => t.textContent.trim() === "Highlights",
    );
    (tabs.find((t) => t.offsetParent !== null) ?? tabs[0])?.click();
  });

// The Highlights document, and the text of each painted quote line: read through the
// EditorView the .cm-content node carries, the way the reader tests read the strip.
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

// Nudge `notes` to sync now instead of after its idle window: it drains the outbox on a
// visibilitychange (fact.js), so a test need not wait out the 2s debounce for a write to
// reach the server. The tab stays "visible", so this is a drain and a pull, as a focus is.
const drain = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

// Put the caret at the end (a comment line) or start (a quote line) of the document, the
// only deterministic way to aim typing at the empty comment line or the fixed quote line.
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

// WebKit first, then Chromium. This one test grows through slices 4-7 as the followers
// gain behaviour; for now it proves the subject stem composes and its fact is wired.
for (const engine of ENGINES) {
  test(`the subject stem composes the reader and the notes views in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const debug = [];
      const page = await context.newPage();
      watch(page, problems);
      page.on("console", (msg) => msg.type() === "debug" && debug.push(msg.text()));

      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);

      // The reader is on the stage; the notes views are the desk's children (8).
      const children = await page.evaluate(() =>
        [...document.querySelector("dock-desk").children].map((c) => c.localName),
      );
      for (const tag of ["book-reader", "book-shelf", "book-toc", "note-list", "note-editor"]) {
        assert.ok(children.includes(tag), `${tag} is a dock-desk child`);
      }

      // The derived fact is alive: with nothing on the stage it asks dock and books for
      // the starting picture and, finding no open book, announces no subject.
      await until(() => debug.some((l) => ASKS_DOCK.test(l)) && debug.some((l) => ASKS_BOOKS.test(l)));

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);

      // Phone preview: a fresh page of the same context that chose the phone preview
      // before load, so the desk is laid out inside the narrowed body without overflow.
      const phone = await context.newPage();
      watch(phone, problems);
      await phone.addInitScript(() => localStorage.setItem("viewport", "phone"));
      await phone.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(phone);
      await phone.waitForFunction(() => document.documentElement.dataset.viewport === "phone");
      const fits = await phone.evaluate(() => {
        const desk = document.querySelector("dock-desk");
        return desk.scrollWidth <= desk.clientWidth + 1;
      });
      assert.ok(fits, "the desk must not overflow sideways on the phone");
      mkdirSync(SCREENSHOTS, { recursive: true });
      await phone.screenshot({ path: resolve(SCREENSHOTS, `subject-phone-${engine.name}.png`) });

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });

  // Signed in, following the stage: the list shows only the notes about the open book,
  // with no switch to all notes (D5, D6). One browser per engine; the launch is the
  // costly part on a small host.
  describe(`the notes follow the stage in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    before(async () => {
      browser = await engine.launch();
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("the list shows the subject's notes, following the stage, with no switch", async () => {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);

      // Two books from the one fixture (distinct ids, same title), and a note about each,
      // seeded to the server so a reload brings them into the list.
      const one = await importBook(page);
      const two = await importBook(page);
      await seedNote(page, { id: NOTE_ONE, title: "About one", about: [{ kind: "book", id: one }] });
      await seedNote(page, { id: NOTE_TWO, title: "About two", about: [{ kind: "book", id: two }] });

      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await tileIds(page)).length >= 2);
      // No book open yet: both notes show (no subject to scope to). The list waits on the
      // reload's pull to bring the seeded notes, which is the one slow step here.
      await until(async () => sameSet(await shownTitles(page), ["About one", "About two"]), 8000);

      // Open the first book: it is on the stage, so only its note shows — with no switch
      // to all notes — and the editor follows the stage, opening that book's note (D6, D7).
      await openTile(page, one);
      await until(async () => sameSet(await shownTitles(page), ["About one"]));
      assert.equal(await hasSwitch(page), false, "there is no scope switch");
      await until(async () => (await editorBody(page)) === "About one");

      // Switch the stage to the other book: the first note's row goes, the second's comes,
      // and the editor follows to the second book's note.
      await openTile(page, two);
      await until(async () => sameSet(await shownTitles(page), ["About two"]));
      await until(async () => (await editorBody(page)) === "About two");

      // Pin the editor: now the stage may move but the pinned note stays (slice 5, D7).
      await clickPin(page);
      await until(async () => await pinPressed(page));
      await openTile(page, one);
      await until(async () => sameSet(await shownTitles(page), ["About one"]));
      assert.equal(await editorBody(page), "About two", "the pinned note did not follow the stage");

      // The pinned note is not about book one, so the list keeps it apart at the top,
      // highlighted as the open row, while book one's note shows below it (12, keeps-open).
      await until(async () => (await apartRow(page))?.title === "About two");
      assert.equal((await apartRow(page)).selected, "true", "the apart row reads as the open one");

      // Clicking the apart row is clicking the note already open: nothing changes, and it
      // is not refused, so no pin flash and no notice (task 1). Give a flash time to appear.
      await clickRow(page, NOTE_TWO);
      await page.waitForTimeout(200);
      assert.equal(await pinFlashing(page), false, "the open note's own row does not flash the pin");
      assert.ok(!/pinned/i.test(await noticeText(page)), "and shows no refusal notice");
      assert.equal(await editorBody(page), "About two");

      // Picking a different note while pinned is refused (slice 7, D7/D8): the note on
      // screen does not change, the pin flashes its danger border, and a toast explains.
      await clickRow(page, NOTE_ONE);
      await until(async () => await pinFlashing(page));
      await until(async () => /pinned/i.test(await noticeText(page)));
      assert.equal(await editorBody(page), "About two", "a refused pick did not change the note");

      // Unpin: nothing changes on screen, and the pin is no longer pressed. The note is
      // still open and still not about book one, so its apart row stays.
      await clickPin(page);
      await until(async () => !(await pinPressed(page)));
      assert.equal(await editorBody(page), "About two");
      assert.equal((await apartRow(page))?.title, "About two", "the apart row stays after unpinning");

      // Unpinned, the same pick now opens (forgiveness, one step): the editor follows it.
      // The stage is book one, so its note is what the list shows, and the apart row goes.
      await clickRow(page, NOTE_ONE);
      await until(async () => (await editorBody(page)) === "About one");
      await until(async () => sameSet(await shownTitles(page), ["About one"]));
      assert.equal(await apartRow(page), null, "the open note is about the subject now, so nothing is apart");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // The About line names a note's book after a reload (fault the reload race left blank),
    // and names the stage's book on a new note before anything is typed (12, about-new).
    // One page kept open throughout, so the book stays staged and the subject stays set;
    // reuses the two books and notes the first test seeded, on the same context.
    test("the About line survives a reload and names a new note", async () => {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await tileIds(page)).length >= 2, 8000);
      const [first, second] = await tileIds(page);

      // Open a book (the first test seeded one note about each; both books share the
      // title "Sample Book"): the editor names it above the note about it. Capture that
      // note's body, since the two books' order is the shelf's, not this test's.
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
      await openedDone.catch(() => {});

      // Reload: the pinned note comes back, still pinned, and its About line still names
      // its own book though that book is not the one now on the stage.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => (await editorBody(page)) === pinnedBody, 8000);
      assert.ok(await pinPressed(page), "the pinned note came back pinned");
      assert.equal(await aboutText(page), "About: Sample Book", "its book is named though it was never on this page's stage");

      // Unpin, open a fresh note: with about-new the line names the book on the stage at
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
      await until(async () => {
        stored = (await serverNotes(page)).find((n) => n.title === "A new note about the open book");
        return Boolean(stored);
      }, 8000);
      assert.deepEqual(stored.about, [{ kind: "book", id: first }], "the new note's book link reached the server");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });

  // The stage survives a reload (3.5): when the app is reopened and the staged book comes
  // back on its own, the list must scope to that book, not flash every note while the
  // subject-read reply (null, the book not open yet) races the slow notes pull. One
  // browser per engine; the book and its notes are seeded in before, so the test is a
  // fresh load and an assertion, well inside the budget.
  describe(`the stage survives a reload in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    const NOTE_BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FC3";
    const NOTE_NONE = "01ARZ3NDEKTSV4RRFFQ69G5FD4";
    before(async () => {
      browser = await engine.launch();
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
      // Import a book, open it so `books` remembers it and reopens it on the next load,
      // and seed one note about the book and one about nothing — both to the server, so a
      // fresh load's pull brings them.
      const page = await context.newPage();
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);
      const id = await importBook(page);
      const openedDone = page.waitForResponse(
        (r) => /\/opened$/.test(r.url()) && r.request().method() === "PUT",
        { timeout: 8000 },
      );
      await openTile(page, id);
      await openedDone.catch(() => {});
      await seedNote(page, { id: NOTE_BOOK, title: "About the book", about: [{ kind: "book", id }] });
      await seedNote(page, { id: NOTE_NONE, title: "About nothing", about: [] });
      await page.close();
    }, { timeout: 60000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("the auto-reopened book scopes the list to its notes, not every note", async () => {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      // A fresh load, nothing opened by hand: the book comes back on its own, so the
      // subject resolves to it and the list shows only its note. Before the fix, the late
      // notes reply re-applied the read's stale null and "About nothing" showed too.
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);
      await until(async () => sameSet(await shownTitles(page), ["About the book"]), 8000);
      // Let a clobber (the bug) flip the list back to every note before asserting it held.
      await page.waitForTimeout(400);
      assert.ok(
        sameSet(await shownTitles(page), ["About the book"]),
        `the list stayed scoped to the book; showed: ${(await shownTitles(page)).join(", ")}`,
      );
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });

  // The reader makes and paints highlights (session 2, D3/D4). Signed in so the highlight
  // note reaches the server and a reload brings it back. One browser per engine.
  describe(`the reader highlights in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    before(async () => {
      browser = await engine.launch();
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("a drag makes a highlight that holds the page count, stays off the list, and survives a reload", async () => {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);

      const id = await importBook(page);
      await openTile(page, id);
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
      await until(async () => (await serverNotes(page)).some((n) => (n.about ?? []).some((l) => l.place)), 8000);

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
    test("the bubble removes a highlight with undo, and it stays gone after a reload", async () => {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);

      const id = await importBook(page);
      await openTile(page, id);
      await readerHasText(page);

      // Make a highlight, and let its note reach the server before any removal, so the
      // tombstone (below) is what a fresh load pulls — the reload stays deterministic.
      await dragOver(page, await dragRect(page));
      await until(async () => (await marks(page)).length > 0);
      await until(async () => (await serverNotes(page)).some((n) => (n.about ?? []).some((l) => l.place)), 8000);

      // Click the mark: its bubble opens reading Copy · Remove.
      await clickFirstMark(page);
      await until(async () => /Copy/.test(await bubbleText(page) ?? "") && /Remove/.test(await bubbleText(page) ?? ""));

      // Remove: the bubble reads Removed · Undo and the mark dims; Undo brings it back.
      await clickBubble(page, ".act.remove");
      await until(async () => /Removed/.test(await bubbleText(page) ?? "") && (await markRemoving(page)));
      await clickBubble(page, ".act.undo");
      await until(async () => /Copy/.test(await bubbleText(page) ?? "") && !(await markRemoving(page)));
      assert.ok((await marks(page)).length > 0, "the highlight is back after undo");

      // Remove again and let the window elapse (--duration-undo, 3s): the mark goes and
      // the note becomes a tombstone that reaches the server.
      await clickFirstMark(page);
      await until(async () => /Remove/.test(await bubbleText(page) ?? ""));
      await clickBubble(page, ".act.remove");
      await until(async () => (await marks(page)).length === 0, 8000);
      await drain(page);
      await until(
        async () => (await serverNotes(page)).some((n) => n.deleted && (n.about ?? []).some((l) => l.place)),
        8000,
      );

      // A reload keeps it gone: the tombstone is pulled, and no mark is painted.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      await readerHasText(page);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal((await marks(page)).length, 0, "the removed highlight does not come back");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });

  // The Highlights tab (session 5): a highlight made in the book appears there as one
  // document; typing under it saves the comment (the book mark gains its accent); a quote
  // line cannot be edited; the bin removes with the same undo as note-list; a reload keeps
  // both. Signed in, so the notes reach the server and the reload is deterministic. One
  // browser per engine; the book import in `before` keeps the test itself inside budget.
  describe(`the highlights tab in ${engine.name}`, { timeout: 120000 }, () => {
    let browser;
    let context;
    before(async () => {
      browser = await engine.launch();
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await context.addCookies([{ name: "unblent_session", value: forgeCookie(), url: BASE_URL }]);
      // Import a book and open it once, persisted to the server, so the test itself is a
      // fresh load that auto-reopens it — the import cost stays out of the test's budget.
      const page = await context.newPage();
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);
      const id = await importBook(page);
      const openedDone = page.waitForResponse(
        (r) => /\/opened$/.test(r.url()) && r.request().method() === "PUT",
        { timeout: 8000 },
      );
      await openTile(page, id);
      await openedDone.catch(() => {});
      await page.close();
    }, { timeout: 60000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // A highlight made in the book appears in the tab and takes a comment that reaches the
    // server (so the next test, a fresh load, finds it). Split from the checks below so
    // each test — this one carries the drag and the save round-trip — stays inside budget.
    test("a highlight made in the book appears in the tab and takes a comment", async () => {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);
      await readerHasText(page);

      // Drag over a run of text, then open the tab: the highlight is one document, its
      // quote line the snapped text from the book.
      await dragOver(page, await dragRect(page));
      await until(async () => (await marks(page)).length > 0);
      const quote = (await marks(page)).join("");
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0);
      assert.equal((await hnQuotes(page)).join(""), quote, "the tab's quote line is the book's highlight");

      // The highlight note must reach the server before its comment is written, so the
      // comment's save is based on a real version, not the null of a note still being
      // created (an immediate second write on the same id would come back a conflict).
      await drain(page);
      await until(async () => (await serverNotes(page)).some((n) => (n.about ?? []).some((l) => l.place)), 8000);

      // Type a comment on the line under the quote; once it saves, the book mark gains its
      // commented accent (the round-trip through notes and back).
      await hnCaret(page, "end");
      await page.keyboard.type("A thought about this");
      await until(async () => (await hnDoc(page)).includes("A thought about this"));
      await until(
        async () =>
          page.evaluate(() => {
            const m = document.querySelector("book-reader").shadowRoot.querySelector(".strip mark");
            return m != null && m.classList.contains("commented");
          }),
        6000,
      );

      // The comment reaches the server, so the next test's fresh load brings it back.
      await drain(page);
      await until(async () => (await serverNotes(page)).some((n) => (n.body ?? "").includes("A thought about this")), 8000);

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });

    // A fresh load brings the highlight and comment the test above saved (a reload keeps
    // both); the quote line stays fixed against edits, and the bin removes with the same
    // undo window as note-list.
    test("a reload keeps the highlight, the quote line is fixed, and the bin removes with undo", async () => {
      const problems = [];
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await ready(page);
      await showHighlights(page);
      await until(async () => (await hnQuotes(page)).length > 0 && (await hnDoc(page)).includes("A thought about this"), 8000);

      // The quote line cannot be edited: typing on it and Backspace change nothing.
      const before = await hnDoc(page);
      await hnCaret(page, "start");
      await page.keyboard.type("ZZZ");
      await page.keyboard.press("Backspace");
      assert.equal(await hnDoc(page), before, "the quote line refused the edit");

      // The bin starts the undo window (Undo shown, the lines dimmed); Undo brings it back.
      await page.evaluate(() => document.querySelector("highlight-notes").shadowRoot.querySelector(".cm-bin")?.click());
      await until(async () => (await hnHas(page, ".cm-undo")) && (await hnHas(page, ".cm-discarding")));
      await page.evaluate(() => document.querySelector("highlight-notes").shadowRoot.querySelector(".cm-undo")?.click());
      await until(async () => (await hnHas(page, ".cm-bin")) && !(await hnHas(page, ".cm-undo")));

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });
}
