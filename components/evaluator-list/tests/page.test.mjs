import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The keys every list shares (12, "Vim keys"): arrows always; with Vim keys on, j, k, gg
// and G too.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const JOURNAL = "00000000000000000000000JRN";
// A second book for the pin to be held against; its ePub is the one books' own tests import.
const SAMPLE_ID = "01K00000000000000000000SMP";
const SAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "books", "tests", "fixtures", "sample.epub");
const settings = (vimKeys) => JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

const inList = (page, fn, arg) =>
  page.evaluate(([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("evaluator-list").shadowRoot, arg), [fn.toString(), arg]);
const names = (page) => inList(page, (root) => [...root.querySelectorAll(".row .name")].map((n) => n.textContent.trim()));
const focusedName = (page) => inList(page, (root) => root.activeElement?.closest(".row")?.querySelector(".name")?.textContent.trim() ?? null);

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`evaluator-list keys in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Two evaluators of the journal on the server, so the list holds New evaluator,
    // Goals, Values.
    const open = async (vimKeys) => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      await signedIn(context, forgeCookie("evaluator-list"));
      for (const [id, name] of [["01K7TEST0000000000000E0001", "Goals"], ["01K7TEST0000000000000E0002", "Values"]]) {
        const put = await context.request.put(`${BASE_URL}/api/evaluators/${id}`, {
          data: { book: JOURNAL, name, on: true, questions: [], baseVersion: null, deleted: false },
        });
        assert.ok(put.ok(), "an evaluator is on the server");
      }
      await context.addInitScript((v) => localStorage.setItem("settings", v), settings(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
      await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
      await until(async () => (await names(page)).join() === "New evaluator,Goals,Values");
      await inList(page, (root) => root.querySelector('.open[tabindex="0"]').focus());
      return { context, page, problems };
    };

    // Browser: rendering and layout.
    test("signed out, with a book open, the panel shows only the line asking to sign in", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        // The book is opened signed in, since signed out the shelf shows no tiles; the
        // session then ends across a reload, and the open book is kept.
        await signedIn(context, forgeCookie("evaluator-list"));
        const page = await context.newPage();
        // After the reload the server refusing the gone cookie (401) is how the page learns
        // the session ended.
        const problems = watch(page, [], { ignore: [/\b401\b/] });
        await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
        await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
        await until(async () => (await names(page)).includes("New evaluator"));
        await context.clearCookies();
        await page.reload({ waitUntil: "domcontentloaded" });
        await until(async () => (await inList(page, (root) => root.textContent.trim())) === "Sign in to run evaluators.");
        assert.equal(await inList(page, (root) => root.querySelectorAll(".run, .row, button").length), 0, "no box, no rows, no buttons");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, j, k, G and gg move along the rows and Enter opens", async () => {
      const { context, page, problems } = await open(true);
      try {
        assert.equal(await focusedName(page), "New evaluator");
        await page.keyboard.press("G");
        await until(async () => (await focusedName(page)) === "Values");
        await page.keyboard.press("k");
        await until(async () => (await focusedName(page)) === "Goals");
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        await until(async () => (await focusedName(page)) === "New evaluator");
        await page.keyboard.press("j");
        await until(async () => (await focusedName(page)) === "Goals");
        assert.equal(await inList(page, (root) => root.querySelectorAll('[tabindex="0"]').length), 2, "one row, its tick box and its name, is the tab stop");
        await page.keyboard.press("Enter");
        await until(async () => (await page.evaluate(() => document.querySelector("evaluator-editor").shadowRoot.querySelector("input.title")?.value)) === "Goals");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on, dd cuts a row and p places it; Escape counts its delete down on the row and u takes it back; cc opens it in its name", async () => {
      const { context, page, problems } = await open(true);
      try {
        const rowClass = (name) =>
          inList(page, (root, n) => [...root.querySelectorAll(".row")].find((r) => r.querySelector(".name").textContent.trim() === n)?.className, name);
        await page.keyboard.press("j");
        await until(async () => (await focusedName(page)) === "Goals");
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await until(async () => (await rowClass("Goals")).includes("cut"));
        await page.keyboard.press("j");
        await until(async () => (await focusedName(page)) === "Values");
        await page.keyboard.press("p");
        await until(async () => (await names(page)).join() === "New evaluator,Values,Goals");
        await until(async () => (await focusedName(page)) === "Goals");
        assert.ok(!(await rowClass("Goals")).includes("cut"));
        // Cut again, then Escape: the delete counts down on the row and the list keeps the keyboard.
        await page.keyboard.press("d");
        await page.keyboard.press("d");
        await until(async () => (await rowClass("Goals")).includes("cut"));
        await page.keyboard.press("Escape");
        await until(async () => (await rowClass("Goals")).includes("discarding"));
        assert.equal(await focusedName(page), "Goals");
        await page.keyboard.press("u");
        await until(async () => !(await rowClass("Goals")).includes("discarding"));
        await page.keyboard.press("c");
        await page.keyboard.press("c");
        await until(async () =>
          page.evaluate(() => {
            const title = document.querySelector("evaluator-editor").shadowRoot.querySelector("input.title");
            return title?.value === "Goals" && document.querySelector("evaluator-editor").shadowRoot.activeElement === title;
          }),
        );
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys off, j does nothing and the arrows move", async () => {
      const { context, page, problems } = await open(false);
      try {
        await page.keyboard.press("j");
        await page.keyboard.press("ArrowDown");
        await until(async () => (await focusedName(page)) === "Goals");
        await page.keyboard.press("j");
        assert.equal(await focusedName(page), "Goals");
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("the pin on the About line starts off, holds the book when pressed and says which book is open, and lets go at once", async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(4000);
      try {
        await signedIn(context, forgeCookie("evaluator-list"));
        const put = await context.request.put(`${BASE_URL}/api/books/${SAMPLE_ID}`, {
          headers: { "content-type": "application/epub+zip" },
          data: readFileSync(SAMPLE),
        });
        assert.ok(put.ok(), "a second book is on the shelf");
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
        const header = () =>
          inList(page, (root) => {
            const pin = root.querySelector(".header .pin");
            return { about: root.querySelector(".about")?.textContent.replace(/\s+/g, " ").trim(), pressed: pin?.getAttribute("aria-pressed"), label: pin?.getAttribute("aria-label") };
          });
        await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
        await until(async () => (await header()).about === "About: Journal");
        assert.deepEqual(await header(), { about: "About: Journal", pressed: "false", label: "Pin evaluators" }, "off by default");

        await inList(page, (root) => root.querySelector(".header .pin").click());
        await until(async () => (await header()).pressed === "true");
        assert.equal((await header()).label, "Unpin evaluators");
        await page.click(`book-shelf .tile[data-id="${SAMPLE_ID}"]`);
        await until(async () => (await header()).about === "About: JournalPinned · Sample Book is open");

        await inList(page, (root) => root.querySelector(".header .pin").click());
        await until(async () => (await header()).about === "About: Sample Book");
        assert.deepEqual(await header(), { about: "About: Sample Book", pressed: "false", label: "Pin evaluators" });
        assert.deepEqual(problems, [], problems.join("; "));
      } finally {
        await context.close();
      }
    });
  });
}
