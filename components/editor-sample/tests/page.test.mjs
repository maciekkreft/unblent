import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const text = (page) => page.evaluate(() => document.querySelector("editor-sample").text);

for (const engine of ENGINES) {
  // Rendering and layout: the editor mounts on its stem page, draws the text it is given,
  // and what is typed into it shows in the document and in its `text`.
  test(`the sample editor shows its text and what is typed in ${engine.name}`, async () => {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/editor`);
        await page.waitForFunction(() => document.querySelector("editor-sample")?.shadowRoot?.querySelector(".cm-content"));
        await page.evaluate(() => (document.querySelector("editor-sample").text = "- [ ] One\n\n> Two"));
        await until(async () => (await page.locator("editor-sample .cm-line").count()) === 3);
        assert.equal(await page.locator("editor-sample .cm-line svg").count(), 1);
        await page.locator("editor-sample .cm-content").click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" and more");
        await until(async () => (await text(page)) === "- [ ] One\n\n> Two and more");
        await until(async () => (await page.locator("editor-sample .cm-content").textContent()).includes("Two and more"));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
