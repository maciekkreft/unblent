import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const SAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "books", "tests", "fixtures", "sample.epub");
const BOOK = "01K00000000000000000000CBN";
// Written in this order, so the newest, which the editor opens, is in the open chapter.
const NOTES = [
  ["01ARZ3NDEKTSV4RRFFQ69G5FA1", "Loose note", {}],
  ["01ARZ3NDEKTSV4RRFFQ69G5FC3", "Second chapter note", { chapter: "chapter-two", chapterTitle: "Chapter Two" }],
  ["01ARZ3NDEKTSV4RRFFQ69G5FB2", "First chapter note", { chapter: "chapter-one", chapterTitle: "Chapter One" }],
];

const put = async (cookie, path, type, body) => {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
  assert.equal(res.status, 200, `PUT ${path}`);
};

// What the list reads as, top to bottom: the switch's pressed button, then every heading,
// row title and line, as the user reads them.
const reads = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("note-list").shadowRoot;
    const pressed = root.querySelector('.switch [aria-pressed="true"]')?.textContent.trim() ?? "no switch";
    const lines = [...root.querySelectorAll(".list > li")].map((li) =>
      (li.matches(".row") ? li.querySelector(".name") : li).textContent.replace(/\s+/g, " ").trim(),
    );
    return [pressed, ...lines].join(" | ");
  });

for (const engine of ENGINES) {
  // Rendering and layout, and a gesture: the switch groups the notes by the open chapter,
  // and Show all turns it to All chapters, a choice kept in this browser.
  test(`the chapter switch narrows the notes to the open chapter and back in ${engine.name}`, async () => {
    const cookie = forgeCookie("note-list-chapters");
    await put(cookie, `/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
    await put(cookie, `/api/books/${BOOK}/opened`, "application/json", "{}");
    for (const [id, title, chapter] of NOTES)
      await put(cookie, `/api/notes/${id}`, "application/json", JSON.stringify({ title, body: title, baseVersion: null, about: [{ kind: "book", id: BOOK, ...chapter }] }));
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      try {
        await signedIn(context, cookie);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/subject`);
        await until(
          async () =>
            (await reads(page)) ===
            "This chapter | New note | Loose note |  | First chapter note | 1 more in other chapters · Show all",
        );
        await page.locator("note-list .show-all").click();
        const all = "All chapters | New note | Loose note |  | First chapter note | Second chapter note";
        await until(async () => (await reads(page)) === all);
        // Kept for the next load; a reload here would cost more than half the budget.
        assert.equal(await page.evaluate(() => localStorage.getItem("note-list:chapters")), "all");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
