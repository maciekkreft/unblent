import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// The server module is the far end of the same component (section 3), tested against
// the live check server. Every route needs a signed-in user (5), so the test forges
// the session cookie the server would set — an HMAC over the user id under
// SESSION_SECRET, which checks/check.py passes into the env — rather than running a
// passkey ceremony. Each test uses its own user id, hence its own per-user database
// and book directory (5), so tests never see each other's books.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const SAMPLE = readFileSync(new URL("./fixtures/sample.epub", import.meta.url));
const BROKEN = readFileSync(new URL("./fixtures/broken.epub", import.meta.url));
const GAPS = readFileSync(new URL("./fixtures/gaps.epub", import.meta.url));
const ONEPIECE = readFileSync(new URL("./fixtures/onepiece.epub", import.meta.url));
const STYLED = readFileSync(new URL("./fixtures/styled.epub", import.meta.url));

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshUser = () => `books-test-${Date.now()}-${counter++}`;
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const importBook = (id, bytes, cookie) =>
  fetch(`${BASE_URL}/api/books/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/epub+zip", ...(cookie ? { Cookie: cookie } : {}) },
    body: bytes,
  });
const position = (id, body, cookie) =>
  fetch(`${BASE_URL}/api/books/${id}/position`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const setTitle = (id, title, cookie) =>
  fetch(`${BASE_URL}/api/books/${id}/title`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ title }),
  });
const remove = (id, cookie) =>
  fetch(`${BASE_URL}/api/books/${id}/deleted`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: "{}",
  });
const opened = (id, cookie) =>
  fetch(`${BASE_URL}/api/books/${id}/opened`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: "{}",
  });
const pull = (since, cookie) =>
  fetch(`${BASE_URL}/api/books?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });
const getChapter = (id, cv, index, cookie) =>
  fetch(`${BASE_URL}/api/books/${id}/${cv}/chapters/${index}`, { headers: cookie ? { Cookie: cookie } : {} });
