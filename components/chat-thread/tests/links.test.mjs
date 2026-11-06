import { test } from "node:test";
import assert from "node:assert/strict";

// A name in an opened lookup is a link that opens what it names on the stage while the
// chat keeps its place (7.7). Which event each kind emits is tested in Node in this
// component's machine tests; what each event opens, in the tests of its consumers.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("C2");
const NOTE = U("N1");

const put = async (cookie, path, body) => {
  const res = await fetch(BASE_URL + path, { method: "PUT", headers: { "content-type": "application/json", Cookie: "unblent_session=" + cookie }, body: JSON.stringify(body) });
  assert.equal(res.status, 200, "PUT " + path);
};

const focused = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("#chats-thread").shadowRoot.activeElement;
    return el ? { tag: el.tagName, text: el.textContent.trim(), ring: getComputedStyle(el).boxShadow !== "none" } : null;
  });

for (const engine of ENGINES) {
  // A page's composition, and focus and keys: Tab reaches a lookup's link from its line
  // and Shift+Tab goes back; Enter on it opens the note on the stage as a tab of its own,
  // and the chat stays open in its panel.
  test(`a lookup's link opens the note it names on the stage in ${engine.name}`, async () => {
    const cookie = forgeCookie("chat-links");
    await put(cookie, "/api/notes/" + NOTE, { title: "Plans for Monday", body: "Plans for Monday\n\nCall Mum.", baseVersion: null, about: [] });
    const found = { notes: [{ id: NOTE, title: "Plans for Monday", line: "Call Mum.", updatedAt: 1, about: [] }], total: 1, more: 0 };
    const turns = [
      { id: U("Q1"), role: "user", text: "What are my plans?" },
      { id: U("A1"), role: "assistant", text: "", status: "done", calls: [{ id: "c1", target: "notes", name: "find", payload: { contains: "plans" }, label: "Listing the notes" }] },
      { id: U("R1"), role: "user", text: "", results: [{ callId: "c1", content: JSON.stringify(found) }] },
      { id: U("A2"), role: "assistant", text: "Call Mum.", status: "done" },
    ];
    await put(cookie, "/api/conversations/" + CHAT, { title: "Plans", about: [], start: "", turns });
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, cookie);
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(BASE_URL + "/");
        await page.locator("dock-desk").getByRole("tab", { name: "Chats" }).click();
        await page.locator("conversation-list").getByText("Plans", { exact: true }).click();
        const summary = page.locator("#chats-thread .lookup summary", { hasText: "Listing the notes" });
        await summary.click();
        const link = page.locator("#chats-thread .got .open", { hasText: "Plans for Monday" });
        await link.waitFor();
        assert.match(await page.locator("#chats-thread .got li").textContent(), /Plans for Monday\s+Call Mum\./, "the entry shows its short text");

        await summary.focus();
        await page.keyboard.press("Tab");
        await until(async () => (await focused(page))?.text === "Plans for Monday");
        assert.ok((await focused(page)).ring, "the link shows the focus ring");
        await page.keyboard.press("Shift+Tab");
        await until(async () => (await focused(page))?.tag === "SUMMARY");
        await page.keyboard.press("Tab");
        await until(async () => (await focused(page))?.text === "Plans for Monday");
        await page.keyboard.press("Enter");

        await until(async () => (await page.locator("dock-desk").getByRole("tab", { name: "Plans for Monday" }).count()) === 1);
        await until(async () => (await page.locator("#stage").evaluate((el) => el.checkVisibility())) === true);
        assert.ok(await link.isVisible(), "the chat keeps its place, the lookup still open");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  // A page's composition: on the phone a book's link leaves the chat's drawer for the
  // book's own contents, as the shelf does, and the stage behind them shows that book.
  test(`a lookup's link to a book folds the chat on the phone in ${engine.name}`, async () => {
    const cookie = forgeCookie("chat-links-book");
    const books = { books: [{ id: "00000000000000000000000JRN", title: "My days", author: "", cover: null, position: { chapter: 0, block: 0 }, chapterCount: 0, pending: false, addedAt: 1, written: true }] };
    const turns = [
      { id: U("Q1"), role: "user", text: "Which books do I have?" },
      { id: U("A1"), role: "assistant", text: "", status: "done", calls: [{ id: "c1", target: "books", name: "list", payload: {}, label: "Listing the books" }] },
      { id: U("R1"), role: "user", text: "", results: [{ callId: "c1", content: JSON.stringify(books) }] },
      { id: U("A2"), role: "assistant", text: "One.", status: "done" },
    ];
    await put(cookie, "/api/conversations/" + CHAT, { title: "Library", about: [], start: "", turns });
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        await signedIn(context, cookie);
        await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(BASE_URL + "/");
        const folded = (side) => page.locator(`dock-desk .dock.${side}`).evaluate((d) => d.classList.contains("folded"));
        await page.locator('dock-desk .dock.right .fold[aria-label="Unfold"]').click();
        await page.locator("dock-desk").getByRole("tab", { name: "Chats" }).click();
        await page.locator("conversation-list").getByText("Library", { exact: true }).click();
        await page.locator("#chats-thread .lookup summary", { hasText: "Listing the books" }).click();
        await page.locator("#chats-thread .got .open", { hasText: "My days" }).click();

        await until(() => folded("right"));
        await until(async () => !(await folded("left")));
        await until(() => page.locator("journal-entry").evaluate((el) => el.checkVisibility()));
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
}
