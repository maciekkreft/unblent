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
  page.on("requestfailed", (req) => problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
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

// The note the editor is showing (its body is its whole text; a seeded note's body is
// its title). Empty string when the editor holds no note.
const editorBody = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector("textarea")?.value ?? "");

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

// The titles the list actually shows (the next-note draft row excluded).
const shownTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("note-list").shadowRoot.querySelectorAll(".row:not(.draft)")].map((r) =>
      r.querySelector(".name").textContent.trim(),
    ),
  );

// Whether the list is showing a scope switch at all. There is none any more: the list
// shows the notes about the subject, with no "all notes" fallback.
const hasSwitch = (page) =>
  page.evaluate(() => Boolean(document.querySelector("note-list").shadowRoot.querySelector(".scope")));

const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

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

      // Picking a note in the list while pinned is refused (slice 7, D7/D8): the note on
      // screen does not change, the pin flashes its danger border, and a toast explains.
      await clickRow(page, NOTE_ONE);
      await until(async () => await pinFlashing(page));
      await until(async () => /pinned/i.test(await noticeText(page)));
      assert.equal(await editorBody(page), "About two", "a refused pick did not change the note");

      // Unpin: nothing changes on screen, and the pin is no longer pressed.
      await clickPin(page);
      await until(async () => !(await pinPressed(page)));
      assert.equal(await editorBody(page), "About two");

      // Unpinned, the same pick now opens (forgiveness, one step): the editor follows it.
      // The stage is book one, so its note is what the list shows.
      await clickRow(page, NOTE_ONE);
      await until(async () => (await editorBody(page)) === "About one");
      await until(async () => sameSet(await shownTitles(page), ["About one"]));

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      await page.close();
    });
  });
}
