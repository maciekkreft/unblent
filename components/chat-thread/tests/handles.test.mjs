import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// A passage's handles on the drawn answers: the decisions are tested in Node
// (machine.test.mjs, cursor-rules.test.mjs), here what a press and a drag on a handle do to
// what the user sees.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("F2");
const EARLIER = "An earlier answer holds these plain words so that one finger can mark a passage of them across two lines on a phone, and it runs on a little more so the lines are plenty and there is room to drag.";
const LAST = "The last answer says **something bold** first and then goes on for a good while, long enough to wrap across several lines on the narrow screen of a phone, which is where a passage over two lines has to work.";
const QUOTE = "An earlier";
const HELD = "The last";
// Past the longest of iOS's own long presses (three quarters of a second).
const PAST_NATIVE_PRESS_MS = 1000;

const inThread = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("chat-thread").shadowRoot, arg), [fn.toString(), arg]);

const painted = (page) => inThread(page, (root) => root.querySelector(".passage").dataset.text ?? "");
const marked = (page) => inThread(page, (root) => [...root.querySelectorAll("mark")].map((m) => m.textContent).join("|"));
const box = (page) => inThread(page, (root) => root.querySelector(".popover:not(.bubble) textarea") != null);
const bubble = (page) => inThread(page, (root) => root.querySelector(".bubble") != null);
const handle = (page, end) =>
  inThread(page, (root, end) => {
    const el = root.querySelector(`.handle.${end}`);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, big: r.width >= 40 && r.height >= 40, touchAction: getComputedStyle(el).touchAction };
  }, end);
const stored = async (context) => (await context.request.get(`${BASE_URL}/api/conversations/${CHAT}`)).json();

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
  return { down: (x, y) => send("pointerdown", x, y), move: (x, y) => send("pointermove", x, y), up: (x, y) => send("pointerup", x, y) };
};

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

// A comment stays with the chat on the account, so each test has its own account.
let accounts = 0;

