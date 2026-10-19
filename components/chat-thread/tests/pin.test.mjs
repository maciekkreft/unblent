import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// What the pin button shows: whether it can be pressed, whether it reads as pinned, and
// the reason it gives on hover.
const pin = (page) =>
  page.evaluate(() => {
    const b = document.querySelector("chat-thread").shadowRoot.querySelector(".pin");
    return { disabled: b.disabled, pressed: b.getAttribute("aria-pressed"), title: b.title };
  });

for (const engine of ENGINES) {
  // Browser: rendering and layout.
  test(`a new chat's pin is unavailable until its first message, then pinned, in ${engine.name}`, { timeout: 15000 }, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    try {
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie(`chat-pin-${engine.name}`));
      assert.ok((await context.request.put(`${BASE_URL}/api/llm`, { data: { provider: "echo" } })).ok(), "the account is set to Echo");
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
      await page.locator("conversation-list .row", { hasText: "New chat" }).click();
      await until(async () => (await pin(page)).disabled);
      assert.equal((await pin(page)).title, "Pin chat: available after the first message");
      assert.equal((await pin(page)).pressed, "false");

      await until(async () => await page.evaluate(() => Boolean(document.querySelector("chat-input")?.shadowRoot?.querySelector('.cm-content[contenteditable="true"]'))));
      await page.locator("chat-input .cm-content").click();
      await page.keyboard.type("hello");
      await page.keyboard.press("Enter");
      await until(async () => {
        const p = await pin(page);
        return !p.disabled && p.pressed === "true";
      });
      assert.equal((await pin(page)).title, "Unpin chat");
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
