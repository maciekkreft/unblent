import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE;
assert.ok(PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE must be set (checks/check.py reads it from .env)");
const { webkit, chromium } = await import(PLAYWRIGHT_MODULE);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SCREENSHOTS = resolve(REPO, ".screenshots");

// What the container renders: the slot's assigned elements, read from its shadow root.
const assigned = (page) =>
  page.evaluate(() =>
    document
      .querySelector("list-then-item")
      .shadowRoot.querySelector("slot")
      .assignedElements()
      .map((el) => el.localName),
  );

// The Back bar's label, or null when the list is shown (no bar).
const barLabel = (page) =>
  page.evaluate(() => {
    const button = document.querySelector("list-then-item").shadowRoot.querySelector(".bar button span");
    return button ? button.textContent.trim() : null;
  });

const clickNewNote = (page) =>
  page.evaluate(() => document.querySelector("note-list").shadowRoot.querySelector("li.draft").click());

const clickBack = (page) =>
  page.evaluate(() => document.querySelector("list-then-item").shadowRoot.querySelector(".bar button").click());

const ready = (page) =>
  page.waitForFunction(
    () =>
      document.querySelector("list-then-item")?.shadowRoot?.querySelector("slot") &&
      document.querySelector("note-list")?.shadowRoot?.querySelector("li.draft"),
  );

const watch = (page) => {
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  page.on("requestfailed", (req) =>
    problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
  );
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  return problems;
};

const ENGINES = [
  { name: "webkit", launch: () => webkit.launch() },
  { name: "chromium", launch: () => chromium.launch({ chromiumSandbox: false }) },
];

// WebKit first, then Chromium: a Safari-class engine is the stricter check.
for (const engine of ENGINES) {
  test(`the container shows the list, then the item, then the list in ${engine.name}`, async () => {
    const browser = await engine.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    const problems = watch(page);
    try {
      await page.goto(`${BASE_URL}/workshop/design/list-then-item`);
      await ready(page);

      // The list alone at first: no item, no bar.
      assert.deepEqual(await assigned(page), ["note-list"]);
      assert.equal(await barLabel(page), null);

      // Picking "New note" shows the editor under a "Notes" bar.
      await clickNewNote(page);
      await page.waitForFunction(
        () =>
          document
            .querySelector("list-then-item")
            .shadowRoot.querySelector("slot")
            .assignedElements()[0]?.localName === "note-editor",
      );
      assert.deepEqual(await assigned(page), ["note-editor"]);
      assert.equal(await barLabel(page), "Notes");

      // Back returns to the list.
      await clickBack(page);
      await page.waitForFunction(
        () =>
          document
            .querySelector("list-then-item")
            .shadowRoot.querySelector("slot")
            .assignedElements()[0]?.localName === "note-list",
      );
      assert.deepEqual(await assigned(page), ["note-list"]);
      assert.equal(await barLabel(page), null);

      // The shown child is remembered on the device (3.1): pick again, reload, the
      // editor is shown once more.
      await clickNewNote(page);
      await page.waitForFunction(
        () =>
          document
            .querySelector("list-then-item")
            .shadowRoot.querySelector("slot")
            .assignedElements()[0]?.localName === "note-editor",
      );
      await page.reload();
      await ready(page);
      assert.deepEqual(await assigned(page), ["note-editor"]);
      assert.equal(await barLabel(page), "Notes");

      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: resolve(SCREENSHOTS, `list-then-item-${engine.name}.png`),
        fullPage: true,
      });
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await browser.close();
    }
  });
}

// The phone preview (data-viewport="phone", set through the localStorage key): the same
// list-then-item behaviour, so the pair is one tab on a phone too.
test("the container works in the phone preview", async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  const problems = watch(page);
  try {
    await page.goto(`${BASE_URL}/workshop/design/list-then-item`);
    await page.evaluate(() => localStorage.setItem("viewport", "phone"));
    await page.reload();
    await ready(page);
    await page.waitForFunction(() => document.documentElement.dataset.viewport === "phone");

    assert.deepEqual(await assigned(page), ["note-list"]);
    await clickNewNote(page);
    await page.waitForFunction(
      () =>
        document
          .querySelector("list-then-item")
          .shadowRoot.querySelector("slot")
          .assignedElements()[0]?.localName === "note-editor",
    );
    assert.deepEqual(await assigned(page), ["note-editor"]);
    assert.equal(await barLabel(page), "Notes");
    assert.deepEqual(problems, [], `phone reported: ${problems.join("; ")}`);
  } finally {
    await browser.close();
  }
});
