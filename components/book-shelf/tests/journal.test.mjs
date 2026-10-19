import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The product page holds the journal fact, so `books` presents the journal there.
const PAGE = `${BASE_URL}/`;

// Each real tile as the user sees it: title, the line under it, the chapter count if
// any, and which tools stand on its cover.
const tiles = (page) =>
  page.evaluate(() =>
    [...document.querySelector("book-shelf").shadowRoot.querySelectorAll(".tile:not(.adding)")].map((t) => ({
      title: t.querySelector(".title").textContent.trim(),
      byline: t.querySelector(".author")?.textContent.trim() ?? null,
      progress: t.querySelector(".progress")?.textContent.trim() ?? null,
      rename: Boolean(t.querySelector(".edit")),
      remove: Boolean(t.querySelector(".bin")),
    })),
  );

for (const engine of ENGINES) {
  // Browser: rendering and layout.
  test(`the journal tile reads "Written by you" and cannot be renamed or deleted in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext();
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      await signedIn(context, forgeCookie("shelf-journal"));
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(PAGE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("book-shelf")?.shadowRoot);
      await until(async () => (await tiles(page)).some((t) => t.title === "Journal"));
      const [first] = await tiles(page);
      assert.deepEqual(first, { title: "Journal", byline: "Written by you", progress: null, rename: false, remove: false });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}
