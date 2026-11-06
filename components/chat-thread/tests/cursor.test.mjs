import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// The Vim cursor on the drawn answers: where each motion lands on plain text is tested in
// Node (cursor-rules.test.mjs), here that the box sits on its letter, the view follows it, and
// the keys reach the chat through the keyboard.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference seeded the way the settings fact stores it (the workshop copy,
// since the page is under /workshop/).
const SETTINGS = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("V1");
const FIRST = "First answer with **bold words** inside. A second sentence here.\n\nAnother paragraph follows.";
const LAST = "Last answer begins.\n\nIt ends here.";
const LONG = Array.from({ length: 40 }, (_, k) => `Row ${k + 1}`).join("\n\n");

const inThread = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("chat-thread").shadowRoot, arg), [fn.toString(), arg]);

// What the user sees of the cursor: its letter, the answer it is in, the word it starts, and
// whether its box covers the letter drawn at that place; and the scroll.
const look = (page) =>
  inThread(page, (root) => {
    const el = root.querySelector(".transcript");
    const cursor = root.querySelector(".cursor");
    const out = { top: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight, height: el.clientHeight, shown: !cursor.hidden, letter: cursor.textContent, answer: cursor.dataset.answer ?? null, s: Number(cursor.dataset.s), passage: root.querySelector(".passage").dataset.text ?? "", onConversation: root.activeElement === el, box: Boolean(root.querySelector(".popover textarea")), marked: [...root.querySelectorAll("mark.hl")].map((m) => m.textContent).join("|") };
    if (!cursor.hidden) {
      const c = cursor.getBoundingClientRect();
      const v = el.getBoundingClientRect();
      out.inView = c.bottom > v.top && c.top < v.bottom;
      const span = [...root.querySelectorAll(`[data-answer="${out.answer}"] [data-s]`)].find((x) => Number(x.dataset.s) <= out.s && out.s < Number(x.dataset.s) + x.textContent.length);
      const r = document.createRange();
      const node = [...span.childNodes].find((n) => n.nodeType === 3);
      r.setStart(node, out.s - Number(span.dataset.s));
      r.setEnd(node, out.s - Number(span.dataset.s) + 1);
      const l = r.getBoundingClientRect();
      out.onLetter = Math.abs(l.left - c.left) < 1 && Math.abs(l.top - c.top) < 1 && r.toString() === cursor.textContent;
    }
    return out;
  });

// The source text from the cursor on, so a test reads where it stands.
const wordAt = (s, text) => text.slice(s).split(/\s/)[0];

