import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

// The conversation with Vim keys (12): it takes the keyboard, hands it to the chat box in
// insert mode with i, and gets it back from the box's normal-mode Escape. Its cursor is in
// cursor.test.mjs.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference seeded the way the settings fact stores it (the workshop
// copy, since the page is under /workshop/).
const SETTINGS = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

// A chat whose finished answer overflows the conversation box, seeded through the API.
const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("K1");
const ANSWER = Array.from({ length: 30 }, (_, k) => `line ${k + 1}`).join("\n\n");

const box = (page) =>
  page.evaluate(() => {
    const thread = document.querySelector("chat-thread");
    const el = thread.shadowRoot.querySelector(".transcript");
    const input = document.querySelector("chat-input");
    const view = input.shadowRoot.querySelector(".cm-content").cmView.rootView.view;
    return {
      top: Math.round(el.scrollTop),
      max: el.scrollHeight - el.clientHeight,
      height: el.clientHeight,
      onConversation: document.activeElement === thread && thread.shadowRoot.activeElement === el,
      inBox: document.activeElement === input,
      vim: Boolean(view.cm),
      inserting: view.cm?.state?.vim?.insertMode === true,
      draft: view.state.doc.toString(),
      // The last answer takes comments once it is finished.
      done: Boolean(thread.shadowRoot.querySelector(".answer.markable")),
    };
  });

// The colour drawn at one point of the page, as [r, g, b]: a 1x1 screenshot is one PNG
// row of one pixel, which every PNG filter stores as the pixel itself.
const pixel = async (page, x, y) => {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
};

// A fresh account holding the long chat, opened on the stem page with Vim keys on, and
// the keyboard moved from the box (in Vim's normal mode, as after typing and a first
// Escape) onto the conversation with Escape. The account is on Echo, so the box is live.
async function onConversation(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 500 } });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie(name));
  assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok(), "the account is set to Echo");
  const chat = {
    title: "Scroll me",
    about: [],
    start: "",
    turns: [
      { id: U("Q1"), role: "user", text: "Scroll me" },
      { id: U("A1"), role: "assistant", text: ANSWER, status: "done" },
    ],
  };
  assert.ok((await context.request.put(`${BASE_URL}/api/conversations/${CHAT}`, { data: chat })).ok(), "the chat is seeded");
  await context.addInitScript((v) => localStorage.setItem("settings", v), SETTINGS);
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
  await page.locator("conversation-list .row", { hasText: "Scroll me" }).click();
  await until(async () => {
    const b = await box(page);
    return b.max > b.height && b.done;
  });
  await page.locator("chat-input .cm-content").click();
  await until(async () => {
    const b = await box(page);
    return b.inBox && b.vim && !b.inserting;
  });
  await page.keyboard.press("Escape");
  await until(async () => (await box(page)).onConversation);
  return { context, page, problems };
}

for (const engine of ENGINES) {
  // Browser: focus and keys.
  test(`i hands the keyboard to the chat box and its normal-mode Escape brings it back in ${engine.name}`, async () => {
    const browser = await engine.launch();
    let context;
    try {
      const opened = await onConversation(browser, `chat-trade-${engine.name}`);
      context = opened.context;
      const { page, problems } = opened;
      await page.keyboard.press("i");
      await until(async () => {
        const b = await box(page);
        return b.inBox && b.inserting;
      });
      await page.keyboard.type("x");
      assert.equal((await box(page)).draft, "x");
      // The first Escape leaves insert mode in the box; the second goes back.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await until(async () => (await box(page)).onConversation);
      assert.deepEqual(problems, []);
    } finally {
      await context?.close();
      await browser.close();
    }
  });

  // An answer is positioned and its comment box sits above it (z-index 1), so either,
  // scrolled under the conversation's edge, painted over a frame drawn as the box's own
  // outline; the frame that says the keyboard is here must stay on top.
  // Browser: rendering and layout.
  test(`the conversation's frame is drawn above an answer scrolled under its edge in ${engine.name}`, async () => {
    const browser = await engine.launch();
    let context;
    try {
      const opened = await onConversation(browser, `chat-frame-${engine.name}`);
      context = opened.context;
      const { page, problems } = opened;
      // An opaque box over the whole answer, where its comment box sits, and the answer
      // scrolled so it runs under the conversation's top edge.
      const at = await page.evaluate(() => {
        const root = document.querySelector("chat-thread").shadowRoot;
        const el = root.querySelector(".transcript");
        const box = document.createElement("div");
        box.style.cssText = "position: absolute; inset: 0; background: rgb(0, 0, 255); z-index: 1";
        root.querySelector(".turn.assistant").append(box);
        el.scrollTop = el.scrollHeight / 2;
        const probe = document.createElement("span");
        probe.style.color = "var(--color-accent)";
        root.append(probe);
        const color = getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).map(Number);
        probe.remove();
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.ceil(r.top), color };
      });
      const [r, g, b] = await pixel(page, at.x, at.y);
      const near = (c, w) => Math.abs(c - w) <= 8;
      assert.ok(near(r, at.color[0]) && near(g, at.color[1]) && near(b, at.color[2]), `the frame's top edge shows rgb(${r}, ${g}, ${b}), not the accent rgb(${at.color.join(", ")})`);
      assert.deepEqual(problems, []);
    } finally {
      await context?.close();
      await browser.close();
    }
  });
}
