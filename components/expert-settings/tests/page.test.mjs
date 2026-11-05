import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The Book experts tab on the product page. /api/flags is routed, because data/flags.db is
// shared by every test (feature-flags' test says why), so the feature is released here only.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOK = "01K0000000000000000000EXP1";
const SAMPLE = readFileSync(resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub"));

// An account with one imported book, signed in, with Book experts released and shown.
async function open(browser, name, { hidden = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  context.setDefaultTimeout(4000);
  const cookie = forgeCookie(name);
  const res = await fetch(`${BASE_URL}/api/books/${BOOK}`, {
    method: "PUT",
    headers: { "content-type": "application/epub+zip", Cookie: `unblent_session=${cookie}` },
    body: SAMPLE,
  });
  assert.equal(res.status, 200, "the book is imported");
  await signedIn(context, cookie);
  await context.route(/\/api\/flags$/, (route) =>
    route.fulfill({ json: { off: [], hidden, released: ["book-experts"], shown: ["book-experts"].filter((f) => !hidden.includes(f)) } }),
  );
  return context;
}

// The gear's sheet on its Book experts tab.
async function tab(context) {
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("dock-desk .controls button.pill").click();
  await page.locator("settings-tabs").getByRole("tab", { name: "Book experts" }).click();
  await page.locator("expert-settings section.book").first().waitFor();
  return { page, problems };
}

// What the tab shows of each book: its heading, whether it is open, and its On box.
const books = (page) =>
  page.locator("expert-settings section.book").evaluateAll((sections) =>
    sections.map((s) => {
      const on = s.querySelector('input[type="checkbox"]');
      return {
        heading: s.querySelector("button.fold").textContent.replace(/\s+/g, " ").trim(),
        open: s.querySelector("button.fold").getAttribute("aria-expanded") === "true",
        on: on ? { checked: on.checked, disabled: on.disabled, title: on.title } : null,
        prompt: s.querySelector(".cm-content")?.textContent ?? null,
      };
    }),
  );

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`The Book experts tab in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a gesture.
    test("a book starts folded, opens, takes a prompt, then On, and Undo takes back On alone", async () => {
      const context = await open(browser, "experts-tab");
      try {
        const { page, problems } = await tab(context);
        await page.locator("expert-settings").getByText("Write how the expert on a book talks and what it knows.", { exact: false }).waitFor();
        const [first] = await books(page);
        assert.equal(first.open, false, "a book without a prompt starts folded");
        assert.equal(first.on, null);
        assert.ok(!first.heading.includes("Journal"));

        await page.locator("expert-settings button.fold").first().click();
        await until(async () => (await books(page))[0].on !== null);
        assert.deepEqual((await books(page))[0].on, { checked: false, disabled: true, title: "Write a prompt first" });
        const placeholder = await page.locator("expert-settings .cm-placeholder").first().textContent();
        assert.match(placeholder, /^How the expert on .+ talks and what it knows…$/);

        await page.locator("expert-settings .cm-content").first().click();
        await page.keyboard.type("Talk plainly.");
        await until(async () => (await books(page))[0].on.disabled === false);
        await page.locator('expert-settings input[type="checkbox"]').first().check();

        // Each change is one step: Undo takes back On, and the prompt stays.
        await page.evaluate(() => document.querySelector("undo-bar").shadowRoot.querySelector("button.undo").click());
        await until(async () => (await books(page))[0].on.checked === false);
        assert.equal((await books(page))[0].prompt, "Talk plainly.");
        await page.evaluate(() => document.querySelector("undo-bar").shadowRoot.querySelector("button.redo").click());
        await until(async () => (await books(page))[0].on.checked === true);
        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: a reload against real storage.
    test("a book with a prompt starts open, and folding it is kept across a reload", async () => {
      const context = await open(browser, "experts-fold");
      try {
        const cookie = (await context.cookies()).find((c) => c.name === "unblent_session").value;
        const res = await fetch(`${BASE_URL}/api/experts/${BOOK}`, {
          method: "PUT",
          headers: { "content-type": "application/json", Cookie: `unblent_session=${cookie}` },
          body: JSON.stringify({ prompt: "Talk plainly.", on: true, baseVersion: null }),
        });
        assert.equal(res.status, 200, "the expert is written");
        // The stem page, the smallest page that holds the tab (9).
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/experts`, { waitUntil: "domcontentloaded" });
        await until(async () => (await books(page))[0]?.prompt === "Talk plainly.");
        const [shown] = await books(page);
        assert.equal(shown.open, true, "a book with a prompt starts open");
        assert.deepEqual(shown.on, { checked: true, disabled: false, title: "" });
        await page.locator("expert-settings button.fold").first().click();
        await until(async () => (await books(page))[0].open === false);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator("expert-settings section.book").first().waitFor();
        assert.equal((await books(page))[0].open, false, "the fold is kept");
        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("the arrows move from a heading past a greyed On to the box and back, and Enter folds", async () => {
      const context = await open(browser, "experts-keys");
      await context.addInitScript(() => {
        try {
          localStorage.setItem("expert-settings:folded", JSON.stringify({ "01K0000000000000000000EXP1": false }));
        } catch {}
      });
      try {
        const { page, problems } = await tab(context);
        const focused = () =>
          page.evaluate(() => {
            const el = document.querySelector("expert-settings").shadowRoot.activeElement;
            return el ? (el.classList.contains("fold") ? "heading" : el.type === "checkbox" ? "on" : el.closest(".cm-editor") ? "box" : el.tagName) : null;
          });
        await page.locator("expert-settings button.fold").first().focus();
        await page.keyboard.press("ArrowDown");
        assert.equal(await focused(), "box", "On is greyed, so the path passes it to the box");
        await page.keyboard.press("ArrowUp");
        assert.equal(await focused(), "heading");
        await page.keyboard.press("Enter");
        await until(async () => (await books(page))[0].open === false);
        await page.keyboard.press("Enter");
        await until(async () => (await books(page))[0].open === true);
        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: a page's composition.
    test("the tab is not offered while Book experts is hidden", async () => {
      const context = await open(browser, "experts-hidden", { hidden: ["book-experts"] });
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.locator("dock-desk .controls button.pill").click();
        await page.locator("settings-tabs").getByRole("tab", { name: "Generators" }).waitFor();
        assert.equal(await page.locator("settings-tabs").getByRole("tab", { name: "Book experts" }).count(), 0);
        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });
  });
}
