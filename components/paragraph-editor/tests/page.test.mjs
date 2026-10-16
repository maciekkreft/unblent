import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The paragraph prototype on its stem page, typed as a user would.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const STEM = `${BASE_URL}/workshop/design/paragraphs`;

for (const engine of ENGINES) {
  describe(`the paragraph editor in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("Enter makes a paragraph with a short gap, Shift+Enter a plain line break", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(2000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(STEM, { waitUntil: "domcontentloaded" });
        const content = page.locator("paragraph-editor .cm-content");
        await content.click();
        await page.keyboard.type("One");
        await page.keyboard.press("Enter");
        await page.keyboard.type("Two");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("three");
        const stored = () => page.evaluate(() => localStorage.getItem("paragraph-editor.draft"));
        await until(async () => (await stored()) === "One\n\nTwo\nthree");
        const heights = await content.locator(".cm-line").evaluateAll((lines) =>
          lines.map((l) => l.getBoundingClientRect().height),
        );
        assert.equal(heights.length, 4);
        assert.ok(heights[1] > 0 && heights[1] < heights[0], `the gap (${heights[1]}) is shorter than a line (${heights[0]})`);
        assert.equal(heights[2], heights[0], "a line break adds no gap");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
