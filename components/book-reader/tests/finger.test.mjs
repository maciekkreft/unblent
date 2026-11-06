import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// A finger's passage on a real page: the decisions are tested in Node (machine.test.mjs),
// here what a press, a hold and a drag do to what the user sees.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
const PLATE = resolve(HERE, "fixtures", "plate.epub");
// The subject stem page holds the reader with `highlights` and the notes fact.
const PAGE = `${BASE_URL}/workshop/design/subject`;
const BOOK_ID = "01K00000000000000000000SMP";
const PLATE_ID = "01K00000000000000000000PTE";
// Past the reader's hold time, so a hold it should have started has shown by then.
const PAST_HOLD_MS = 500;

const seedUser = async (id, file, position) => {
  const cookie = forgeCookie("reader-finger");
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${id}`, "application/epub+zip", readFileSync(file));
  await put(`/api/books/${id}/opened`, "application/json", "{}");
  await put(`/api/books/${id}/position`, "application/json", JSON.stringify(position));
  return cookie;
};

// What the reader paints for a finger, and the state of the page around it.
const painted = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".passage").dataset.text ?? "");
const boxes = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelectorAll(".passage i").length);
const marks = (page) => page.evaluate(() => [...document.querySelector("book-reader").shadowRoot.querySelectorAll(".strip mark")].map((m) => m.textContent).join(""));
const footer = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".footer").textContent.replace(/\s+/g, " ").trim());
const button = (page) => page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".bubble.make button.highlight")?.getBoundingClientRect().toJSON() ?? null);

// A finger, as pointer events on what lies under it: Playwright's touchscreen has only tap().
// Each move waits two frames, because the reader follows a finger once a frame.
const finger = (page) => {
  const send = (type, x, y) =>
    page.evaluate(([type, x, y]) => {
      const root = document.querySelector("book-reader").shadowRoot;
      window.__pressed ??= root.elementFromPoint(x, y) ?? root.querySelector(".viewport");
      window.__pressed.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, composed: true }));
      if (type === "pointerup") window.__pressed = null;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, [type, x, y]);
  return { down: (x, y) => send("pointerdown", x, y), move: (x, y) => send("pointermove", x, y), up: (x, y) => send("pointerup", x, y) };
};

// The lines of text on the page shown, each with the block it belongs to, top to bottom.
const lines = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("book-reader").shadowRoot;
    const vp = root.querySelector(".viewport").getBoundingClientRect();
    const out = [];
    [...root.querySelector(".strip").children].forEach((el, block) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) {
        if (r.left >= vp.left && r.right <= vp.right && r.height > 0 && r.top >= vp.top && r.bottom <= vp.bottom) out.push({ block, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
    });
    return out.sort((a, b) => a.top - b.top);
  });

for (const engine of ENGINES) {
  describe(`a finger's passage in ${engine.name}`, { timeout: 120000 }, () => {
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

    // A phone, on a page of Chapter Two that holds many paragraphs.
    const open = async ({ book = BOOK_ID, file = SAMPLE, position = { chapter: 1, block: 30 }, ready = "p", settings = null } = {}) => {
      const problems = [];
      context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, await seedUser(book, file, position));
      const page = await context.newPage();
      watch(page, problems);
      if (settings) await page.addInitScript((v) => localStorage.setItem("settings", v), settings);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((ready) => document.querySelector("book-reader")?.shadowRoot?.querySelector(`.strip ${ready}`), ready);
      await page.waitForFunction(() => /Page \d+ of \d+/.test(document.querySelector("book-reader").shadowRoot.querySelector(".footer").textContent) && document.querySelector("book-reader").shadowRoot.querySelector(".strip p:nth-child(2)"));
      return { page, problems, hand: finger(page) };
    };

    // The owner's report: on a line below the start the passage flipped to everything
    // above it. Every Y here is taken from the page's real lines, in a gap between two
    // lines of a paragraph, in a gap between two paragraphs and on the lines themselves.
    // Browser: a gesture.
    test(`a hold paints the word, and a drag down or up never flips, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const before = await footer(page);
      const all = await lines(page);
      const start = all[3];
      const x = (start.left + start.right) / 2;
      const y = (start.top + start.bottom) / 2;
      await hand.down(x, y);
      await until(async () => (await painted(page)) !== "");
      const word = await painted(page);
      assert.ok(!/\s/.test(word), `a hold paints one word, not "${word}"`);
      assert.equal(await boxes(page), 1, "the word is one box on one line");

      const below = all.slice(4, 16);
      let gapsInLine = 0;
      let gapsBetween = 0;
      let last = word;
      for (const [i, line] of below.entries()) {
        const prior = i === 0 ? start : below[i - 1];
        if (line.top > prior.bottom) {
          if (line.block === prior.block) gapsInLine += 1;
          else gapsBetween += 1;
          await hand.move(x, (line.top + prior.bottom) / 2);
          const inGap = await painted(page);
          assert.ok(inGap.startsWith(word), `in the gap above line ${i} the start moved: "${inGap.slice(0, 30)}"`);
          assert.ok(inGap.length >= last.length, `in the gap above line ${i} it shrank`);
          last = inGap;
        }
        await hand.move(x, (line.top + line.bottom) / 2);
        const on = await painted(page);
        assert.ok(on.startsWith(word), `on line ${i} the start moved: "${on.slice(0, 30)}"`);
        assert.ok(on.length > last.length, `on line ${i} it grew`);
        last = on;
      }
      assert.ok(gapsBetween > 0, "the drag crossed a gap between paragraphs");
      assert.ok(gapsInLine + gapsBetween > 0, "the drag crossed gaps");
      assert.ok((await boxes(page)) > 3, "each line has its box");

      // In the margin and past the end of the page it still names text.
      await hand.move(1, below.at(-1).bottom + 4);
      assert.ok((await painted(page)).startsWith(word), "a finger in the margin keeps the start");
      await hand.move(x, 100000);
      assert.ok((await painted(page)).startsWith(word), "a finger past the end keeps the start");

      // Back over the start, then above it: the same word now ends the passage.
      await hand.move(x, y);
      assert.equal(await painted(page), word, "dragging back shrinks it to the word");
      await hand.move(x, (all[1].top + all[1].bottom) / 2);
      const above = await painted(page);
      assert.ok(above.endsWith(word) && above.length > word.length, `above the start it runs back to the word: "${above.slice(-30)}"`);
      await hand.up(x, (all[1].top + all[1].bottom) / 2);
      assert.equal(await footer(page), before, "no page turned");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`lifting offers Highlight, which makes exactly what is painted, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page);
      const x = (all[3].left + all[3].right) / 2;
      await hand.down(x, all[3].top + 4);
      await until(async () => (await painted(page)) !== "");
      assert.equal(await button(page), null, "no button while the finger is down");
      await hand.move(x, all[8].top + 4);
      const held = await painted(page);
      await hand.up(x, all[8].top + 4);
      assert.equal(await painted(page), held, "lifting keeps what was painted");
      const at = await button(page);
      assert.ok(at, "the Highlight button shows");
      assert.ok(at.top >= all[8].bottom - 1, `the button (${at.top}) sits under the last line (${all[8].bottom})`);
      await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      await until(async () => (await marks(page)) !== "");
      const norm = (t) => t.replace(/\s+/g, " ").trim();
      assert.equal(norm(await marks(page)).replace(/ /g, ""), norm(held).replace(/ /g, ""), "the mark is what was painted");
      assert.equal(await button(page), null, "the button is gone");
      assert.equal(await boxes(page), 0, "the paint is gone");
      const selected = await page.evaluate(() => (document.getSelection()?.toString() ?? "") + (document.querySelector("book-reader").shadowRoot.getSelection?.()?.toString() ?? ""));
      assert.equal(selected, "", "nothing is left selected");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`a tap elsewhere or Escape drops a passage, and a new hold starts over, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const before = await footer(page);
      const all = await lines(page);
      const x = (all[3].left + all[3].right) / 2;
      const hold = async (line, at = x) => {
        await hand.down(at, line.top + 4);
        await until(async () => (await button(page)) == null && (await painted(page)) !== "");
      };
      await hold(all[3]);
      const first = await painted(page);
      await hand.up(x, all[3].top + 4);
      assert.ok(await button(page), "the button shows");
      // A tap in the outer third would turn; here it only takes the passage back.
      const edge = (all[3].right + all[3].left) * 0.92;
      await hand.down(edge, all[10].top + 4);
      await hand.up(edge, all[10].top + 4);
      assert.equal(await painted(page), "", "a tap elsewhere drops it");
      assert.equal(await button(page), null);
      assert.equal(await footer(page), before, "and turns no page");

      await hold(all[3]);
      await hand.up(x, all[3].top + 4);
      // The paragraphs repeat, so its own word is read at the line's start, not its middle.
      await hold(all[12], all[12].left + 2);
      assert.notEqual(await painted(page), first, "a new hold starts over at its own word");
      assert.equal(await boxes(page), 1);
      await hand.up(all[12].left + 2, all[12].top + 4);
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());
      await page.keyboard.press("Escape");
      assert.equal(await painted(page), "", "Escape drops it");
      assert.equal(await button(page), null);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`a quick swipe and a tap still turn, with no passage, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const before = await footer(page);
      const pageNo = () => footer(page).then((t) => Number(/Page (\d+)/.exec(t)[1]));
      const n = Number(/Page (\d+)/.exec(before)[1]);
      const all = await lines(page);
      const y = all[5].top + 4;
      await hand.down(300, y);
      for (const x of [280, 250, 220, 190]) await hand.move(x, y);
      await hand.up(190, y);
      await until(async () => (await pageNo()) === n + 1);
      await new Promise((r) => setTimeout(r, PAST_HOLD_MS));
      assert.equal(await painted(page), "", "a swipe starts no passage");
      await page.touchscreen.tap(370, 400);
      await until(async () => (await pageNo()) === n + 2);
      assert.equal(await painted(page), "", "a tap starts no passage");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`a hold on a picture does nothing and a tap opens it, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open({ book: PLATE_ID, file: PLATE, position: { chapter: 0, block: 0 }, ready: "img" });
      await page.waitForFunction(() => document.querySelector("book-reader").shadowRoot.querySelector(".strip img").complete);
      const img = await page.evaluate(() => {
        const r = document.querySelector("book-reader").shadowRoot.querySelector(".strip img").getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const viewer = () => page.evaluate(() => Boolean(document.querySelector("book-reader").shadowRoot.querySelector(".figure")));
      await hand.down(img.x, img.y);
      await new Promise((r) => setTimeout(r, PAST_HOLD_MS));
      assert.equal(await painted(page), "", "a hold paints nothing");
      await hand.up(img.x, img.y);
      assert.equal(await viewer(), false, "and opens nothing");
      await hand.down(img.x, img.y);
      await hand.up(img.x, img.y);
      await until(viewer);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // WebKit paints no ::highlight on text that cannot be selected, so a touch screen's
    // text starts no selection, except while a keyboard's passage needs that paint.
    // Browser: focus and keys.
    test(`a touch screen's text cannot be selected, but a keyboard's passage still paints, in ${engine.name}`, async () => {
      const seed = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });
      const { page, problems } = await open({ settings: seed });
      const selectable = () => page.evaluate(() => getComputedStyle(document.querySelector("book-reader").shadowRoot.querySelector(".strip")).webkitUserSelect);
      assert.equal(await selectable(), "none");
      await page.evaluate(() => document.querySelector("book-reader").shadowRoot.querySelector(".reader").focus());
      await until(async () => {
        await page.keyboard.press("v");
        if ((await page.evaluate(() => CSS.highlights.has("reader-pending"))) === true) return true;
        await page.keyboard.press("Escape");
        return false;
      });
      assert.equal(await selectable(), "text");
      await page.keyboard.press("Escape");
      assert.equal(await selectable(), "none");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });
  });
}
