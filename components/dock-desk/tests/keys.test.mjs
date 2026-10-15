import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the helpers every browser suite shares, reached by the path the check sets.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, forgeCookie, signedIn } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

// The "Vim keys" preference (12), seeded the way the settings fact stores it; `/` is in
// the product profile, which keeps its own copy under its own key.
const seed = (vimKeys) =>
  JSON.stringify({ nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, vimKeys });

// Which panel holds the keyboard: the desk's child that contains the focused element,
// by its address (4.1), and the tag of the element focused inside that panel's tree.
const focused = (page) =>
  page.evaluate(() => {
    const desk = document.querySelector("dock-desk");
    const active = document.activeElement;
    const child = [...desk.children].find((c) => c.contains(active));
    let deep = active;
    while (deep?.shadowRoot?.activeElement) deep = deep.shadowRoot.activeElement;
    return {
      panel: child ? child.localName + (child.id ? "#" + child.id : "") : null,
      host: active?.localName ?? null,
      row: deep?.getAttribute?.("tabindex") === "0" && deep.getAttribute("role") === "option",
    };
  });

const rightTab = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector("dock-desk")
        .shadowRoot.querySelector('.dock.right .panel [role="tab"][aria-selected="true"]')
        ?.textContent.trim() ?? null,
  );

async function open(engine, vimKeys) {
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("panel-keys"));
  await context.addInitScript((value) => {
    localStorage.setItem("settings", value);
    localStorage.setItem("settings:product", value);
  }, seed(vimKeys));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`);
  await page.waitForFunction(
    () =>
      document.querySelector("dock-desk")?.shadowRoot?.querySelector(".dock.right .panel") &&
      document.querySelector("note-list")?.shadowRoot?.querySelector("li.draft") &&
      // The reader settled on its empty page: a page drawn while it still loads is
      // replaced, and the focus with it.
      document.querySelector("book-reader")?.shadowRoot?.querySelector(".reader .message"),
  );
  return { browser, context, page, problems };
}

for (const engine of ENGINES) {
  test(`Ctrl+h/l and Ctrl+. move the keyboard between panels and tabs on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, true);
    try {
      await page.evaluate(() => document.querySelector("book-reader").focus());
      assert.equal((await focused(page)).panel, "book-stage");

      await page.keyboard.press("Control+l");
      await until(async () => (await focused(page)).panel === "list-then-item#notes");
      const notes = await focused(page);
      assert.equal(notes.host, "note-list", "the Notes list holds the keyboard");
      assert.ok(notes.row, "on its roving row");

      await page.keyboard.press("Control+.");
      await until(async () => (await focused(page)).panel === "list-then-item#chats");
      assert.equal(await rightTab(page), "Chats", "the next tab is shown");

      await page.keyboard.press("Control+h");
      await until(async () => (await focused(page)).panel === "book-stage");
      await page.keyboard.press("Control+h");
      await until(async () => (await focused(page)).panel === "list-then-item#books");

      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  test(`with Vim keys on the keyboard starts on the stage, so Ctrl+l works at once on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, true);
    try {
      await until(async () => (await focused(page)).panel === "book-stage");
      await page.keyboard.press("Control+l");
      await until(async () => (await focused(page)).panel === "list-then-item#notes");
      assert.ok((await focused(page)).row, "on the Notes row");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  test(`with Vim keys off nothing takes the focus at load on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, false);
    try {
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(await page.evaluate(() => document.activeElement?.localName), "body");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  test(`with Vim keys off Ctrl+l leaves the keyboard where it is on / in ${engine.name}`, async () => {
    const { browser, context, page, problems } = await open(engine, false);
    try {
      await page.evaluate(() => document.querySelector("book-reader").focus());
      await page.keyboard.press("Control+l");
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await focused(page)).panel, "book-stage");
      assert.deepEqual(problems, [], `${engine.name} reported: ${problems.join("; ")}`);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
