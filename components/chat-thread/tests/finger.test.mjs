import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// A finger's passage on the drawn answers: the decisions are tested in Node
// (cursor-rules.test.mjs), here what a press, a hold and a drag do to what the user sees.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("F1");
const EARLIER = "An earlier answer holds these plain words so that one finger can mark a passage of them across two lines on a phone, and it runs on a little more so the lines are plenty and there is room to drag.";
const LAST = "The last answer says **something bold** first and then goes on for a good while, long enough to wrap across several lines on the narrow screen of a phone, which is where a passage over two lines has to work.";
const LONG = Array.from({ length: 40 }, (_, k) => `Paragraph ${k + 1} of an answer long enough to scroll with a finger.`).join("\n\n");
// Past the hold time, so a hold that should have started has shown by then.
const PAST_HOLD_MS = 500;
// Past the longest of iOS's own long presses (three quarters of a second).
const PAST_NATIVE_PRESS_MS = 1000;

const inThread = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("chat-thread").shadowRoot, arg), [fn.toString(), arg]);

const painted = (page) => inThread(page, (root) => root.querySelector(".passage").dataset.text ?? "");
const boxes = (page) => inThread(page, (root) => root.querySelectorAll(".passage i").length);
const button = (page) => inThread(page, (root) => {
  const b = root.querySelector(".make button");
  return b ? { text: b.textContent.trim(), ...b.getBoundingClientRect().toJSON() } : null;
});
const commentBox = (page) => inThread(page, (root) => root.querySelector(".popover textarea") != null);
const marked = (page) => inThread(page, (root) => [...root.querySelectorAll("mark")].map((m) => m.textContent).join(""));

// A finger, as pointer events on what lies under it: Playwright's touchscreen has only tap().
// Each move waits two frames, because the thread follows a finger once a frame.
const finger = (page) => {
  const send = (type, x, y) =>
    page.evaluate(([type, x, y]) => {
      const root = document.querySelector("chat-thread").shadowRoot;
      window.__pressed ??= root.elementFromPoint(x, y) ?? root.querySelector(".transcript");
      window.__pressed.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, composed: true }));
      if (type === "pointerup" || type === "pointercancel") window.__pressed = null;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, [type, x, y]);
  return { down: (x, y) => send("pointerdown", x, y), move: (x, y) => send("pointermove", x, y), up: (x, y) => send("pointerup", x, y), cancel: (x, y) => send("pointercancel", x, y) };
};

// A plain event, because an engine without a touch screen may have no TouchEvent to construct.
const refused = (page, type, selector) =>
  inThread(page, (root, [type, selector]) => {
    const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
    root.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  }, [type, selector]);

