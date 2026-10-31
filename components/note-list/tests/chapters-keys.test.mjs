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
const BOOK = "01K00000000000000000000CBQ";
const NOTES = [
  ["01ARZ3NDEKTSV4RRFFQ69G5FA1", "Loose note", {}],
  ["01ARZ3NDEKTSV4RRFFQ69G5FC3", "Second chapter note", { chapter: "chapter-two", chapterTitle: "Chapter Two" }],
  ["01ARZ3NDEKTSV4RRFFQ69G5FB2", "First chapter note", { chapter: "chapter-one", chapterTitle: "Chapter One" }],
];

const put = async (cookie, path, type, body) => {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "content-type": type, Cookie: `unblent_session=${cookie}` }, body });
  assert.equal(res.status, 200, `PUT ${path}`);
};

const seed = (vimKeys) => JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// Where the keyboard is in the list, as the user sees it: on the switch (which half it
// is on, and which half is pressed) or on a row, by its name.
const at = (page) =>
  page.evaluate(() => {
    const root = document.querySelector("note-list").shadowRoot;
    const el = root.activeElement;
    if (el?.closest(".switch")) return `switch ${el.textContent.trim()} (${root.querySelector('.switch [aria-pressed="true"]').textContent.trim()})`;
    if (el?.matches(".row")) return `row ${el.querySelector(".name").textContent.replace(/\s+/g, " ").trim()}`;
    return "elsewhere";
  });

async function open(engine, vimKeys, run) {
  const cookie = forgeCookie("note-list-keys");
  await put(cookie, `/api/books/${BOOK}`, "application/epub+zip", readFileSync(SAMPLE));
  await put(cookie, `/api/books/${BOOK}/opened`, "application/json", "{}");
  for (const [id, title, chapter] of NOTES)
    await put(cookie, `/api/notes/${id}`, "application/json", JSON.stringify({ title, body: title, baseVersion: null, about: [{ kind: "book", id: BOOK, ...chapter }] }));
  const browser = await engine.launch();
  try {
    const context = await browser.newContext();
    try {
      await signedIn(context, cookie);
      await context.addInitScript((v) => ["settings", "settings:product"].forEach((key) => localStorage.setItem(key, v)), seed(vimKeys));
      const page = await context.newPage();
      const problems = watch(page);
      await page.goto(`${BASE_URL}/workshop/design/subject`);
      await page.waitForFunction(() => document.querySelector("note-list")?.shadowRoot?.querySelector(".switch"));
      await page.locator("note-list").evaluate((el) => el.focus());
      await until(async () => (await at(page)).startsWith("row"));
      const step = async (key, want) => {
        await page.keyboard.press(key);
        await until(async () => (await at(page)) === want).catch(async () => assert.fail(`after ${key}: wanted ${want}, saw ${await at(page)}`));
      };
      await run(step, page);
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

for (const engine of ENGINES) {
  // Focus and keys: with Vim keys on, the switch is the top row of the list's keyboard
  // path, k reaching it from New note, h and l changing it, j going back down; every move
  // has its way back, at both ends.
  test(`Vim keys reach the chapter switch above New note and change it in ${engine.name}`, async () => {
    await open(engine, true, async (step, page) => {
      await page.keyboard.press("g");
      await step("g", "switch This chapter (This chapter)");
      await step("j", "row New note");
      await step("k", "switch This chapter (This chapter)");
      await step("k", "switch This chapter (This chapter)");
      await step("l", "switch All chapters (All chapters)");
      await step("l", "switch All chapters (All chapters)");
      await step("j", "row New note");
      await step("k", "switch All chapters (All chapters)");
      await step("h", "switch This chapter (This chapter)");
      await step("h", "switch This chapter (This chapter)");
    });
  });

  // Focus and keys: with Vim keys on, G from the switch reaches the last row, j stays
  // there, and gg from it comes back to the switch.
  test(`Vim keys cross the whole list from the chapter switch and back in ${engine.name}`, async () => {
    await open(engine, true, async (step, page) => {
      await page.keyboard.press("g");
      await step("g", "switch This chapter (This chapter)");
      await step("G", "row First chapter note");
      await step("j", "row First chapter note");
      await page.keyboard.press("g");
      await step("g", "switch This chapter (This chapter)");
    });
  });

  // Focus and keys: with Vim keys off the arrows do the same, and the letters stay letters.
  test(`the arrows reach the chapter switch above New note and change it in ${engine.name}`, async () => {
    await open(engine, false, async (step, page) => {
      for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
      await until(async () => (await at(page)) === "switch This chapter (This chapter)");
      await step("l", "switch This chapter (This chapter)");
      await step("ArrowRight", "switch All chapters (All chapters)");
      await step("ArrowDown", "row New note");
      await step("ArrowUp", "switch All chapters (All chapters)");
      await step("ArrowLeft", "switch This chapter (This chapter)");
      await step("ArrowDown", "row New note");
    });
  });
}
