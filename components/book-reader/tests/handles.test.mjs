import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// A highlight's handles and its comment box on a real page: the decisions are tested in Node
// (machine.test.mjs), here what a press and a drag on a handle do to what the user sees.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
const PAGE = `${BASE_URL}/workshop/design/subject`;
const BOOK_ID = "01K00000000000000000000SMP";
// Past the longest of iOS's own long presses (three quarters of a second).
const PAST_NATIVE_PRESS_MS = 1000;

// A lift saves a highlight now, and another test's would come back with the pull, so each
// test has its own account.
let accounts = 0;
const seed = async () => {
  accounts += 1;
  const cookie = forgeCookie(`reader-handles-${accounts}`);
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK_ID}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/books/${BOOK_ID}/opened`, "application/json", "{}");
  await put(`/api/books/${BOOK_ID}/position`, "application/json", JSON.stringify({ chapter: 1, block: 30 }));
  return cookie;
};

const inReader = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("book-reader").shadowRoot, arg), [fn.toString(), arg]);
const marks = (page) => inReader(page, (root) => [...root.querySelectorAll(".strip mark")].map((m) => m.textContent).join(""));
const markIds = (page) => inReader(page, (root) => [...new Set([...root.querySelectorAll(".strip mark")].map((m) => m.dataset.id))]);
const painted = (page) => inReader(page, (root) => root.querySelector(".passage").dataset.text ?? "");
const bubbled = (page) => inReader(page, (root) => root.querySelector(".bubble") != null);
const handle = (page, end) =>
  inReader(page, (root, end) => {
    const el = root.querySelector(`.handle.${end}`);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, touchAction: getComputedStyle(el).touchAction };
  }, end);
const footer = (page) => inReader(page, (root) => root.querySelector(".footer").textContent.replace(/\s+/g, " ").trim());
const lines = (page) =>
  inReader(page, (root) => {
    const vp = root.querySelector(".viewport").getBoundingClientRect();
    const out = [];
    [...root.querySelector(".strip").children].forEach((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) {
        if (r.left >= vp.left && r.right <= vp.right && r.height > 0 && r.top >= vp.top && r.bottom <= vp.bottom) out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
    });
    return out.sort((a, b) => a.top - b.top);
  });

// A finger, as pointer events on what lies under it: Playwright's touchscreen has only tap().
// Each move waits two frames, because the reader follows a finger once a frame.
const finger = (page) => {
  const send = (type, x, y) =>
    page.evaluate(([type, x, y]) => {
      const root = document.querySelector("book-reader").shadowRoot;
      window.__pressed ??= root.elementFromPoint(x, y) ?? root.querySelector(".viewport");
      window.__pressed.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, composed: true }));
      if (type === "pointerup" || type === "pointercancel") window.__pressed = null;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, [type, x, y]);
  return { down: (x, y) => send("pointerdown", x, y), move: (x, y) => send("pointermove", x, y), up: (x, y) => send("pointerup", x, y), cancel: (x, y) => send("pointercancel", x, y) };
};

for (const engine of ENGINES) {
  describe(`a highlight's handles in ${engine.name}`, { timeout: 120000 }, () => {
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

    const open = async ({ phone = true } = {}) => {
      context = await browser.newContext(phone ? { hasTouch: true, viewport: { width: 390, height: 844 } } : { viewport: { width: 1100, height: 800 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, await seed());
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => /Page \d+ of \d+/.test(document.querySelector("book-reader")?.shadowRoot?.querySelector(".footer")?.textContent ?? "") && document.querySelector("book-reader").shadowRoot.querySelector(".strip p:nth-child(2)"));
      return { page, problems, hand: finger(page) };
    };

    // A highlight made with a finger on a line, its handles up.
    const made = async (page, hand, line) => {
      const x = (line.left + line.right) / 2;
      await hand.down(x, line.top + 4);
      await until(async () => (await painted(page)) !== "");
      await hand.up(x, line.top + 4);
      await until(async () => (await handle(page, "end")) != null);
    };

    // The owner's report: iOS ends a touch whose finger rests. Here the reader must not care.
    // Browser: a gesture.
    test(`a handle dragged with a pause moves that end, as one change to the same highlight, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page);
      const before = await footer(page);
      await made(page, hand, all[3]);
      const word = await marks(page);
      const [id] = await markIds(page);
      const end = await handle(page, "end");
      assert.ok(end.width >= 40 && end.height >= 40, `big enough for a finger: ${end.width}x${end.height}`);
      assert.equal(end.touchAction, "none");
      await hand.down(end.x, end.y);
      assert.ok(await bubbled(page), "the press does not close the bubble");
      await hand.move(end.x, end.y + (all[5].top - all[3].top));
      const held = await painted(page);
      assert.ok(held.startsWith(word) && held.length > word.length, `it grows from the word: "${held.slice(0, 30)}"`);
      await new Promise((r) => setTimeout(r, PAST_NATIVE_PRESS_MS));
      assert.equal(await painted(page), held, "a pause changes nothing");
      await hand.move(end.x, end.y + (all[7].top - all[3].top));
      const grown = await painted(page);
      assert.ok(grown.length > held.length, "the drag goes on after the pause");
      const moved = await handle(page, "end");
      await hand.up(moved.x, moved.y);
      await until(async () => (await marks(page)).replace(/\s/g, "") === grown.replace(/\s/g, ""));
      assert.equal(await painted(page), "", "the mark takes over from the drag's boxes");
      assert.deepEqual(await markIds(page), [id], "the same highlight");
      assert.ok(await bubbled(page), "its bubble is still open");
      assert.equal(await footer(page), before, "no page turned");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`the ends cannot cross, and a cancelled touch keeps what was dragged, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page);
      await made(page, hand, all[5]);
      const end = await handle(page, "end");
      await hand.down(end.x, end.y);
      await hand.move(all[0].left, all[0].top);
      assert.equal((await painted(page)).length, 1, "the end stops on the start's letter");
      await hand.move(end.x, end.y + (all[6].top - all[5].top));
      const kept = await painted(page);
      assert.ok(kept.length > 1, "and comes back");
      await hand.cancel(end.x, end.y);
      await until(async () => (await marks(page)).replace(/\s/g, "") === kept.replace(/\s/g, ""));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`a mouse drags a handle, and its selection becomes a highlight with the handles up, in ${engine.name}`, async () => {
      const { page, problems } = await open({ phone: false });
      const all = await lines(page);
      const y = (all[3].top + all[3].bottom) / 2;
      await page.mouse.move(all[3].left + 40, y);
      await page.mouse.down();
      await page.mouse.move(all[3].left + 120, y, { steps: 4 });
      await page.mouse.up();
      await until(async () => (await handle(page, "end")) != null);
      const before = await marks(page);
      const end = await handle(page, "end");
      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(end.x + 60, end.y, { steps: 4 });
      await page.mouse.up();
      await until(async () => (await marks(page)).length > before.length);
      assert.ok(await bubbled(page), "the bubble stays");
      const selected = await page.evaluate(() => (document.getSelection()?.toString() ?? "") + (document.querySelector("book-reader").shadowRoot.getSelection?.()?.toString() ?? ""));
      assert.equal(selected, "", "the drag selected nothing");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`the bubble clears the handles, and fades during a drag, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page);
      await made(page, hand, all[5]);
      const seen = await inReader(page, (root) => {
        const b = root.querySelector(".bubble").getBoundingClientRect();
        const ball = (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left + r.width / 2 - 6, right: r.left + r.width / 2 + 6, top: el.classList.contains("start") ? r.bottom - parseFloat(el.style.getPropertyValue("--hh")) - 6 : r.top + parseFloat(el.style.getPropertyValue("--hh")) - 6 };
        };
        const clear = (el) => {
          const c = ball(el);
          return c.right <= b.left || c.left >= b.right || c.top + 12 <= b.top || c.top >= b.bottom;
        };
        return { start: clear(root.querySelector(".handle.start")), end: clear(root.querySelector(".handle.end")), comment: root.querySelector(".bubble .comment") != null };
      });
      assert.deepEqual(seen, { start: true, end: true, comment: true });
      const end = await handle(page, "end");
      await hand.down(end.x, end.y);
      const during = await inReader(page, (root) => getComputedStyle(root.querySelector(".bubble")).opacity);
      assert.equal(during, "0");
      await hand.up(end.x, end.y);
      await until(async () => (await inReader(page, (root) => getComputedStyle(root.querySelector(".bubble")).opacity)) === "1");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
    test(`the comment box takes letters as text, and writing in it adds the comment; left empty it adds nothing, in ${engine.name}`, async () => {
      const { page, problems } = await open({ phone: false });
      const all = await lines(page);
      const y = (all[3].top + all[3].bottom) / 2;
      await page.mouse.move(all[3].left + 40, y);
      await page.mouse.down();
      await page.mouse.move(all[3].left + 120, y, { steps: 4 });
      await page.mouse.up();
      await until(() => bubbled(page));
      const before = await footer(page);
      const line = () => inReader(page, (root) => getComputedStyle(root.querySelector(".strip mark")).boxShadow);
      const bare = await line();
      await page.locator("book-reader .bubble .comment").click();
      await page.locator("book-reader .bubble textarea").waitFor();
      await until(() => inReader(page, (root) => root.activeElement?.localName === "textarea"));
      await page.keyboard.press("Escape");
      await until(() => inReader(page, (root) => root.activeElement?.classList.contains("comment") === true));
      assert.equal(await line(), bare, "left empty, the highlight is as it was");
      await page.locator("book-reader .bubble .comment").click();
      await until(() => inReader(page, (root) => root.activeElement?.localName === "textarea"));
      await page.keyboard.type("Felt calm jk ");
      assert.equal(await footer(page), before, "the letters turned no page");
      await page.keyboard.press("Escape");
      await until(async () => (await line()) !== bare);
      await page.keyboard.press("Escape");
      await until(async () => !(await bubbled(page)));
      await until(() => inReader(page, (root) => root.activeElement?.classList.contains("reader") === true));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });
  });
}
