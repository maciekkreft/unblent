import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
const BOOK_ID = "01K00000000000000000000SMP";
const HL_ID = "01K00000000000000000000HG1";
const NOTE_ID = "01K00000000000000000000NT1";

// Slip-Box is not released until the admin releases it (3.1), so the account's picture of
// the features is answered by the route: every feature released and shown.
const showAll = (context) =>
  context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: ["choice-points", "slip-box"], shown: ["choice-points", "slip-box"] } }));

// A user set up straight through the server (5): the sample book open, a highlight of its
// first heading, and a note about that chapter, which the Notes panel opens beside it.
const seedUser = async (name = "reader-add") => {
  const cookie = forgeCookie(name);
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK_ID}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK_ID}/opened`, "application/json", "{}");
  const place = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 11 } };
  const quote = { exact: "Chapter One", prefix: "", suffix: "" };
  await put(`/api/notes/${HL_ID}`, "application/json", JSON.stringify({ title: "", body: "", baseVersion: null, about: [{ kind: "book", id: BOOK_ID, place, quote }] }));
  const about = [{ kind: "book", id: BOOK_ID, chapter: "chapter-one", chapterTitle: "Chapter One" }];
  await put(`/api/notes/${NOTE_ID}`, "application/json", JSON.stringify({ title: "My note", body: "My note\n\nSome thoughts.", baseVersion: null, about }));
  return cookie;
};

// The bubble's buttons, each with its tooltip while it is greyed.
const bubble = (page) =>
  page.evaluate(() =>
    [...document.querySelector("book-reader").shadowRoot.querySelectorAll(".bubble .act")].map(
      (b) => `${b.textContent.trim()}${b.getAttribute("aria-disabled") === "true" ? ` (${b.title})` : ""}`,
    ),
  );
const passages = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("note-editor#notes-editor")?.shadowRoot?.querySelectorAll(".sections .section") ?? [])][0]?.textContent.replace(/\s+/g, " ").trim() ?? null,
  );

// The reason over the reader's foot, or null.
const why = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".command.why")?.textContent.trim() ?? null);

for (const engine of ENGINES) {
  // Browser: a page's composition (the reader's bubble adds the passage to the note the
  // Notes panel shows, whose footer lists it, and the page's Undo takes it out again).
  test(`Add to note puts the passage in the note open beside the book, and Undo takes it out, in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await showAll(context);
      await signedIn(context, await seedUser());
      const page = await context.newPage();
      const problems = watch(page, []);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot?.querySelectorAll(".strip mark").length > 0);
      await until(async () => /My note/.test((await page.evaluate(() => document.querySelector("note-editor#notes-editor")?.shadowRoot?.querySelector(".cm-content")?.textContent)) ?? ""));
      const box = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot.querySelector(".strip mark").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copy link · Add to note · Comment · Remove");
      assert.match(await passages(page), /No passages/i, "the note holds no passage yet");

      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".bubble .add").click());
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copy link · Added (Already in this note) · Comment · Remove");
      await until(async () => /Chapter One/.test(await passages(page)));
      // The greyed button still takes a press and says why over the foot, for a finger.
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".bubble .add").click());
      await until(async () => (await why(page)) === "Already in this note");
      assert.match(await passages(page), /Chapter One/, "a greyed press adds nothing");

      await page.evaluate(() => document.querySelector("undo-bar").shadowRoot.querySelector("button.undo").click());
      await until(async () => /No passages/i.test(await passages(page)));
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copy link · Add to note · Comment · Remove");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Browser: focus and keys (with Vim keys on, a on the highlight under the cursor adds
  // it to the note beside the book, and a again says why it cannot over the foot).
  test(`a adds the highlight under the cursor to the note, in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await showAll(context);
      await signedIn(context, await seedUser("reader-add-key"));
      const page = await context.newPage();
      const problems = watch(page, []);
      const prefs = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });
      await page.addInitScript((v) => localStorage.setItem("settings:product", v), prefs);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot?.querySelectorAll(".strip mark").length > 0);
      await until(async () => /My note/.test((await page.evaluate(() => document.querySelector("note-editor#notes-editor")?.shadowRoot?.querySelector(".cm-content")?.textContent)) ?? ""));
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());
      await page.keyboard.press("a");
      await until(async () => /Chapter One/.test(await passages(page)));
      assert.equal((await bubble(page)).join(" · "), "Copy · Copy link · Added (Already in this note) · Comment · Remove");
      await page.keyboard.press("a");
      await until(async () => (await why(page)) === "Already in this note");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
