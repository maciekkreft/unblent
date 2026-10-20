import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(resolve(HERE, "..", "..", "books", "tests", "fixtures", "sample.epub"));
const SAMPLE_ID = "01K00000000000000000000SMP";

// What the stage shows: the tag of the one child its slot holds.
const shown = (page) =>
  page.evaluate(() => document.querySelector("book-stage")?.shadowRoot?.querySelector("slot")?.assignedElements().map((e) => e.localName).join(",") ?? null);

const clickTile = (page, title) =>
  page.evaluate((title) => {
    const tiles = [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile:not(.adding)") ?? [])];
    const tile = tiles.find((t) => t.querySelector(".title")?.textContent.trim() === title);
    tile?.click();
    return Boolean(tile);
  }, title);

for (const engine of ENGINES) {
  // Browser: a page's composition.
  test(`the stage shows the journal's page for the Journal and the reader for an imported book in ${engine.name}`, async () => {
    const cookie = forgeCookie("book-stage");
    // The book arrives through the server's API (11.2): milliseconds, no browser upload.
    const res = await fetch(`${BASE_URL}/api/books/${SAMPLE_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/epub+zip", Cookie: `unblent_session=${cookie}` },
      body: SAMPLE,
    });
    assert.equal(res.status, 200, "importing the sample book");
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, cookie);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        ["Journal", "Sample Book"].every((title) =>
          [...(document.querySelector("book-shelf")?.shadowRoot?.querySelectorAll(".tile .title") ?? [])].some((t) => t.textContent.trim() === title),
        ),
      );
      assert.equal(await shown(page), "book-reader", "with no book open the stage shows the reader");

      assert.ok(await clickTile(page, "Journal"));
      await page.waitForFunction(() => {
        const [child] = document.querySelector("book-stage").shadowRoot.querySelector("slot").assignedElements();
        const editor = child?.localName === "journal-entry" && child.shadowRoot?.querySelector(".cm-editor");
        return editor && editor.getBoundingClientRect().height > 0;
      });

      assert.ok(await clickTile(page, "Sample Book"));
      await page.waitForFunction(() => {
        const [child] = document.querySelector("book-stage").shadowRoot.querySelector("slot").assignedElements();
        return child?.localName === "book-reader" && child.shadowRoot?.querySelector(".footer .chap")?.textContent.trim();
      });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}

// Open on stage, on the product page (8): a note shown as a tab of its own beside the
// books, which stays while the Notes panel follows another book, until its × closes it.
const NOTE_ONE = "01K0000000000000000000NTE1";
const NOTE_TWO = "01K0000000000000000000NTE2";
const JOURNAL = "00000000000000000000000JRN";

const stageTabs = (page) =>
  page.evaluate(() =>
    [...(document.querySelector("dock-desk")?.shadowRoot?.querySelectorAll(".stage .own [role=tab]") ?? [])].map(
      (t) => `${t.textContent.trim()}${t.getAttribute("aria-selected") === "true" ? "*" : ""}`,
    ),
  );

const panelText = (page) =>
  page.evaluate(() => document.querySelector("note-editor[subject]")?.shadowRoot?.querySelector(".cm-content")?.textContent ?? "");

for (const engine of ENGINES) {
  // Browser: a page's composition.
  test(`a note opened on the stage keeps its tab while the panel follows another book in ${engine.name}`, async () => {
    const cookie = forgeCookie("book-stage");
    const put = async (path, type, body) => {
      const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
      assert.equal(res.status, 200, `PUT ${path}`);
    };
    await put(`/api/books/${SAMPLE_ID}`, "application/epub+zip", SAMPLE);
    await put(`/api/books/${SAMPLE_ID}/opened`, "application/json", "{}");
    for (const [id, title, book] of [[NOTE_ONE, "Plans", SAMPLE_ID], [NOTE_TWO, "Thoughts", JOURNAL]])
      await put(`/api/notes/${id}`, "application/json", JSON.stringify({ title, body: title, baseVersion: null, about: [{ kind: "book", id: book }] }));
    const browser = await engine.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(4000);
    try {
      await signedIn(context, cookie);
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const button = document.querySelector("note-editor[subject]")?.shadowRoot?.querySelector("button.open");
        return button && !button.disabled;
      });
      assert.equal(await panelText(page), "Plans");

      await page.evaluate(() => document.querySelector("note-editor[subject]").shadowRoot.querySelector("button.open").click());
      await page.waitForFunction(() => {
        const [child] = document.querySelector("book-stage").shadowRoot.querySelector("slot").assignedElements();
        return child?.id === "stage" && child.shadowRoot?.querySelector(".cm-content")?.textContent === "Plans";
      });
      assert.deepEqual(await stageTabs(page), ["Sample Book", "Plans*"]);
      await page.waitForFunction(() =>
        document.querySelector("note-editor[subject]").shadowRoot.querySelector("button.open").getAttribute("aria-pressed") === "true",
      );

      // The pin starts on (pins), so it is let go of for the panel to follow the book.
      await page.evaluate(() => document.querySelector("note-editor[subject]").shadowRoot.querySelector("button.pin").click());
      await page.evaluate((id) => document.querySelector("book-shelf").shadowRoot.querySelector(`.tile[data-id="${id}"]`).click(), JOURNAL);
      await page.waitForFunction(() => document.querySelector("note-editor[subject]").shadowRoot.querySelector(".cm-content")?.textContent === "Thoughts");
      assert.deepEqual(await stageTabs(page), ["Sample Book", "Plans", "Journal*"]);

      await page.evaluate(() => document.querySelector("dock-desk").shadowRoot.querySelector('.stage button.close[aria-label="Close Plans"]').click());
      await page.waitForFunction(() => document.querySelector("dock-desk").shadowRoot.querySelectorAll(".stage .own [role=tab]").length === 2);
      assert.deepEqual(await stageTabs(page), ["Sample Book", "Journal*"]);
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
