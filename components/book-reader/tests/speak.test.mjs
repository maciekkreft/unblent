import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Reading aloud in the reader, on the books stem page with the test voice (silence, with
// timings per character), so nothing is spent. /api/flags is routed, because
// data/flags.db is shared by every test, and Reading aloud is held back until released.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
const PAGE = `${BASE_URL}/workshop/design/books`;
const BOOK_ID = "01K00000000000000000000SMP";

const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// One user per run: the sample book, open, and the test voice picked.
const seedUser = async () => {
  const cookie = forgeCookie("reader-speak");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "PUT",
      headers: { "content-type": type, Cookie: `unblent_session=${cookie}`, "X-Unblent-Local": "1" },
      body,
    });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK_ID}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK_ID}/opened`, "application/json", "{}");
  await put("/api/voice", "application/json", JSON.stringify({ voice: "test" }));
  return cookie;
};

// What the reader shows of reading aloud: the footer's controls, the tinted block, the
// word lit, the margin buttons shown, and the page number.
const look = (page) =>
  page.evaluate(() => {
    const r = document.querySelector("book-reader")?.shadowRoot;
    const strip = r?.querySelector(".strip");
    const shown = (sel) => {
      const b = r?.querySelector(sel);
      return b && !b.hidden && getComputedStyle(b).display !== "none" ? Number(b.dataset.block) : null;
    };
    return {
      foot: [...(r?.querySelectorAll(".speakctl .speak") ?? [])].map((b) => b.textContent.trim()),
      tinted: strip ? [...strip.children].findIndex((c) => c.classList.contains("speaking")) : -1,
      word: String(CSS.highlights.get("reader-spoken")?.values().next().value ?? ""),
      read: shown(".say.read"),
      stop: shown(".say.stop"),
      command: r?.querySelector(".footer .command")?.textContent.trim() ?? "",
      pageno: r?.querySelector(".footer .pageno")?.textContent.trim() ?? "",
    };
  });

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`reading aloud in ${engine.name}`, { timeout: 40000 }, () => {
    let browser;
    let cookie;
    before(async () => {
      [browser, cookie] = await Promise.all([engine.launch(), seedUser()]);
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    async function open({ vimKeys = false, phone = false, hidden = [], route } = {}) {
      const context = await browser.newContext({ viewport: { width: 1300, height: 800 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, cookie);
      await context.route(/\/api\/flags$/, (r) =>
        r.fulfill({ json: { off: [], hidden, released: ["reading-aloud"], shown: hidden.includes("reading-aloud") ? [] : ["reading-aloud"] } }),
      );
      if (route) await context.route(/\/api\/voice\/speak$/, route);
      await context.addInitScript(
        ({ s, phone }) => {
          localStorage.setItem("settings", s);
          if (phone) localStorage.setItem("viewport", "phone");
        },
        { s: seed(vimKeys), phone },
      );
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-reader")?.shadowRoot?.querySelector(".strip > h1"), undefined, { timeout: 4000, polling: 50 });
      return { context, page, problems };
    }

    // Browser: rendering and layout.
    test("hovering a paragraph shows the speaker in its margin; a click tints it, lights the word, and Stop ends it", async () => {
      const { context, page, problems } = await open();
      try {
        const reader = page.locator("book-reader");
        assert.deepEqual((await look(page)).foot, ["Read page"]);
        await reader.locator(".strip > p").first().hover();
        await until(async () => (await look(page)).read === 2);
        // The speaker sits in the page's left padding, beside the paragraph's first line.
        const [say, para] = await Promise.all([reader.locator(".say.read").boundingBox(), reader.locator(".strip > p").first().boundingBox()]);
        assert.ok(say.x + say.width <= para.x + 1 && say.x >= para.x - say.width - 1, `in the margin: ${JSON.stringify({ say, para })}`);
        assert.ok(Math.abs(say.y - para.y) < say.height, "on the first line");
        await reader.locator(".say.read").click();
        await until(async () => (await look(page)).word !== "");
        const reading = await look(page);
        assert.deepEqual(reading.foot, ["Pause", "Stop"]);
        assert.equal(reading.tinted, 2, "the paragraph being read is tinted");
        assert.equal(reading.stop, 2, "the margin shows Stop beside it");
        assert.equal(reading.read, null);
        await reader.locator(".say.stop").click();
        await until(async () => (await look(page)).foot[0] === "Read page");
        const after = await look(page);
        assert.equal(after.tinted, -1);
        assert.equal(after.word, "");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("a short block read from the margin stops at its end, by itself", async () => {
      const { context, page, problems } = await open();
      try {
        const reader = page.locator("book-reader");
        await reader.locator(".strip > h1").hover();
        await until(async () => (await look(page)).read === 0);
        await reader.locator(".say.read").click();
        await until(async () => (await look(page)).foot[0] === "Pause");
        // "Chapter One" lasts a third of a second in the test voice.
        await until(async () => (await look(page)).foot[0] === "Read page", 3000);
        assert.equal((await look(page)).tinted, -1);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("on the phone the footer's Read page reads the page, with Pause, Resume and Stop", async () => {
      const { context, page, problems } = await open({ phone: true });
      try {
        const reader = page.locator("book-reader");
        await reader.locator(".speak.page-read").click();
        await until(async () => (await look(page)).tinted === 0);
        await reader.locator(".speak.pause").click();
        await until(async () => (await look(page)).foot[0] === "Resume");
        await reader.locator(".speak.resume").click();
        await until(async () => (await look(page)).foot[0] === "Pause");
        // Reading goes on to the next block once the heading has been said.
        await until(async () => (await look(page)).tinted === 1, 3000);
        await reader.locator(".speak.stop").click();
        await until(async () => (await look(page)).foot[0] === "Read page");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys, r and R read from the cursor, Space pauses and resumes without turning, Escape stops", async () => {
      const { context, page, problems } = await open({ vimKeys: true });
      try {
        await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());
        await page.keyboard.press("j");
        await page.keyboard.press("j");
        await page.keyboard.press("r");
        await until(async () => (await look(page)).foot[0] === "Pause");
        const one = await look(page);
        assert.equal(one.tinted, 2, "r reads the paragraph holding the cursor");
        const pageno = one.pageno;
        await page.keyboard.press(" ");
        await until(async () => (await look(page)).foot[0] === "Resume");
        assert.equal((await look(page)).pageno, pageno, "Space did not turn the page");
        await page.keyboard.press(" ");
        await until(async () => (await look(page)).foot[0] === "Pause");
        await page.keyboard.press("Escape");
        await until(async () => (await look(page)).foot[0] === "Read page");
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        await page.keyboard.press("R");
        await until(async () => (await look(page)).tinted === 0);
        await page.keyboard.press("Escape");
        await until(async () => (await look(page)).foot[0] === "Read page");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("a voice that cannot read says what to do over the footer; a hidden feature shows nothing", async () => {
      const { context, page, problems } = await open({ route: (r) => r.fulfill({ json: { error: "no-key" } }) });
      try {
        await page.locator("book-reader .speak.page-read").click();
        await until(async () => (await look(page)).command === "Add your Inworld key in Settings");
        assert.deepEqual((await look(page)).foot, ["Read page"]);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
      const hidden = await open({ hidden: ["reading-aloud"] });
      try {
        await hidden.page.locator("book-reader .strip > p").first().hover();
        const seen = await look(hidden.page);
        assert.deepEqual(seen.foot, []);
        assert.equal(seen.read, null);
        assert.deepEqual(hidden.problems, []);
      } finally {
        await hidden.context.close();
      }
    });
  });
}