const getImage = (id, cv, name, cookie) =>
  fetch(`${BASE_URL}/api/books/${id}/${cv}/images/${name}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user (401 without a cookie)", async () => {
  assert.equal((await importBook(ID, SAMPLE)).status, 401);
  assert.equal((await pull(0)).status, 401);
  assert.equal((await position(ID, { chapter: 0, block: 0 })).status, 401);
  assert.equal((await opened(ID)).status, 401);
  assert.equal((await setTitle(ID, "x")).status, 401);
});

test("an import returns the row: chapter titles, a cover URL, and the resolved TOC", async () => {
  const cookie = cookieFor(freshUser());
  const row = await (await importBook(ID, SAMPLE, cookie)).json();
  assert.equal(row.title, "Sample Book");
  assert.equal(row.author, "A. Writer");
  assert.equal(row.version, 1);
  assert.equal(row.contentVersion, 1);
  assert.equal(row.pending, undefined, "the server row carries no pending flag; the browser adds it");
  assert.deepEqual(row.chapters.map((c) => c.title), ["Chapter One", "Chapter Two", "Chapter Three"]);
  assert.match(row.cover, /^\/api\/books\/.*\/1\/images\/.*\.png$/);
  assert.deepEqual(row.position, { chapter: 0, block: 0 });
  // The TOC's "The Middle" points at chapter index 1, a block past the start.
  const mid = row.toc[1].children[0];
  assert.equal(mid.title, "The Middle");
  assert.equal(mid.chapter, 1);
  assert.ok(mid.block > 0, "the fragment resolved to a mid-chapter block");
});

test("import tolerates a publisher's gaps: SVG covers, unlisted pieces, empty spacers", async () => {
  const cookie = cookieFor(freshUser());
  const row = await (await importBook(ID, GAPS, cookie)).json();
  const titles = row.chapters.map((c) => c.title);

  // C: seven spine pieces, the empty spacer dropped, six served chapters.
  assert.equal(titles.length, 6, "the empty spacer left the reading order");
  // B: every piece is named from the book, never an invented "Chapter N".
  assert.ok(!titles.some((t) => /^Chapter \d+$/.test(t)), `no invented chapter numbers: ${titles}`);
  assert.deepEqual(titles, [
    "Cover", // a TOC entry
    "Chapter A", // a TOC entry and its own heading
    "Full-Page Plate", // the title on its <section>, no heading of its own
    "Ebook Instructions", // its short opening line
    "Chapter B", // a TOC entry
    "Chapter B", // unlisted: inherits the entry it sits under
  ]);

  // C: the SVG-wrapped cover and the SVG illustration each render as an image, not a
  // blank page; the cover is also the row's cover URL. A page that is only a picture is
  // a <figure>, so the reader gives it the page instead of a running-text glyph's height.
  assert.match(row.cover, /^\/api\/books\/.*\/1\/images\/.*\.png$/);
  assert.match(await (await getChapter(ID, 1, 0, cookie)).text(), /^\s*<figure><img[^>]+src=/, "the cover fills the page as a figure");
  assert.match(await (await getChapter(ID, 1, 2, cookie)).text(), /^\s*<figure><img[^>]+src=/, "the illustration fills the page as a figure");

  // C: a link that pointed at the dropped spacer (spine 3) follows to the piece that
  // replaced it, now served as chapter 3.
  const chapterA = await (await getChapter(ID, 1, 1, cookie)).text();
  assert.match(chapterA, /data-chapter="3"/, "the link into the dropped piece lands on its successor");

  // The nav's three entries survive with the reindexed chapter numbers.
  assert.deepEqual(
    row.toc.map((e) => [e.title, e.chapter]),
    [["Cover", 0], ["Chapter A", 1], ["Chapter B", 4]],
  );
});

test("a book in one file is cut where its contents begin each chapter", async () => {
  const cookie = cookieFor(freshUser());
  const row = await (await importBook(ID, ONEPIECE, cookie)).json();
  // The title page before the first entry stays a chapter, named by its opening line;
  // a part heading alone is the part's page, as in print.
  assert.deepEqual(row.chapters.map((c) => c.title), ["One Piece Book", "Part One", "Chapter One", "Chapter Two"]);
  assert.deepEqual(
    row.toc.map((e) => [e.title, e.chapter, e.block]),
    [["Part One", 1, 0], ["Chapter One", 2, 0], ["Chapter Two", 3, 0]],
  );
  // A deeper entry is a section of its chapter, not a cut.
  const section = row.toc[2].children[0];
  assert.equal(section.chapter, 3);
  assert.ok(section.block > 0, "the section stays inside Chapter Two");
  assert.match(await (await getChapter(ID, 1, 2, cookie)).text(), /data-chapter="3"/, "a link follows its target into its new chapter");
});

test("a paragraph the book's stylesheet makes large becomes a heading", async () => {
  const cookie = cookieFor(freshUser());
  await importBook(ID, STYLED, cookie);
  const html = await (await getChapter(ID, 1, 0, cookie)).text();
  assert.match(html, /<h1>Chapter 6: What is the Problem\?<\/h1>/, "2x body is a title");
  assert.match(html, /<h2>Looking with Eyes<\/h2>/, "1.5x body is a section heading");
  assert.match(html, /<h3>A small heading<\/h3>/, "1.2x and bold is a subheading");
  assert.match(html, /<p>Body text\.<\/p>/, "body stays a paragraph");
  assert.match(html, /<p>Large but not bold/, "large without bold stays a paragraph");
});

test("a second import of the same id is idempotent, returning the row unchanged", async () => {
  const cookie = cookieFor(freshUser());
  const first = await (await importBook(ID, SAMPLE, cookie)).json();
  const again = await (await importBook(ID, SAMPLE, cookie)).json();
  assert.equal(again.version, first.version);
  assert.equal(again.updatedAt, first.updatedAt);
});

// A disconnecting Mac fetches the account's own book files (12); nobody else's, and
// nothing for a missing book or an id that is not one.
test("a book's source file is served to its own account only", async () => {
  const cookie = cookieFor(freshUser());
  await importBook(ID, SAMPLE, cookie);
  const res = await fetch(`${BASE_URL}/api/books/${ID}/source`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/epub+zip");
  assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), SAMPLE), 0);
  const other = cookieFor(freshUser());
  assert.equal((await fetch(`${BASE_URL}/api/books/${ID}/source`, { headers: { Cookie: other } })).status, 404);
  assert.equal((await fetch(`${BASE_URL}/api/books/not-an-id/source`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${BASE_URL}/api/books/${ID}/source`)).status, 401);
});

