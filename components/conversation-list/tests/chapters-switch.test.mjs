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
const BOOK = "01K00000000000000000000CCS";
const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
// The sample book opens on Chapter One: one chat in it, one in Chapter Two, one about the whole book.
const CHATS = [
  ["1", "Loose chat", {}],
  ["2", "Second chapter chat", { chapter: "chapter-two", chapterTitle: "Chapter Two" }],
  ["3", "First chapter chat", { chapter: "chapter-one", chapterTitle: "Chapter One" }],
];

const put = async (cookie, path, type, body) => {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
  assert.equal(res.status, 200, `PUT ${path}`);
};

// What the list reads as, top to bottom: the switch's pressed button, then every heading,
// row title and line, as the user reads them.
const reads = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("conversation-list").shadowRoot;
    const pressed = root.querySelector('.switch [aria-pressed="true"]')?.textContent.trim() ?? "no switch";
    const lines = [...root.querySelectorAll(".list > li")].map((li) =>
      (li.matches(".row") ? li.querySelector(".name") : li).textContent.replace(/\s+/g, " ").trim(),
    );
    return [pressed, ...lines].join(" | ");
  });

for (const engine of ENGINES) {
  // Rendering and layout, and a gesture: the switch groups the chats by the open chapter,
  // and Show all turns it to All chapters, a choice kept in this browser.
  test(`the chapter switch narrows the chats to the open chapter and back in ${engine.name}`, async () => {
    const cookie = forgeCookie("conversation-list-chapters");
    await put(cookie, `/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
    await put(cookie, `/api/books/${BOOK}/opened`, "application/json", "{}");
    for (const [k, title, chapter] of CHATS) {
      const turns = [{ id: U("D" + k), role: "user", text: title }, { id: U("E" + k), role: "assistant", text: "answer", status: "done" }];
      await put(cookie, `/api/conversations/${U("C" + k)}`, "application/json", JSON.stringify({ title, about: [{ kind: "book", id: BOOK, ...chapter }], start: "", turns }));
    }
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      try {
        await signedIn(context, cookie);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`);
        await page.locator("dock-desk").getByRole("tab", { name: "Chats" }).click();
        await until(
          async () =>
            (await reads(page)) ===
            "This chapter | New chat | Loose chat |  | First chapter chat | 1 more in other chapters · Show all",
        );
        await page.locator("conversation-list .show-all").click();
        const all = "All chapters | New chat | Loose chat |  | First chapter chat | Second chapter chat";
        await until(async () => (await reads(page)) === all);
        assert.equal(await page.evaluate(() => localStorage.getItem("conversation-list:chapters")), "all");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
