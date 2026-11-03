import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { inflateSync } from "node:zlib";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub"));

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

for (const engine of ENGINES) {
  // A tile's cover is positioned, so a cover scrolled under the shelf's edge painted over
  // a drag frame drawn as the shelf's own outline; the frame must stay on top.
  // Browser: rendering and layout.
  test(`the drag frame is drawn above a cover scrolled under the shelf's edge in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    context.setDefaultTimeout(4000);
    try {
      const problems = [];
      const cookie = forgeCookie("shelf-frame");
      // Enough books that the shelf scrolls.
      for (const n of [1, 2, 3, 4]) {
        const res = await fetch(`${BASE_URL}/api/books/01K0000000000000000000FRM${n}`, {
          method: "PUT",
          headers: { "content-type": "application/epub+zip", Cookie: `unblent_session=${cookie}` },
          body: SAMPLE,
        });
        assert.equal(res.status, 200, "the book is imported");
      }
      await signedIn(context, cookie);
      const page = await context.newPage();
      watch(page, problems);
      await page.goto(`${BASE_URL}/workshop/design/books`, { waitUntil: "domcontentloaded" });
      await until(async () =>
        page.evaluate(() => (document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile:not(.adding) .cover").length ?? 0) === 4),
      );
      // A file dragged over the shelf, and the first cover scrolled up across its top edge.
      await page.evaluate(() => {
        const root = document.querySelector("book-shelf").shadowRoot;
        const shelf = root.querySelector(".shelf");
        shelf.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
        const cover = root.querySelector(".cover");
        shelf.scrollTop += cover.getBoundingClientRect().top - shelf.getBoundingClientRect().top + 20;
      });
      await until(async () => page.evaluate(() => document.querySelector("book-shelf").shadowRoot.querySelector(".shelf.dragover") !== null));
      const at = await page.evaluate(() => {
        const root = document.querySelector("book-shelf").shadowRoot;
        const shelf = root.querySelector(".shelf");
        const probe = document.createElement("span");
        probe.style.cssText = "position: absolute; color: var(--color-accent); width: calc(var(--space-xs) - var(--border-width))";
        root.append(probe);
        const color = getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).map(Number);
        const inset = parseFloat(getComputedStyle(probe).width);
        probe.remove();
        const r = shelf.getBoundingClientRect();
        const cover = root.querySelector(".cover").getBoundingClientRect();
        return { left: Math.round(cover.left) + 8, y: Math.floor(r.top + inset + 0.5), above: cover.top < r.top, color };
      });
      assert.ok(at.above, "the cover runs under the shelf's top edge");
      // The frame is dashed, so some of a short run of pixels along its top edge are gaps.
      const seen = [];
      for (let x = at.left; x < at.left + 12; x++) seen.push(await pixel(page, x, at.y));
      const near = (c, w) => Math.abs(c - w) <= 8;
      assert.ok(
        seen.some(([r, g, b]) => near(r, at.color[0]) && near(g, at.color[1]) && near(b, at.color[2])),
        `the frame's top edge over a cover shows ${seen.map((c) => `rgb(${c.join(", ")})`).join(" ")}, never the accent rgb(${at.color.join(", ")})`,
      );
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