test("a chapter is served as immutable HTML with the whitelist applied", async () => {
  const cookie = cookieFor(freshUser());
  await importBook(ID, SAMPLE, cookie);
  const res = await getChapter(ID, 1, 2, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("cache-control"), /immutable/);
  const html = await res.text();
  assert.ok(!html.includes("<div"), "the div wrapper is unwrapped");
  assert.ok(!html.includes("<script"), "the script is dropped");
  assert.ok(html.includes("<table"), "the table is kept");
  assert.ok(html.includes("<pre"), "the code listing is kept");
  assert.match(html, /<img src="\/api\/books\/[^"]*\/images\/[^"]*"/, "the image src is rewritten");
  const emoji = html.match(/<img[^>]*Smiling face emoji[^>]*>/);
  assert.ok(emoji, "the inline emoji image is kept");
  assert.ok(!/\b(class|width|height)=/.test(emoji[0]), "its presentational attributes are dropped (only src, alt kept)");
  assert.ok(html.includes("<dl>"), "the definition list is kept");
  assert.match(html, /<dt>Alpha<\/dt>/, "the term is kept");
  assert.match(html, /<dd><p>The <a>first<\/a>/, "the definition, its inner id-only anchor now bare, is kept");
  const ch0 = await (await getChapter(ID, 1, 0, cookie)).text();
  assert.match(ch0, /data-chapter="2" data-block="2"/, "a link to an id deep inside a dd resolves to the dl block");
  assert.match(ch0, /<h2>A LINKED HEADING<\/h2>/, "a title that is only a link is unwrapped to a plain heading");
  assert.ok(!/<h[1-6]><a/.test(ch0), "no heading is left as a link");
});

test("a re-import serves the book under the next content version", async () => {
  const user = freshUser();
  const cookie = cookieFor(user);
  await importBook(ID, SAMPLE, cookie);
  assert.equal((await getChapter(ID, 1, 2, cookie)).status, 200, "v1 is live before the re-import");

  // Re-import from the host, exactly as deploy/reimport-books.py does on the same
  // UNBLENT_DATA the check server reads. The script writes the row and files directly.
  execFileSync(`${ROOT}.venv/bin/python`, ["deploy/reimport-books.py", user, ID], {
    cwd: ROOT,
    env: process.env,
  });

  const row = (await (await pull(0, cookie)).json()).books.find((b) => b.id === ID);
  assert.equal(row.contentVersion, 2, "the pull carries the new content version");
  assert.deepEqual(row.position, { chapter: 0, block: 0 }, "the position resets to the chapter start");
  assert.equal((await getChapter(ID, 2, 2, cookie)).status, 200, "the v2 chapter is served");
  assert.equal((await getChapter(ID, 1, 2, cookie)).status, 404, "the v1 URL 404s, so the old cache lapses");
});

test("a chapter 404s on a wrong content version or an index past the end", async () => {
  const cookie = cookieFor(freshUser());
  await importBook(ID, SAMPLE, cookie);
  assert.equal((await getChapter(ID, 2, 0, cookie)).status, 404, "wrong content version");
  assert.equal((await getChapter(ID, 1, 9, cookie)).status, 404, "index past the end");
});

