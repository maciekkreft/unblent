import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference (12), seeded the way settings stores it (the workshop
// profile, since the page is under /workshop/).
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

const inList = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("conversation-list").shadowRoot, arg), [fn.toString(), arg]);
const rowTitles = (page) => inList(page, (root) => [...root.querySelectorAll(".row .name")].map((n) => n.textContent.trim()));
const focusedTitle = (page) => inList(page, (root) => root.activeElement?.querySelector(".name")?.textContent.trim() ?? null);
const openTitle = (page) => inList(page, (root) => root.querySelector('.row[aria-selected="true"] .name')?.textContent.trim() ?? null);
// The roving row, where Tab lands in the list.
const focusList = (page) => inList(page, (root) => root.querySelector('.row[tabindex="0"]').focus());

for (const engine of ENGINES) {
  describe(`conversation-list Vim keys in ${engine.name}`, { timeout: 60000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 30000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Two chats on the server, so the list holds New chat, chat 2, chat 1.
    const open = async (vimKeys) => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("conversation-list"));
      const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
      for (const k of ["1", "2"]) {
        const turns = [{ id: U("D" + k), role: "user", text: "q" }, { id: U("E" + k), role: "assistant", text: "answer " + k, status: "done" }];
        const put = await context.request.put(`${BASE_URL}/api/conversations/${U("C" + k)}`, { data: { title: "chat " + k, about: [], start: "", turns } });
        assert.ok(put.ok(), "a chat is on the server");
      }
      await context.addInitScript((v) => localStorage.setItem("settings", v), seed(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
      await until(async () => (await rowTitles(page)).join() === "New chat,chat 2,chat 1");
      return { context, page, problems };
    };

    // Browser: rendering and layout.
    test("signed out, the list asks to sign in and shows no chats", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/conversations`, { waitUntil: "domcontentloaded" });
        await until(async () => (await inList(page, (root) => root.textContent.trim())) === "Sign in to chat.");
        assert.deepEqual(await rowTitles(page), [], "no rows, not even New chat");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("a row the keyboard is on shows its time and, under it, its bin, at the same height as any row", async () => {
      const { context, page, problems } = await open(false);
      try {
        await focusList(page);
        await page.keyboard.press("ArrowDown");
        await until(async () => (await focusedTitle(page)) === "chat 2");
        const box = await inList(page, (root) => {
          const rect = (el) => el.getBoundingClientRect();
          const seen = (el) => getComputedStyle(el).visibility === "visible" && rect(el).width > 0 && rect(el).height > 0;
          const row = root.activeElement;
          const other = [...root.querySelectorAll(".row")].find((r) => r !== row && r.querySelector(".bin"));
          const time = row.querySelector(".time");
          const bin = row.querySelector(".bin");
          return {
            time: seen(time),
            bin: seen(bin),
            under: rect(bin).top >= rect(time).bottom - 0.5,
            right: Math.abs(rect(bin).right - rect(time).right),
            height: Math.abs(rect(row).height - rect(other).height),
          };
        });
        assert.ok(box.time, "the time stays seen");
        assert.ok(box.bin, "the bin shows");
        assert.ok(box.under, "the bin is below the time");
        assert.ok(box.right <= 1, `the bin is right-aligned under the time (${box.right}px off)`);
        assert.ok(box.height <= 0.5, `the row keeps its height (${box.height}px off)`);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, j/k, G and gg move along the chats and Enter opens", async () => {
      const { context, page, problems } = await open(true);
      try {
        await focusList(page);
        const start = await focusedTitle(page);
        assert.ok(start, "a row takes the focus");
        await page.keyboard.press("G");
        await until(async () => (await focusedTitle(page)) === "chat 1");
        await page.keyboard.press("k");
        await until(async () => (await focusedTitle(page)) === "chat 2");
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        await until(async () => (await focusedTitle(page)) === "New chat");
        await page.keyboard.press("j");
        await until(async () => (await focusedTitle(page)) === "chat 2");
        await page.keyboard.press("Enter");
        await until(async () => (await openTitle(page)) === "chat 2");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, dd deletes a row and p brings it back below the cursor; u twice returns it to its row", async () => {
      const { context, page, problems } = await open(true);
      try {
        await focusList(page);
        await page.keyboard.press("j");
        await until(async () => (await focusedTitle(page)) === "chat 2");
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await until(async () => (await rowTitles(page)).join() === "New chat,chat 1");
        await until(async () => (await focusedTitle(page)) === "chat 1");
        await page.keyboard.press("p");
        await until(async () => (await rowTitles(page)).join() === "New chat,chat 1,chat 2");
        await until(async () => (await focusedTitle(page)) === "chat 2");
        // u is the global Undo (12): it deletes the chat again, then the delete's Undo
        // brings it back to its first row.
        await page.keyboard.press("u");
        await until(async () => (await rowTitles(page)).join() === "New chat,chat 1");
        await page.keyboard.press("u");
        await until(async () => (await rowTitles(page)).join() === "New chat,chat 2,chat 1");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, cc edits a chat's title in place: Enter saves, Escape cancels, empty gives back the first line", async () => {
      const { context, page, problems } = await open(true);
      try {
        const field = () => inList(page, (root) => root.activeElement?.matches(".title-input") ?? false);
        await focusList(page);
        await page.keyboard.press("j");
        await until(async () => (await focusedTitle(page)) === "chat 2");
        await page.keyboard.press("c");
        await page.keyboard.press("c");
        await until(field);
        await page.keyboard.type("Reading plans");
        await page.keyboard.press("Enter");
        await until(async () => (await focusedTitle(page)) === "Reading plans");
        const stored = async () => (await (await context.request.get(`${BASE_URL}/api/conversations`)).json()).conversations.map((c) => c.title).sort().join();
        await until(async () => (await stored()) === "Reading plans,chat 1");
        // Escape leaves the title as it was, and the keyboard on the row.
        await page.keyboard.press("c");
        await page.keyboard.press("c");
        await until(field);
        await page.keyboard.type("Other");
        await page.keyboard.press("Escape");
        await until(async () => (await focusedTitle(page)) === "Reading plans");
        // An empty title gives back the first line of the first message.
        await page.keyboard.press("c");
        await page.keyboard.press("c");
        await until(field);
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Enter");
        await until(async () => (await rowTitles(page)).join() === "New chat,q,chat 1");
        await until(async () => (await stored()) === "chat 1,q");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys off, j does nothing", async () => {
      const { context, page, problems } = await open(false);
      try {
        await focusList(page);
        const start = await focusedTitle(page);
        await page.keyboard.press("j");
        await page.keyboard.press("G");
        await page.waitForTimeout(200);
        assert.equal(await focusedTitle(page), start);
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
