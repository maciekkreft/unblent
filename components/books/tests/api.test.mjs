import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

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

test("a second import of the same id is idempotent, returning the row unchanged", async () => {
  const cookie = cookieFor(freshUser());
  const first = await (await importBook(ID, SAMPLE, cookie)).json();
  const again = await (await importBook(ID, SAMPLE, cookie)).json();
  assert.equal(again.version, first.version);
  assert.equal(again.updatedAt, first.updatedAt);
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
