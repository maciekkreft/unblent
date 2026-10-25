import { test } from "node:test";
import assert from "node:assert/strict";

// The conversation with Vim keys (12): it takes the keyboard, scrolls with j, k, gg, G,
// Ctrl+d and Ctrl+u, hands the keyboard to the chat box in insert mode with i, and gets it
// back from the box's normal-mode Escape. The scroll arithmetic is tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference seeded the way the settings fact stores it (the workshop
// copy, since the page is under /workshop/).
const SETTINGS = JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys: true });

// A question long enough that the Echo answer overflows the conversation box.
const LONG = Array.from({ length: 30 }, (_, k) => `line ${k + 1}`).join("\n\n");

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
      inserting: view.cm?.state?.vim?.insertMode === true,
      draft: view.state.doc.toString(),
      // The last answer takes comments once it is finished.
      done: Boolean(thread.shadowRoot.querySelector(".answer.markable")),
    };
  });

for (const engine of ENGINES) {
  // Browser: focus and keys.
  test(`the conversation scrolls with Vim keys and trades the keyboard with the chat box in ${engine.name}`, { timeout: 15000 }, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1000, height: 500 } });
    try {
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie(`chat-keys-${engine.name}`));
      assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok(), "the account is set to Echo");
      await context.addInitScript((v) => localStorage.setItem("settings", v), SETTINGS);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
      await page.locator("conversation-list .row", { hasText: "New chat" }).click();
      // A new chat puts the cursor in the box in insert mode; Escape leaves insert and
      // Enter sends in normal mode.
      await until(async () => (await box(page)).inserting);
      await page.evaluate((text) => {
        const view = document.querySelector("chat-input").shadowRoot.querySelector(".cm-content").cmView.rootView.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      }, LONG);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Enter");
      await until(async () => {
        const b = await box(page);
        return b.max > b.height && b.done;
      });

      // The second Escape after typing puts the keyboard on the conversation.
      await page.keyboard.press("Escape");
      await until(async () => (await box(page)).onConversation);

      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await until(async () => (await box(page)).top === 0);
      await page.keyboard.press("j");
      await until(async () => (await box(page)).top > 0);
      const afterJ = (await box(page)).top;
      await page.keyboard.press("Control+d");
      await until(async () => (await box(page)).top >= afterJ + Math.floor((await box(page)).height / 2) - 1);
      await page.keyboard.press("Control+u");
      await until(async () => Math.abs((await box(page)).top - afterJ) <= 1);
      await page.keyboard.press("k");
      await until(async () => (await box(page)).top === 0);
      await page.keyboard.press("G");
      await until(async () => {
        const b = await box(page);
        return Math.abs(b.top - b.max) <= 1;
      });

      // i hands the keyboard to the box, ready to type.
      await page.keyboard.press("i");
      await until(async () => {
        const b = await box(page);
        return b.inBox && b.inserting;
      });
      await page.keyboard.type("x");
      assert.equal((await box(page)).draft, "x");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await until(async () => (await box(page)).onConversation);
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
