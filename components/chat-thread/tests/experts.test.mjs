import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The experts shelf above a new chat, on the chat stem page. /api/flags is routed with
// Book experts released and shown, because data/flags.db is shared by every test
// (feature-flags' test says why). The book and its expert are set up through the server.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub");
const PAGE = `${BASE_URL}/workshop/design/conversations`;
const BOOK = "01K00000000000000000000EXP";
const PROMPT = "Talk plainly about the sample book.";

async function account(browser, name) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  context.setDefaultTimeout(4000);
  const cookie = forgeCookie(name);
  await signedIn(context, cookie);
  await context.route(/\/api\/flags$/, (route) =>
    route.fulfill({ json: { off: [], hidden: [], released: ["book-experts"], shown: ["book-experts"] } }),
  );
  const put = async (path, type, body) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
    assert.equal(res.status, 200, `PUT ${path}`);
  };
  await put(`/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(`/api/experts/${BOOK}`, "application/json", JSON.stringify({ prompt: PROMPT, on: true, baseVersion: null }));
  await put("/api/llm", "application/json", JSON.stringify({ provider: "echo" }));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await until(async () => (await shelf(page)) !== null);
  return { context, page, problems, cookie };
}

// What the shelf shows, read from the page.
const shelf = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("chat-thread").shadowRoot;
    const head = root.querySelector(".ex-head");
    if (!head) return null;
    const input = document.querySelector("chat-input").shadowRoot;
    return {
      head: head.firstChild && [...head.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim(),
      chosen: head.querySelector(".chosen")?.textContent.trim() ?? null,
      open: head.getAttribute("aria-expanded") === "true",
      spines: [...root.querySelectorAll(".ex")].map((b) => {
        const box = b.getBoundingClientRect();
        return { text: b.textContent.trim(), pressed: b.getAttribute("aria-pressed") === "true", tall: box.height > box.width, background: getComputedStyle(b).backgroundColor, focused: root.activeElement === b };
      }),
      placeholder: input.querySelector(".cm-placeholder")?.textContent ?? null,
      inBox: document.activeElement === document.querySelector("chat-input"),
    };
  });

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`experts shelf (${engine.name})`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Rendering and layout: the spines stand on the shelf, No expert first and picked.
    test("a new chat shows No expert and the book's spine, upright and coloured", async () => {
      const { context, page, problems } = await account(browser, "experts-shelf");
      try {
        const s = await shelf(page);
        assert.equal(s.head, "Book experts");
        assert.equal(s.chosen, null);
        assert.deepEqual(s.spines.map((x) => [x.text, x.pressed, x.tall]), [["No expert", true, true], ["Sample Book", false, true]]);
        assert.notEqual(s.spines[1].background, s.spines[0].background, "the book's spine has a colour of its own");
        assert.equal(s.placeholder, "Ask about your library…");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // A gesture: a click picks the expert, the first message starts the chat with its
    // prompt, and the shelf goes.
    test("picking the expert and sending starts the chat as that expert", async () => {
      const { context, page, problems, cookie } = await account(browser, "experts-pick");
      try {
        await page.locator("chat-thread .ex", { hasText: "Sample Book" }).click();
        await until(async () => (await shelf(page)).spines[1].pressed);
        const s = await shelf(page);
        assert.equal(s.chosen, "· Sample Book");
        assert.equal(s.spines[0].pressed, false);
        assert.equal(s.placeholder, "Ask the expert on Sample Book…");
        assert.ok(s.inBox, "the box takes the keyboard");
        await page.keyboard.type("Where do I start?");
        await page.keyboard.press("Enter");
        await until(async () => (await shelf(page)) === null);
        let chat = null;
        await until(async () => {
          const list = await (await fetch(`${BASE_URL}/api/conversations`, { headers: { Cookie: `unblent_session=${cookie}` } })).json();
          const id = list.conversations?.[0]?.id;
          if (!id) return false;
          chat = await (await fetch(`${BASE_URL}/api/conversations/${id}`, { headers: { Cookie: `unblent_session=${cookie}` } })).json();
          return Boolean(chat.start);
        });
        assert.ok(chat.start.endsWith(`You also speak as an expert on the book "Sample Book":\n${PROMPT}`), chat.start);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Focus and keys: Tab reaches the picked spine, the arrows move along the shelf,
    // Enter picks, and Left goes back to No expert.
    test("the spines are reached and picked from the keyboard", async () => {
      const { context, page, problems } = await account(browser, "experts-keys");
      try {
        await page.locator("chat-thread .ex-head").focus();
        await page.keyboard.press("Tab");
        assert.ok((await shelf(page)).spines[0].focused, "Tab lands on the picked spine");
        await page.keyboard.press("ArrowRight");
        assert.ok((await shelf(page)).spines[1].focused);
        await page.keyboard.press("ArrowRight");
        assert.ok((await shelf(page)).spines[1].focused, "never past the end");
        await page.keyboard.press("Enter");
        await until(async () => (await shelf(page)).spines[1].pressed);
        await page.locator("chat-thread .ex", { hasText: "Sample Book" }).focus();
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("Space");
        await until(async () => (await shelf(page)).spines[0].pressed);
        assert.equal((await shelf(page)).chosen, null);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // A reload against real storage: the fold is kept in this browser.
    test("the shelf folds to its heading, and stays folded after a reload", async () => {
      const { context, page, problems } = await account(browser, "experts-fold");
      try {
        await page.locator("chat-thread .ex-head").click();
        await until(async () => (await shelf(page)).spines.length === 0);
        assert.equal((await shelf(page)).open, false);
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await shelf(page)) !== null);
        const s = await shelf(page);
        assert.equal(s.open, false);
        assert.equal(s.spines.length, 0);
        await page.locator("chat-thread .ex-head").click();
        await until(async () => (await shelf(page)).spines.length === 2);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
