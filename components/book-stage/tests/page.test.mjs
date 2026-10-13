import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub"));
const SAMPLE_ID = "01K00000000000000000000SMP";

// What the stage shows: the tag of the one child its slot holds.
const shown = (page) =>
  page.evaluate(() => document.querySelector("book-stage")?.shadowRoot?.querySelector("slot")?.assignedElements().map((e) => e.localName).join(",") ?? null);

const clickTile = (page, title) =>
  page.evaluate((title) => {
    const tiles = [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile:not(.adding)") ?? [])];
    const tile = tiles.find((t) => t.querySelector(".title")?.textContent.trim() === title);
    tile?.click();
    return Boolean(tile);
  }, title);

for (const engine of ENGINES) {
  test(`the stage shows the journal's page for the Journal and the reader for an imported book in ${engine.name}`, async () => {
    const cookie = forgeCookie("book-stage");
    // The book arrives through the server's API (11.2): milliseconds, no browser upload.
    const res = await fetch(`${BASE_URL}/api/books/${SAMPLE_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/epub+zip", Cookie: `unblent_session=${cookie}` },
      body: SAMPLE,
    });
    assert.equal(res.status, 200, "importing the sample book");
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, cookie);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        ["Journal", "Sample Book"].every((title) =>
          [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile .title") ?? [])].some((t) => t.textContent.trim() === title),
        ),
      );
      assert.equal(await shown(page), "book-reader", "with no book open the stage shows the reader");

      assert.ok(await clickTile(page, "Journal"));
      await page.waitForFunction(() => {
        const [child] = document.querySelector("book-stage").shadowRoot.querySelector("slot").assignedElements();
        const editor = child?.localName === "journal-entry" && child.shadowRoot?.querySelector(".cm-editor");
        return editor && editor.getBoundingClientRect().height > 0;
      });

      assert.ok(await clickTile(page, "Sample Book"));
      await page.waitForFunction(() => {
        const [child] = document.querySelector("book-stage").shadowRoot.querySelector("slot").assignedElements();
        return child?.localName === "book-reader" && child.shadowRoot?.querySelector(".footer .chap")?.textContent.trim();
      });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