test("an image is served with its media type, and a traversal is refused", async () => {
  const cookie = cookieFor(freshUser());
  const row = await (await importBook(ID, SAMPLE, cookie)).json();
  const name = row.cover.split("/").pop();
  const res = await getImage(ID, 1, name, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /image\/png/);
  assert.equal((await getImage(ID, 1, encodeURIComponent("../source.epub"), cookie)).status, 404);
});

test("a position write bumps the version and is never refused", async () => {
  const cookie = cookieFor(freshUser());
  await importBook(ID, SAMPLE, cookie);
  const moved = await (await position(ID, { chapter: 1, block: 4 }, cookie)).json();
  assert.equal(moved.version, 2);
  assert.deepEqual(moved.position, { chapter: 1, block: 4 });
  // No base version, ever: a second write from a "stale" client still wins.
  const again = await (await position(ID, { chapter: 2, block: 0 }, cookie)).json();
  assert.equal(again.version, 3);
  assert.deepEqual(again.position, { chapter: 2, block: 0 });
});

test("GET since a cursor returns only what changed, tombstones included", async () => {
  const cookie = cookieFor(freshUser());
  await importBook(ID, SAMPLE, cookie);
  await importBook(ID2, SAMPLE, cookie);
  const all = await (await pull(0, cookie)).json();
  assert.equal(all.books.length, 2);
  assert.ok(all.cursor >= 2);
  const after = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(after.books, []);
  await remove(ID, cookie);
  const delta = await (await pull(all.cursor, cookie)).json();
  const gone = delta.books.find((b) => b.id === ID);
  assert.equal(gone.deleted, true, "the tombstone rides the pull like any change");
});

test("the open book is last write wins, never refused, and rides the pull", async () => {
  const cookie = cookieFor(freshUser());
  await importBook(ID, SAMPLE, cookie);
  await importBook(ID2, SAMPLE, cookie);
  // A fresh user has nothing open.
  assert.deepEqual((await (await pull(0, cookie)).json()).open, { id: null, at: 0 });

  const first = await (await opened(ID, cookie)).json();
  assert.equal(first.id, ID);
  assert.ok(first.at > 0, "the server stamps its own clock");
  // Setting the open book is not a book write: it does not bump the book's version or
  // the cursor, so it never provokes a book.changed on another device.
  const before = await (await pull(0, cookie)).json();
  const second = await (await opened(ID2, cookie)).json(); // last write wins
  const afterPull = await (await pull(0, cookie)).json();
  assert.equal(afterPull.open.id, ID2, "the pull carries the latest open");
  assert.ok(second.at >= first.at);
  assert.equal(afterPull.cursor, before.cursor, "opening a book does not advance the seq cursor");
});

test("a user title is last write wins, kept beside the file's, and rides the pull (D11)", async () => {
  const cookie = cookieFor(freshUser());
  const imported = await (await importBook(ID, SAMPLE, cookie)).json();
  assert.equal(imported.title, "Sample Book");
  assert.equal(imported.fileTitle, "Sample Book", "a fresh book's display and file titles match");

  const named = await (await setTitle(ID, "  My Copy  ", cookie)).json();
  assert.equal(named.title, "My Copy", "the display title is the user's, trimmed");
  assert.equal(named.fileTitle, "Sample Book", "the file's title is kept apart");
  assert.equal(named.version, imported.version + 1, "a rename bumps the version so it pulls");

  // No base version, ever: a second write from a "stale" client still wins.
  const again = await (await setTitle(ID, "Renamed", cookie)).json();
  assert.equal(again.title, "Renamed");
  assert.equal(again.version, named.version + 1);

  // An empty (or blank) title clears the user's, restoring the file's.
  const cleared = await (await setTitle(ID, "   ", cookie)).json();
  assert.equal(cleared.title, "Sample Book", "an empty title restores the file's");
  assert.equal(cleared.fileTitle, "Sample Book");

  const named2 = await (await setTitle(ID, "Again", cookie)).json();
  const pulled = (await (await pull(0, cookie)).json()).books.find((b) => b.id === ID);
  assert.equal(pulled.title, "Again", "the pull carries the latest display title");
  assert.equal(pulled.version, named2.version);

  // A title for a book that is not there is refused honestly.
  assert.equal((await setTitle(ID2, "x", cookie)).status, 404);
});

