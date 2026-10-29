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
const BOOK = "01K00000000000000000000CCT";
const CHAT = "01HQ8ZK7M4N5P6Q7R8S9T0V1C1";

const put = async (cookie, path, type, body) => {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
  assert.equal(res.status, 200, `PUT ${path}`);
};

// What the label says, its button included, as the user reads it.
const label = (page) =>
  page.evaluate(() => document.querySelector("chat-thread").shadowRoot.querySelector(".chapter")?.textContent.replace(/\s+/g, " ").trim() ?? "");

for (const engine of ENGINES) {
  // Rendering and layout, and a gesture: the label names the chat's chapter, and its
  // button links the chat to the open chapter and unlinks it again.
  test(`the chapter label links a chat to the open chapter and back in ${engine.name}`, async () => {
    const cookie = forgeCookie("chat-chapter");
    await put(cookie, `/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
    await put(cookie, `/api/books/${BOOK}/opened`, "application/json", "{}");
    const turns = [{ id: "01HQ8ZK7M4N5P6Q7R8S9T0V1D1", role: "user", text: "q" }, { id: "01HQ8ZK7M4N5P6Q7R8S9T0V1E1", role: "assistant", text: "a", status: "done" }];
    await put(cookie, `/api/conversations/${CHAT}`, "application/json", JSON.stringify({ title: "A chat", about: [{ kind: "book", id: BOOK }], start: "", turns }));
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      try {
        await signedIn(context, cookie);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`);
        await page.locator("dock-desk").getByRole("tab", { name: "Chats" }).click();
        await page.locator("conversation-list").getByText("A chat", { exact: true }).click();
        await until(async () => (await label(page)) === "Whole book Link to Chapter One");
        const button = page.locator("chat-thread .relink");
        await button.click();
        await until(async () => (await label(page)) === "Chapter One Unlink");
        await button.click();
        await until(async () => (await label(page)) === "Whole book Link to Chapter One");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
