import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The failing server this test stands in, and how each browser reports it. Chromium
// also reports the stand-in 503 as aborted, because the notes fact never reads its body.
const IGNORE = [/HTTP 503: .*\/api\/notes\//, /status of 503/, /\/api\/notes\/\S+ net::ERR_ABORTED/];

const status = (page) =>
  page.evaluate(() => document.querySelector("note-editor").shadowRoot.querySelector(".status > span").textContent.trim());

for (const engine of ENGINES) {
  // Rendering and layout: the footer says nothing while a note saves, says Not synced once
  // the server has failed it for a while, and says nothing again when the server has it.
  test(`the note editor says Not synced only while the server has not had the note in ${engine.name}`, async () => {
    const cookie = forgeCookie("note-synced");
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      try {
        await signedIn(context, cookie);
        const page = await context.newPage();
        const problems = watch(page, [], { ignore: IGNORE });
        let failing = true;
        await page.route("**/api/notes/*", (route) =>
          failing && route.request().method() === "PUT" ? route.fulfill({ status: 503, body: "" }) : route.continue(),
        );
        await page.clock.install();
        await page.goto(`${BASE_URL}/workshop/design/subject`);
        await page.waitForFunction(() => document.querySelector("note-editor")?.shadowRoot?.querySelector(".cm-content"));
        await page.locator("note-list .row.draft").click();
        await page.locator("note-editor .cm-content").click();
        await page.keyboard.type("Kept here");
        await until(async () => (await status(page)) === "");
        await page.clock.runFor(8000);
        await until(async () => (await status(page)) === "Not synced");
        failing = false;
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await until(async () => (await status(page)) === "");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
