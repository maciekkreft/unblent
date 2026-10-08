import { test, describe, before, after, afterEach } from "node:test";
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
// The subject stem page holds the reader with `highlights` and the notes fact.
const PAGE = `${BASE_URL}/workshop/design/subject`;
const BOOK_ID = "01K00000000000000000000SMP";

// The "Vim keys" preference (12), seeded the way settings stores it (the workshop
// profile, since the page is under /workshop/).
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// A user set up straight through the server (5): the sample book, open.
const seedUser = async () => {
  const cookie = forgeCookie("reader-keys");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK_ID}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK_ID}/opened`, "application/json", "{}");
  return cookie;
};

const marks = (page) =>
  page.evaluate(() => [...document.querySelector("book-reader").shadowRoot.querySelectorAll(".strip mark")].map((m) => m.textContent));
const serverNotes = (page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error(`list ${res.status}`);
    return (await res.json()).notes;
  });
// Nudge `notes` to drain its outbox now rather than after its idle window.
const drain = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
// The pending passage the reader paints while a highlight is in progress.
const pending = (page) => page.evaluate(() => String(CSS.highlights.get("reader-pending")?.values().next().value ?? ""));

for (const engine of ENGINES) {
  describe(`keyboard highlights in ${engine.name}`, { timeout: 120000 }, () => {
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

    const open = async (vimKeys) => {
      const problems = [];
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await signedIn(context, await seedUser());
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), seed(vimKeys));
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const r = document.querySelector("book-reader")?.shadowRoot;
        return r?.querySelector(".footer .chap")?.textContent.trim() === "Chapter One" && r.querySelector(".strip")?.textContent.includes("Chapter One");
      });
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());
      return { page, problems };
    };

    // v starts at the cursor, on the page's first word; two w move it onto the next
    // heading, which the passage stops before. Enter makes the highlight the mouse
    // would: painted in the reader and saved as a note with a place.
    test(`v w w Enter makes a highlight in ${engine.name}`, async () => {
      const { page, problems } = await open(true);
      // Vim arrives with the settings reply; v starts a highlight only once it has.
      await until(async () => {
        await page.keyboard.press("v");
        if ((await pending(page)) === "C") return true;
        await page.keyboard.press("Escape");
        return false;
      });
      await page.keyboard.press("w");
      await page.keyboard.press("w");
      assert.equal(await pending(page), "Chapter One");
      await page.keyboard.press("Enter");
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      assert.equal(await pending(page), "");
      await drain(page);
      await until(async () => (await serverNotes(page)).some((n) => (n.about ?? []).some((l) => l.place && l.quote?.exact === "Chapter One")), 8000);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Ctrl+v starts a highlight exactly as v does (12, "Vim keys").
    test(`Escape drops a keyboard highlight begun with Ctrl+v in ${engine.name}`, async () => {
      const { page, problems } = await open(true);
      await until(async () => {
        await page.keyboard.press("Control+v");
        if ((await pending(page)) === "C") return true;
        await page.keyboard.press("Escape");
        return false;
      });
      await page.keyboard.press("w");
      await page.keyboard.press("Escape");
      assert.equal(await pending(page), "");
      await page.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(await marks(page), []);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    test(`with Vim keys off v does nothing in ${engine.name}`, async () => {
      const { page, problems } = await open(false);
      // Give the settings reply time to land, so off is the answer and not the default.
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.press("v");
      await page.keyboard.press("Control+v");
      await page.keyboard.press("w");
      await page.keyboard.press("Enter");
      assert.equal(await pending(page), "");
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(await marks(page), []);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });
  });
}