for (const engine of ENGINES) {
  describe(`the conversation's cursor in ${engine.name}`, { timeout: 120000 }, () => {
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

    // The keyboard on the conversation of a chat with two finished answers, the first answer
    // in view at the first key.
    const open = async ({ first = FIRST, last = LAST, highlights = [], viewport = { width: 1000, height: 700 }, phone = false } = {}) => {
      context = await browser.newContext({ viewport });
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("chat-cursor"));
      assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok());
      const chat = {
        title: "Walk me",
        about: [],
        start: "",
        turns: [
          { id: U("Q1"), role: "user", text: "Walk me" },
          { id: U("A1"), role: "assistant", text: first, status: "done" },
          { id: U("Q2"), role: "user", text: "And then?" },
          { id: U("A2"), role: "assistant", text: last, status: "done" },
        ],
        highlights,
      };
      assert.ok((await context.request.put(`${BASE_URL}/api/conversations/${CHAT}`, { data: chat })).ok(), "the chat is seeded");
      await context.addInitScript((v) => localStorage.setItem("settings", v), SETTINGS);
      if (phone) await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
      await page.locator("conversation-list .row", { hasText: "Walk me" }).click();
      await until(() => inThread(page, (root) => Boolean(root.querySelector(".answer.markable [data-s]"))));
      await page.locator("chat-input .cm-content").click();
      await until(() => page.evaluate(() => Boolean(document.querySelector("chat-input").shadowRoot.querySelector(".cm-content").cmView.rootView.view.cm)));
      await page.keyboard.press("Escape");
      await until(async () => (await look(page)).onConversation);
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await until(async () => (await look(page)).s === 0);
      return { page, problems };
    };
    const press = async (page, ...keys) => {
      for (const key of keys) await page.keyboard.press(key);
      return look(page);
    };

    // Browser: rendering and layout.
    test(`a box sits on its letter while the conversation holds the keyboard, and i and back keep it, in ${engine.name}`, async () => {
      const { page, problems } = await open();
      let seen = await look(page);
      assert.equal(seen.shown, true);
      assert.equal(seen.letter, "F");
      assert.equal(seen.answer, U("A1"));
      assert.equal(seen.onLetter, true, "the box covers its letter");
      seen = await press(page, "w", "w", "w");
      assert.equal(seen.letter, "b", "into the bold word");
      assert.equal(seen.onLetter, true, "also on a bold letter");
      const colors = await inThread(page, (root) => {
        const s = getComputedStyle(root.querySelector(".cursor"));
        return { weight: Number(s.fontWeight), bg: s.backgroundColor };
      });
      assert.ok(colors.weight >= 600, "the box carries the letter in its own type");
      assert.notEqual(colors.bg, "rgba(0, 0, 0, 0)", "the box is painted");
      await page.keyboard.press("i");
      await until(async () => !(await look(page)).shown);
      assert.equal((await look(page)).letter, "", "no letter stays behind");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await until(async () => (await look(page)).onConversation);
      seen = await look(page);
      assert.equal(seen.letter, "b", "the cursor comes back where it was");
      assert.equal(seen.onLetter, true);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
    test(`w b ) ( } { 0 $ l h each move and come back, and cross answers, in ${engine.name}`, async () => {
      const { page, problems } = await open();
      const word = (seen) => wordAt(seen.s, seen.answer === U("A1") ? FIRST : LAST);
      assert.equal(word(await press(page, "w")), "answer");
      assert.equal(word(await press(page, "b")), "First");
      assert.equal(word(await press(page, "b")), "First", "stays at the first word");
      assert.equal(word(await press(page, ")")), "A");
      assert.equal(word(await press(page, "(")), "First");
      let seen = await press(page, "}");
      assert.equal(FIRST[seen.s], ".", "the paragraph's last letter");
      assert.equal(word(await press(page, "{")), "First");
      assert.equal(word(await press(page, "l")), "irst");
      assert.equal(word(await press(page, "h")), "First");
      assert.equal(word(await press(page, "h")), "First", "stays at the first letter");
      seen = await press(page, "$");
      assert.equal(seen.onLetter, true);
      assert.notEqual(seen.s, 0, "the line's end");
      assert.equal((await press(page, "0")).s, 0, "and back to its start");
      // Into the last answer, skipping the question between, and back.
      seen = await press(page, "}", "w");
      assert.equal(word(seen), "Another");
      seen = await press(page, "}", "w");
      assert.equal(seen.answer, U("A2"));
      assert.equal(word(seen), "Last");
      seen = await press(page, "b");
      assert.equal(seen.answer, U("A1"));
      assert.equal(word(seen), "follows.");
      seen = await press(page, "w", "}", "w");
      assert.equal(word(seen), "It");
      seen = await press(page, "}", "w", "l");
      assert.equal(LAST[seen.s], ".", "stays at the last letter");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
    test(`j and k walk the lines across answers and back to the same letter, with the view following, in ${engine.name}`, async () => {
      const { page, problems } = await open({ first: LONG, viewport: { width: 1000, height: 640 } });
      let seen = await look(page);
      assert.equal(seen.top, 0);
      for (let n = 0; n < 39; n += 1) await page.keyboard.press("j");
      seen = await look(page);
      assert.equal(wordAt(seen.s, LONG), "Row", "the last row's start");
      assert.equal(LONG.slice(seen.s, seen.s + 6), "Row 40");
      assert.equal(seen.inView, true, "the view followed down");
      assert.ok(seen.top > 0);
      seen = await press(page, "j");
      assert.equal(seen.answer, U("A2"), "into the next answer");
      seen = await press(page, "k");
      assert.equal(seen.answer, U("A1"));
      assert.equal(LONG.slice(seen.s, seen.s + 6), "Row 40", "and back");
      for (let n = 0; n < 39; n += 1) await page.keyboard.press("k");
      seen = await look(page);
      assert.equal(seen.s, 0, "back on the first letter");
      assert.equal(seen.inView, true, "the view followed up");
      seen = await press(page, "k");
      assert.equal(seen.s, 0, "k stays at the top");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
    test(`gg, G, Ctrl+d and Ctrl+u move the cursor with the view, at both ends, in ${engine.name}`, async () => {
      const { page, problems } = await open({ first: LONG, viewport: { width: 1000, height: 640 } });
      let seen = await press(page, "Control+d");
      assert.ok(seen.top > 0, "the view moved");
      const down = seen;
      assert.ok(down.s > 0, "the cursor moved with it");
      assert.equal(seen.inView, true);
      seen = await press(page, "Control+d");
      assert.ok(seen.top > down.top && seen.s > down.s);
      seen = await press(page, "Control+u");
      assert.equal(seen.top, down.top, "Ctrl+u undoes Ctrl+d");
      assert.equal(seen.inView, true);
      seen = await press(page, "G");
      assert.ok(Math.abs(seen.top - seen.max) <= 1, "the view at the bottom");
      assert.equal(seen.answer, U("A2"));
      assert.equal(LAST[seen.s], ".", "the cursor on the last letter");
      seen = await press(page, "Control+d");
      assert.ok(Math.abs(seen.top - seen.max) <= 1, "Ctrl+d stays at the bottom");
      seen = await press(page, "g", "g");
      assert.equal(seen.top, 0);
      assert.equal(seen.s, 0);
      assert.equal(seen.answer, U("A1"));
      seen = await press(page, "Control+u");
      assert.equal(seen.top, 0, "Ctrl+u stays at the top");
      assert.equal(seen.s, 0);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // A view scrolled away from the cursor brings it back to what the reader sees.
    // Browser: focus and keys.
    test(`after a scroll by other means the next key starts from the first letter in view, in ${engine.name}`, async () => {
      const { page, problems } = await open({ first: LONG, viewport: { width: 1000, height: 640 } });
      await inThread(page, (root) => {
        const el = root.querySelector(".transcript");
        el.scrollTop = el.scrollHeight / 2;
      });
      const seen = await press(page, "l");
      assert.equal(seen.inView, true);
      assert.ok(seen.s > 0);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
    test(`v and Enter on an earlier answer make a highlight, Escape drops, and dd removes it, in ${engine.name}`, async () => {
      const { page, problems } = await open();
      let seen = await press(page, "v", "w", "w");
      assert.equal(seen.passage, "First answer");
      assert.ok((await inThread(page, (root) => root.querySelectorAll(".passage i").length)) === 1, "tinted as a box");
      seen = await press(page, "Escape");
      assert.equal(seen.passage, "", "Escape drops it");
      assert.equal(seen.onConversation, true, "and stays on the conversation");
      assert.equal(seen.marked, "");
      seen = await press(page, "v", "w", "Enter");
      assert.equal(seen.passage, "");
      await until(async () => (await look(page)).marked !== "");
      seen = await look(page);
      assert.equal(seen.box, false, "no comment box on an earlier answer");
      assert.equal(seen.onConversation, true);
      assert.equal(seen.onLetter, true, "the cursor stays on its letter through the new mark");
      // Outside the highlight, dd does nothing; inside it, dd removes it.
      await press(page, "}", "d", "d");
      assert.notEqual((await look(page)).marked, "");
      await press(page, "{", "w", "w", "d", "d");
      await until(async () => (await look(page)).marked === "");
      assert.equal((await look(page)).onConversation, true);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: focus and keys.
    test(`v and Enter on the last answer open the comment box, which gives the keyboard back, and a passage stays in its answer, in ${engine.name}`, async () => {
      const { page, problems } = await open();
      await press(page, "G");
      let seen = await press(page, "{", "{");
      assert.equal(LAST.slice(seen.s, seen.s + 4), "Last");
      // Out of the top of this answer, the cursor stops at its first letter.
      seen = await press(page, "v", "b", "b");
      assert.equal(seen.answer, U("A2"));
      assert.equal(seen.s, 0);
      seen = await press(page, "w", "Enter");
      await until(async () => (await look(page)).box);
      seen = await look(page);
      assert.equal(seen.shown, false, "no cursor while the box holds the keys");
      await page.keyboard.type("Why");
      await page.keyboard.press("Enter");
      await until(async () => !(await look(page)).box);
      await until(async () => (await look(page)).onConversation);
      seen = await press(page, "l");
      assert.equal(seen.shown, true, "the keys go on");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });

    // Browser: rendering and layout.
    test(`the cursor and a passage draw in the phone preview, in ${engine.name}`, async () => {
      const { page, problems } = await open({ phone: true, viewport: { width: 390, height: 844 } });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.viewport), "phone");
      let seen = await look(page);
      assert.equal(seen.onLetter, true);
      seen = await press(page, "v", "j", "l");
      assert.equal(seen.onLetter, true);
      assert.ok(seen.passage.length > 1);
      assert.ok((await inThread(page, (root) => root.querySelectorAll(".passage i").length)) >= 2, "a box per line");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    });
  });
}
