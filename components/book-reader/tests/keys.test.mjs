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
const seedUser = async ({ highlight = false } = {}) => {
  const cookie = forgeCookie("reader-keys");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK_ID}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK_ID}/opened`, "application/json", "{}");
  if (highlight) {
    const about = [{ kind: "book", id: BOOK_ID, place: HL_PLACE, quote: { exact: "Chapter One", prefix: "", suffix: "" } }];
    await put(`/api/notes/${HL_ID}`, "application/json", JSON.stringify({ title: "", body: "", baseVersion: null, about }));
  }
  return cookie;
};
// A highlight of the first page's heading, which the Vim cursor starts on.
const HL_ID = "01K00000000000000000000HG1";
const HL_PLACE = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 11 } };
const LINK = `[Chapter One](note:${HL_ID})`;
// A highlight of the heading half way through Chapter Two, several pages in, and a note
// holding a source link to it.
const MID_ID = "01K00000000000000000000HG2";
const MID_PLACE = { chapter: 1, contentVersion: 1, start: { block: 32, offset: 0 }, end: { block: 32, offset: 10 } };
const LIT_ID = "01K00000000000000000000NT1";
// The text the page last put on the clipboard: writeText is recorded, so the test reads
// what was copied without a clipboard permission prompt.
const recordClipboard = () => {
  navigator.clipboard.writeText = async (t) => {
    window.__copied = t;
  };
};
const copied = (page) => page.evaluate(() => window.__copied ?? null);
const bubble = (page) =>
  page.evaluate(() => [...(document.querySelector("book-reader").shadowRoot.querySelectorAll(".bubble .act") ?? [])].map((b) => b.textContent.trim()));

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

    const open = async (vimKeys, { highlight = false } = {}) => {
      const problems = [];
      context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await signedIn(context, await seedUser({ highlight }));
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), seed(vimKeys));
      await page.addInitScript(recordClipboard);
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
    // Browser: focus and keys.
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
    // Browser: focus and keys.
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

    // A click on a mark opens its bubble; Copy link puts the stored link on the clipboard
    // and only that button reads Copied.
    // Browser: a gesture.
    test(`Copy link in a highlight's bubble copies the link in ${engine.name}`, async () => {
      const { page, problems } = await open(false, { highlight: true });
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      const box = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot.querySelector(".strip mark").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copy link · Remove");
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".bubble .copy-link").click());
      await until(async () => (await bubble(page)).join(" · ") === "Copy · Copied · Remove");
      assert.equal(await copied(page), LINK);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // y with the cursor inside a highlight opens its bubble and does Copy link.
    // Browser: focus and keys.
    test(`y inside a highlight copies its link in ${engine.name}`, async () => {
      const { page, problems } = await open(true, { highlight: true });
      await until(async () => (await marks(page)).join(" ") === "Chapter One");
      // Vim arrives with the settings reply; y acts only once it has.
      await until(async () => {
        await page.keyboard.press("y");
        return (await bubble(page)).join(" · ") === "Copy · Copied · Remove";
      });
      assert.equal(await copied(page), LINK);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // A click on a source link in a note opens the page holding the passage, in another
    // chapter, and its highlight glows for about a second.
    // Browser: rendering and layout.
    test(`following a source link opens the passage and glows it in ${engine.name}`, async () => {
      const problems = [];
      context = await browser.newContext({ viewport: { width: 1300, height: 800 } });
      context.setDefaultTimeout(4000);
      const cookie = await seedUser();
      const put = async (id, note) => {
        const res = await fetch(`${BASE_URL}/api/notes/${id}`, { method: "PUT", headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` }, body: JSON.stringify({ baseVersion: null, ...note }) });
        assert.equal(res.status, 200);
      };
      await put(MID_ID, { title: "", body: "", about: [{ kind: "book", id: BOOK_ID, place: MID_PLACE, quote: { exact: "The Middle", prefix: "", suffix: "" } }] });
      await put(LIT_ID, { title: "Lit", body: `Lit\n\nsee [The Middle](note:${MID_ID}) end`, about: [{ kind: "book", id: BOOK_ID }] });
      await signedIn(context, cookie);
      const page = await context.newPage();
      watch(page, problems);
      await page.addInitScript((v) => localStorage.setItem("settings", v), seed(false));
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.locator("note-list").getByText("Lit", { exact: true }).click();
      await page.locator("note-editor .cm-source-link").click();
      // The glowing mark is the passage, shown on the page in view, in Chapter Two.
      const glow = () =>
        page.evaluate(() => {
          const r = document.querySelector("book-reader").shadowRoot;
          const mark = r.querySelector(".strip mark.glow");
          if (!mark) return null;
          const m = mark.getBoundingClientRect();
          const p = r.querySelector(".page").getBoundingClientRect();
          return { text: mark.textContent, chap: r.querySelector(".footer .chap").textContent.trim(), shown: m.left >= p.left && m.right <= p.right, tinted: getComputedStyle(mark).backgroundColor };
        });
      let lit = null;
      await until(async () => (lit = await glow())?.shown === true);
      assert.equal(lit.text, "The Middle");
      assert.equal(lit.chap, "Chapter Two");
      // The glow ends by itself: the mark goes back to the plain highlight.
      await until(async () => (await glow()) === null, 3000);
      assert.equal(await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".strip mark")?.textContent), "The Middle");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
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