test("a re-import refreshes the file's title without touching the user's (D11)", async () => {
  const user = freshUser();
  const cookie = cookieFor(user);
  await importBook(ID, SAMPLE, cookie);
  await setTitle(ID, "My Name", cookie);

  execFileSync(`${ROOT}.venv/bin/python`, ["deploy/reimport-books.py", user, ID], {
    cwd: ROOT,
    env: process.env,
  });

  const row = (await (await pull(0, cookie)).json()).books.find((b) => b.id === ID);
  assert.equal(row.contentVersion, 2, "the re-import ran");
  assert.equal(row.title, "My Name", "the user's title survives a re-import");
  assert.equal(row.fileTitle, "Sample Book", "the file's title is refreshed underneath it");
});

test("a database file from before user titles gains the column, defaulting to the file's title", async () => {
  // node:sqlite is experimental; hush the one-time warning so the run stays clean.
  const saved = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const { join } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    const user = freshUser();
    const dir = join(process.env.UNBLENT_DATA, user);
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "books.db"));
    // The pre-user-title schema: a books table without user_title.
    db.exec(
      "CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, cover TEXT, " +
        "chapters TEXT NOT NULL, toc TEXT NOT NULL, position_chapter INTEGER NOT NULL DEFAULT 0, " +
        "position_block INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, content_version INTEGER NOT NULL DEFAULT 1, " +
        "added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);",
    );
    db.exec(
      `INSERT INTO books (id, title, author, cover, chapters, toc, version, added_at, updated_at, seq) ` +
        `VALUES ('${ID}', 'Old Title', 'A', NULL, '[]', '[]', 1, 5, 5, 1);`,
    );
    db.close();
    const cookie = cookieFor(user);
    const before = (await (await pull(0, cookie)).json()).books.find((b) => b.id === ID);
    assert.equal(before.title, "Old Title", "the migrated row reads its file title");
    assert.equal(before.fileTitle, "Old Title");
    const named = await (await setTitle(ID, "New Title", cookie)).json();
    assert.equal(named.title, "New Title", "the migrated db can now hold a user title");
    assert.equal(named.fileTitle, "Old Title");
  } finally {
    process.emitWarning = saved;
  }
});

test("a delete tombstones the row and purges the directory", async () => {
  const cookie = cookieFor(freshUser());
  const row = await (await importBook(ID, SAMPLE, cookie)).json();
  const name = row.cover.split("/").pop();
  assert.equal((await getChapter(ID, 1, 0, cookie)).status, 200);
  const gone = await (await remove(ID, cookie)).json();
  assert.equal(gone.deleted, true);
  assert.equal(gone.version, 2);
  // The directory is gone, so both file routes 404 (the row is a tombstone anyway).
  assert.equal((await getChapter(ID, 1, 0, cookie)).status, 404);
  assert.equal((await getImage(ID, 1, name, cookie)).status, 404);
  // A second delete is idempotent.
  const again = await (await remove(ID, cookie)).json();
  assert.equal(again.version, gone.version);
});

test("a delete for an unknown id is born a tombstone", async () => {
  const cookie = cookieFor(freshUser());
  const born = await (await remove(ID, cookie)).json();
  assert.equal(born.deleted, true);
  assert.equal(born.version, 1);
});

test("a file that is not an epub is refused with 422 and leaves no row", async () => {
  const cookie = cookieFor(freshUser());
  const res = await importBook(ID, BROKEN, cookie);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "unreadable" });
  const all = await (await pull(0, cookie)).json();
  assert.equal(all.books.length, 0, "no row was inserted");
});
