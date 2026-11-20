import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The Prompts tab on the product page. /api/flags is routed, because data/flags.db is
// shared by every test and Journal prompts is held back on a throwaway server, so the
// feature is released here only. The decisions (what is saved when, the keys) are tested
// in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const FEATURES = ["journal-prompts"];

async function open(browser, name, { vim = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie(name));
  await context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: FEATURES, shown: FEATURES } }));
  if (vim) await context.addInitScript(() => localStorage.setItem("settings:product", JSON.stringify({ nav: [], vimKeys: true })));
  return context;
}

// The gear's sheet on its Prompts tab, the starter sets listed.
async function tab(context) {
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.locator("dock-desk .controls button.pill").click();
  await page.locator("settings-tabs").getByRole("tab", { name: "Prompts" }).click();
  await page.locator("prompt-settings section.set").nth(9).waitFor();
  return { page, problems };
}

const inTab = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("prompt-settings").shadowRoot, arg), [fn.toString(), arg]);

// Each set's heading as it reads, and whether it is open.
const sets = (page) =>
  inTab(page, (root) =>
    [...root.querySelectorAll("section.set")].map((s) => ({
      heading: s.querySelector("button.fold").innerText.replace(/\s+/g, " ").trim(),
      open: s.querySelector("button.fold").getAttribute("aria-expanded") === "true",
      prompts: [...s.querySelectorAll("textarea.prompt")].map((t) => t.value),
    })),
  );

// What holds the keyboard: a heading by its set's name, a box by its caption or prompt
// index, or a button by its text.
const focused = (page) =>
  inTab(page, (root) => {
    const el = root.activeElement;
    if (!el) return null;
    if (el.classList.contains("fold")) return `heading ${el.querySelector(".what span").textContent}`;
    if (el.classList.contains("prompt")) return `prompt ${el.dataset.index}`;
    if (el.tagName === "TEXTAREA") return el.closest(".field").querySelector(".caption").textContent;
    return el.textContent.trim();
  });

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`The Prompts tab in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: a gesture.
    test("New set is kept once named, New prompt adds a question, and Delete set comes back with Undo", async () => {
      const context = await open(browser, "prompts-tab");
      try {
        const { page, problems } = await tab(context);
        const tabEl = page.locator("prompt-settings");
        await tabEl.getByText("Sets of questions you answer in the journal", { exact: false }).waitFor();
        const [first] = await sets(page);
        assert.deepEqual(first, { heading: "Small truths Relationship · The Seven Principles for Making Marriage Work, John Gottman", open: false, prompts: [] });

        await tabEl.getByRole("button", { name: "New set" }).click();
        await until(async () => (await focused(page)) === "Name");
        await page.keyboard.type("My evening");
        await tabEl.getByRole("button", { name: "New prompt" }).click();
        await until(async () => (await focused(page)) === "prompt 0");
        await page.keyboard.type("What surprised me?");
        await page.keyboard.press("Enter");
        await until(async () => (await focused(page)) === "New prompt");
        await until(async () => (await sets(page))[0].heading === "My evening");
        assert.deepEqual((await sets(page))[0].prompts, ["What surprised me?"]);

        await tabEl.getByRole("button", { name: "Delete set" }).click();
        await until(async () => (await sets(page))[0].heading.startsWith("Small truths"));
        await page.locator("notice-stack", { hasText: "My evening" }).waitFor();
        await page.locator("notice-stack .undo").click();
        await until(async () => (await sets(page))[0].heading === "My evening");
        assert.deepEqual((await sets(page))[0].prompts, ["What surprised me?"], "Undo brings the set back as it was left");
        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, j and k step between headings, the arrows into the boxes, and Alt+arrows move a prompt and back", async () => {
      const context = await open(browser, "prompts-keys", { vim: true });
      try {
        const { page, problems } = await tab(context);
        await page.locator("prompt-settings button.fold").first().focus();
        await page.keyboard.press("j");
        await until(async () => (await focused(page)) === "heading Morning intention");
        await page.keyboard.press("k");
        await until(async () => (await focused(page)) === "heading Small truths");
        await page.keyboard.press("Enter");
        await until(async () => (await sets(page))[0].open);
        for (const stop of ["Name", "Occasion", "Based on", "prompt 0"]) {
          await page.keyboard.press("ArrowDown");
          await until(async () => (await focused(page)) === stop);
        }
        await page.keyboard.press("ArrowUp");
        await until(async () => (await focused(page)) === "Based on");
        await page.keyboard.press("ArrowDown");
        await until(async () => (await focused(page)) === "prompt 0");

        const [moved, second] = (await sets(page))[0].prompts;
        await page.keyboard.press("Alt+ArrowDown");
        await until(async () => (await sets(page))[0].prompts[1] === moved);
        assert.equal((await sets(page))[0].prompts[0], second);
        await until(async () => (await focused(page)) === "prompt 1", 2000);
        await page.keyboard.press("Alt+ArrowUp");
        await until(async () => (await sets(page))[0].prompts[0] === moved);
        await until(async () => (await focused(page)) === "prompt 0", 2000);
        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });

    // Browser: a reload against real storage.
    test("an opened set stays open across a reload", async () => {
      const context = await open(browser, "prompts-fold");
      try {
        const { page, problems } = await tab(context);
        await page.locator("prompt-settings button.fold").nth(2).click();
        await until(async () => (await sets(page))[2].open);
        // The sheet and its tab are kept open across the reload (settings-tabs).
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.locator("prompt-settings section.set").nth(9).waitFor();
        assert.deepEqual((await sets(page)).map((s) => s.open), [false, false, true, false, false, false, false, false, false, false]);
        assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
      } finally {
        await context.close();
      }
    });
  });
}