// The lines of an answer on screen, top to bottom, read from the drawn text.
const lines = (page, id) =>
  inThread(page, (root, id) => {
    const range = document.createRange();
    const out = [];
    for (const span of root.querySelectorAll(`[data-answer="${id}"] [data-s]`)) {
      range.selectNodeContents(span);
      for (const r of range.getClientRects()) {
        if (r.height > 0 && r.width > 0 && !out.some((o) => Math.abs(o.top - r.top) < r.height / 2)) out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
    }
    return out.sort((a, b) => a.top - b.top);
  }, id);

for (const engine of ENGINES) {
  describe(`a finger on an answer in ${engine.name}`, { timeout: 120000 }, () => {
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

    // A phone, on a chat with two finished answers, the second the last.
    const open = async ({ earlier = EARLIER, last = LAST, highlights = [] } = {}) => {
      context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("chat-finger"));
      assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok());
      const chat = {
        title: "Hold me",
        about: [],
        start: "",
        turns: [
          { id: U("Q1"), role: "user", text: "Hold me" },
          { id: U("A1"), role: "assistant", text: earlier, status: "done" },
          { id: U("Q2"), role: "user", text: "And then?" },
          { id: U("A2"), role: "assistant", text: last, status: "done" },
        ],
        highlights,
      };
      assert.ok((await context.request.put(`${BASE_URL}/api/conversations/${CHAT}`, { data: chat })).ok(), "the chat is seeded");
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
      await page.locator("conversation-list .row", { hasText: "Hold me" }).click();
      await until(() => inThread(page, (root) => Boolean(root.querySelector(".answer.markable [data-s]"))));
      return { page, problems, hand: finger(page) };
    };

    // The owner's complaint: a passage across two lines. On the last answer it offers
    // Comment, under its last line, and the comment holds exactly what was painted.
    // Browser: a gesture.
    test(`a hold and a drag over two lines of the last answer offer Comment, for exactly what is painted, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page, U("A2"));
      assert.ok(all.length >= 3, "the answer wraps");
      await hand.down(all[0].x, all[0].y);
      await until(async () => (await painted(page)) !== "");
      const word = await painted(page);
      assert.ok(!/\s/.test(word), `a hold paints one word, not "${word}"`);
      assert.equal(await boxes(page), 1);
      assert.equal(await button(page), null, "no button while the finger is down");
      await hand.move(all[2].x, all[2].y);
      const held = await painted(page);
      assert.ok(held.startsWith(word) && held.length > word.length, `it grows from the word: "${held}"`);
      assert.equal(await boxes(page), 3, "each line has its box");
      // The gap between two lines and a move back keep the start.
      await hand.move(all[1].x, (all[0].bottom + all[1].top) / 2);
      assert.ok((await painted(page)).startsWith(word), "the start stays fixed");
      await hand.move(all[2].x, all[2].y);
      await hand.up(all[2].x, all[2].y);
      assert.equal(await painted(page), held, "lifting keeps what was painted");
      const at = await button(page);
      assert.equal(at?.text, "Comment");
      assert.ok(at.top >= all[2].bottom - 1, `the button (${at.top}) sits under the last line (${all[2].bottom})`);
      await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      await until(() => commentBox(page));
      assert.equal(await boxes(page), 0, "the paint is gone");
      assert.equal(await button(page), null, "the button is gone");
      const norm = (t) => t.replace(/\s+/g, "");
      assert.equal(norm(await marked(page)), norm(held), "the mark is what was painted");
      assert.ok(await inThread(page, (root) => root.activeElement?.localName === "textarea"), "the box takes the keys");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`on an earlier answer the button is Highlight, and a passage never leaves its answer, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page, U("A1"));
      const below = await lines(page, U("A2"));
      await hand.down(all[0].x, all[0].y);
      await until(async () => (await painted(page)) !== "");
      await hand.move(below[1].x, below[1].y);
      const held = await painted(page);
      assert.ok(held.endsWith("drag."), `a finger over the next answer stops at this one's end: "${held.slice(-20)}"`);
      await hand.up(below[1].x, below[1].y);
      const at = await button(page);
      assert.equal(at?.text, "Highlight");
      await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      await until(async () => (await marked(page)) !== "");
      assert.equal(await commentBox(page), false, "no comment box");
      assert.equal((await marked(page)).replace(/\s+/g, ""), held.replace(/\s+/g, ""));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`a pause changes nothing until the lift, and a touch the system ends counts as a lift, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page, U("A2"));
      await hand.down(all[0].x, all[0].y);
      await until(async () => (await painted(page)) !== "");
      await hand.move(all[1].x, all[1].y);
      const paused = await painted(page);
      await new Promise((r) => setTimeout(r, PAST_NATIVE_PRESS_MS));
      assert.equal(await button(page), null, "no button during the pause");
      assert.equal(await painted(page), paused, "the pause keeps what was painted");
      await hand.move(all[2].x, all[2].y);
      const grown = await painted(page);
      assert.ok(grown.startsWith(paused) && grown.length > paused.length, "the passage goes on after the pause");
      await hand.cancel(all[2].x, all[2].y);
      assert.equal(await painted(page), grown, "the cancelled touch keeps what was painted");
      assert.equal((await button(page))?.text, "Comment");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // The conversation scrolls with a finger, which a refused touchstart would stop, and
    // once a hold has started the moves are refused, which a scroll in progress cannot be.
    // Browser: a gesture.
    test(`a touch on an answer is never refused until a hold has started, and a quick drag starts no passage, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open({ last: LONG });
      assert.equal(await refused(page, "touchstart", "[data-answer] [data-s]"), false, "a touchstart on the text");
      assert.equal(await refused(page, "touchmove", "[data-answer] [data-s]"), false, "a touchmove before a hold");
      assert.notEqual(await inThread(page, (root) => getComputedStyle(root.querySelector(".transcript")).touchAction), "none");
      await inThread(page, (root) => {
        root.querySelector(".transcript").scrollTop = 0;
      });
      const all = await lines(page, U("A1"));
      await hand.down(all[0].x, all[0].y);
      await hand.move(all[0].x, all[0].y - 30);
      await new Promise((r) => setTimeout(r, PAST_HOLD_MS));
      assert.equal(await painted(page), "", "a finger that moved starts no passage");
      await hand.cancel(all[0].x, all[0].y - 30);
      // The browser takes a scroll with a pointercancel, also before the finger moved far.
      await hand.down(all[0].x, all[0].y);
      await hand.cancel(all[0].x, all[0].y);
      await new Promise((r) => setTimeout(r, PAST_HOLD_MS));
      assert.equal(await painted(page), "", "a scroll the browser took starts no passage");
      await hand.down(all[0].x, all[0].y);
      await until(async () => (await painted(page)) !== "");
      assert.equal(await refused(page, "touchmove", "[data-answer] [data-s]"), true, "a touchmove once a hold has started");
      await hand.up(all[0].x, all[0].y);
      await until(() => button(page));
      assert.ok((await inThread(page, (root) => root.querySelector(".transcript").scrollTop)) < 100, "the button shows where the reader is, not at the chat's end");
      assert.equal(await refused(page, "touchmove", "[data-answer] [data-s]"), false, "a touchmove after the lift scrolls again");
      assert.equal(await refused(page, "touchstart", ".make button"), false, "the button");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`a tap elsewhere or on the chat box drops a passage, doing nothing else, and a new hold starts over, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      const all = await lines(page, U("A2"));
      const hold = async (line) => {
        await hand.down(line.x, line.y);
        await until(async () => (await painted(page)) !== "");
        await hand.up(line.x, line.y);
        assert.ok(await button(page), "the button shows");
      };
      await hold(all[0]);
      const first = await painted(page);
      await hand.down(all[2].x, all[2].y);
      await hand.up(all[2].x, all[2].y);
      assert.equal(await painted(page), "", "a tap on the text drops it");
      assert.equal(await button(page), null);
      assert.equal(await commentBox(page), false);
      await hold(all[0]);
      await hand.down(all[2].left + 2, all[2].y);
      await until(async () => (await painted(page)) !== first);
      assert.equal(await boxes(page), 1, "a new hold starts over at its own word");
      await hand.up(all[2].left + 2, all[2].y);
      await page.locator("chat-input").evaluate((el) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "touch" })));
      assert.equal(await painted(page), "", "a press on the chat box drops it");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // A held mark can become nothing more; the tap on one still opens it, as a click does.
    // Browser: a gesture.
    test(`a hold on a highlight offers nothing and a tap on it opens its bubble, in ${engine.name}`, async () => {
      const quote = "An earlier answer";
      const { page, problems, hand } = await open({ highlights: [{ id: U("H1"), answerId: U("A1"), start: 0, end: quote.length, quote }] });
      await until(async () => (await marked(page)) === quote);
      const at = await inThread(page, (root) => {
        const r = root.querySelector("mark.hl").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await hand.down(at.x, at.y);
      await until(async () => (await painted(page)) !== "");
      await hand.up(at.x, at.y);
      assert.equal(await button(page), null, "no button");
      assert.equal(await painted(page), "", "and the passage goes");
      await hand.down(at.x, at.y);
      await hand.up(at.x, at.y);
      await until(() => inThread(page, (root) => root.querySelector(".bubble:not(.make)")?.textContent.includes("Remove highlight")));
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // WebKit paints no ::highlight on text that cannot be selected; a finger's passage needs
    // none, and the browser's own selection must not start on an answer.
    // Browser: rendering and layout.
    test(`a touch screen selects no answer, but the user's own message still can, in ${engine.name}`, async () => {
      const { page, problems } = await open();
      const style = (selector) => inThread(page, (root, selector) => getComputedStyle(root.querySelector(selector)).webkitUserSelect, selector);
      assert.equal(await style("[data-answer]"), "none");
      assert.notEqual(await style(".turn.user"), "none");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });
  });
}