for (const engine of ENGINES) {
  describe(`a passage's handles in ${engine.name}`, { timeout: 120000 }, () => {
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

    const open = async ({ phone = true, marks = null } = {}) => {
      accounts += 1;
      context = await browser.newContext(phone ? { hasTouch: true, viewport: { width: 390, height: 844 } } : { viewport: { width: 1100, height: 800 } });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie(`chat-handles-${accounts}`));
      assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok());
      const chat = {
        title: "Handle me",
        about: [],
        start: "",
        turns: [
          { id: U("Q1"), role: "user", text: "Hold me" },
          { id: U("A1"), role: "assistant", text: EARLIER, status: "done" },
          { id: U("Q2"), role: "user", text: "And then?", ...(marks ? { marks } : {}) },
          { id: U("A2"), role: "assistant", text: LAST, status: "done" },
        ],
        highlights: [{ id: U("H1"), answerId: U("A1"), start: 0, end: QUOTE.length, quote: QUOTE }, { id: U("H2"), answerId: U("A2"), start: 0, end: HELD.length, quote: HELD }],
      };
      assert.ok((await context.request.put(`${BASE_URL}/api/conversations/${CHAT}`, { data: chat })).ok(), "the chat is seeded");
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
      await page.locator("conversation-list .row", { hasText: "Handle me" }).click();
      await until(() => inThread(page, (root) => root.querySelectorAll("mark.hl").length === 2));
      return { page, problems, hand: finger(page) };
    };

    const tapMark = async (page, hand, n) => {
      const at = await inThread(page, (root, n) => {
        const r = root.querySelectorAll("mark.hl")[n].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, n);
      await hand.down(at.x, at.y);
      await hand.up(at.x, at.y);
      await until(async () => (await handle(page, "end")) != null);
    };

    // The owner's report: iOS ends a touch whose finger rests, and a handle is what survives it.
    // Browser: a gesture.
    test(`on the last answer a handle dragged with a pause moves that end of the highlight, its box open, in ${engine.name}`, async () => {
      const { page, problems, hand } = await open();
      await tapMark(page, hand, 1);
      assert.ok(await box(page), "the box is on offer");
      const end = await handle(page, "end");
      assert.ok(end.big, "big enough for a finger");
      assert.equal(end.touchAction, "none");
      const all = await lines(page, U("A2"));
      await hand.down(end.x, end.y);
      assert.ok(await box(page), "the press does not close the box");
      assert.equal(await inThread(page, (root) => getComputedStyle(root.querySelector(".popover")).opacity), "0", "it fades during the drag");
      await hand.move(end.x, end.y + (all[1].top - all[0].top));
      const held = await painted(page);
      assert.ok(held.startsWith(HELD) && held.length > HELD.length, `it grows: "${held}"`);
      await new Promise((r) => setTimeout(r, PAST_NATIVE_PRESS_MS));
      assert.equal(await painted(page), held, "a pause changes nothing");
      await hand.up(end.x, end.y + (all[1].top - all[0].top));
      await until(async () => (await painted(page)) === "");
      const now = await inThread(page, (root, id) => [...root.querySelectorAll(`mark[data-id="${id}"]`)].map((m) => m.textContent).join(""), U("H2"));
      assert.equal(now.replace(/\s/g, ""), held.replace(/\s/g, ""));
      assert.ok(await box(page), "the box stays");
      await until(async () => (await stored(context)).highlights?.find((h) => h.id === U("H2"))?.quote.length > HELD.length);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`on an earlier answer a mouse drags a handle, the ends cannot cross, and a finger's box stays out of the way, in ${engine.name}`, async () => {
      const { page, problems } = await open({ phone: false });
      await page.locator("chat-thread mark.hl").first().click();
      await until(() => bubble(page));
      assert.equal(await inThread(page, (root) => root.querySelector(".popover textarea")), null, "an earlier answer has no comment box");
      const end = await handle(page, "end");
      const start = await handle(page, "start");
      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 200, start.y, { steps: 4 });
      await until(async () => (await painted(page)).length === 1);
      await page.mouse.move(end.x + 80, end.y, { steps: 4 });
      await page.mouse.up();
      await until(async () => (await marked(page)).split("|")[0].length > QUOTE.length);
      assert.ok(await bubble(page), "the bubble stays");
      assert.equal(await inThread(page, (root) => root.getSelection?.()?.toString() ?? ""), "", "the drag selected nothing");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: a gesture.
    test(`writing in the box turns the highlight into the numbered comment, whose handles still move it, and a sent comment has none, in ${engine.name}`, async () => {
      const sent = { id: U("M1"), start: EARLIER.indexOf("plain"), end: EARLIER.indexOf("plain") + 5, quote: "plain", comment: "why?" };
      const { page, problems } = await open({ phone: false, marks: [sent] });
      await until(() => inThread(page, (root) => root.querySelector("sup.num") != null));
      await page.locator(`chat-thread mark[data-id="${sent.id}"]`).click();
      assert.equal(await handle(page, "end"), null, "a comment already sent is read only");
      await page.locator(`chat-thread mark[data-id="${U("H2")}"]`).click();
      await until(() => box(page));
      await until(() => inThread(page, (root) => root.activeElement?.localName === "textarea"));
      await page.keyboard.type("Say why.");
      await until(async () => (await stored(context)).marks?.marks?.[0]?.comment === "Say why.");
      await until(async () => !(await stored(context)).highlights?.some((h) => h.id === U("H2")));
      assert.equal(await inThread(page, (root) => root.querySelector(".markable sup.num")?.textContent), "1");
      const end = await handle(page, "end");
      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(end.x + 40, end.y, { steps: 3 });
      await page.mouse.up();
      await until(async () => (await stored(context)).marks?.marks?.[0]?.quote.length > HELD.length);
      assert.equal((await stored(context)).marks.marks[0].comment, "Say why.", "the comment stays");
      assert.ok(await inThread(page, (root) => root.activeElement?.localName === "textarea"), "the box keeps the keys");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });
  });
}
