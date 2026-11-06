import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// What only a browser shows: on the product page, in the page's order, the way from + Add sheet
// through its list to each sheet and back, by mouse and by keyboard, and where the keyboard
// lands when a sheet goes. The Wheel of Life's feature is held back until released, so the
// server's answer about features is replaced here. The decisions are tested in Node.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const FEATURES = ["choice-points", "usage", "slip-box", "reading-aloud", "book-experts", "wheel-of-life"];

// The product profile's preferences (12, Two profiles), with Vim keys on.
const VIM_ON = JSON.stringify({ vimKeys: true });

async function open(browser, { vim = false, phone = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(4000);
  await signedIn(context, forgeCookie("sheet-picker"));
  await context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: FEATURES, shown: FEATURES } }));
  if (vim) await context.addInitScript((v) => localStorage.setItem("settings:product", v), VIM_ON);
  if (phone) await context.addInitScript(() => localStorage.setItem("viewport", "phone"));
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  if (phone) await page.locator('dock-desk .dock.left .fold[aria-label="Unfold"]').click();
  await page.locator("book-shelf .tile", { hasText: "Journal" }).click();
  // On a phone the Books drawer covers the page until a day is picked.
  if (phone) await page.locator("book-toc .entry").first().click();
  const picker = page.locator("sheet-picker");
  await picker.locator(".new").waitFor();
  return { context, page, problems, picker };
}

const names = (picker) => picker.locator(".pick .nm").allTextContents();

// Where the keyboard is: which part of the journal page holds it, by a short name.
const keyboardAt = (page) =>
  page.evaluate(() => {
    const within = (name) => document.querySelector(name).matches(":focus-within");
    const picker = document.querySelector("sheet-picker").shadowRoot.activeElement;
    if (picker) return picker.classList.contains("pick") ? picker.dataset.id : "row";
    for (const name of ["values-sheet", "choice-point-cards", "wheel-sheet"]) {
      if (within(name)) {
        const active = document.querySelector(name).shadowRoot.activeElement;
        return `${name}:${active?.closest(".box")?.dataset.field ?? active?.dataset?.i ?? active?.className}`;
      }
    }
    return document.querySelector("journal-entry").shadowRoot.activeElement?.classList.contains("cm-content") ? "text" : null;
  });

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`sheet-picker in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    const press = async (page, key, want) => {
      await page.keyboard.press(key);
      await until(async () => (await keyboardAt(page)) === want);
    };

    // Browser: a gesture.
    test("by mouse: the row opens and closes the list, and the Wheel of Life is added and leaves the list", async () => {
      const { context, page, problems, picker } = await open(browser);
      try {
        const row = picker.locator(".new");
        assert.equal(await row.innerText(), "Add sheet");
        assert.equal(await row.getAttribute("aria-expanded"), "false");
        assert.equal(await picker.locator(".pick").count(), 0);
        await row.click();
        assert.deepEqual(await names(picker), ["Your values", "Choice point", "Wheel of Life"]);
        assert.deepEqual(await picker.locator(".pick .cat").allTextContents(), ["ACT", "ACT", "Coaching"]);
        assert.equal(await row.getAttribute("aria-expanded"), "true");
        await row.click();
        assert.equal(await picker.locator(".pick").count(), 0, "a second press closes it");

        await row.click();
        await picker.locator('.pick[data-id="wheel"]').click();
        await until(async () => (await keyboardAt(page)) === "wheel-sheet:0");
        await page.locator('wheel-sheet .area[data-i="1"] .sq').nth(4).click();
        await page.locator("wheel-sheet .done").click();
        await page.locator("wheel-sheet .card").waitFor();

        await row.click();
        assert.deepEqual(await names(picker), ["Your values", "Choice point"], "the wheel is on the day");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: a gesture.
    test("by mouse: Your values and Choice point are added, the sheets stand in the page's order, and Choice point stays listed", async () => {
      const { context, page, problems, picker } = await open(browser);
      try {
        const row = picker.locator(".new");
        await row.click();
        await picker.locator('.pick[data-id="values"]').click();
        await until(async () => (await keyboardAt(page)) === "values-sheet:name");
        await page.keyboard.type("Calm");
        await page.locator("values-sheet .done").click();
        await page.locator("values-sheet .card").waitFor();

        await row.click();
        assert.deepEqual(await names(picker), ["Choice point", "Wheel of Life"], "Choice point stays");
        await picker.locator('.pick[data-id="choice-point"]').click();
        await until(async () => (await keyboardAt(page)) === "choice-point-cards:situation");
        await page.keyboard.type("Dinner");
        await page.locator("choice-point-cards .done").click();
        await page.locator("choice-point-cards .card").waitFor();

        const tops = await page.evaluate(() => ["values-sheet", "choice-point-cards", "sheet-picker"].map((n) => document.querySelector(n).getBoundingClientRect().top));
        assert.deepEqual(tops, [...tops].sort((a, b) => a - b), "the sheets stand in the page's order, the row last");
        await row.click();
        assert.deepEqual(await names(picker), ["Choice point", "Wheel of Life"], "a day can hold several");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("by keyboard with Vim keys off: arrows and Enter reach each sheet, Escape comes back, and a sheet that goes leaves the keyboard on the row", async () => {
      const { context, page, problems, picker } = await open(browser);
      try {
        await picker.locator(".new").focus();
        await press(page, "Enter", "values");
        assert.equal(await picker.locator(".pick.cur").getAttribute("data-id"), "values");
        await press(page, "ArrowUp", "values");
        await press(page, "ArrowDown", "choice-point");
        assert.equal(await picker.locator(".pick.cur").getAttribute("data-id"), "choice-point");
        await press(page, "ArrowDown", "wheel");
        await press(page, "ArrowDown", "wheel");
        await press(page, "ArrowUp", "choice-point");
        await press(page, "Escape", "row");
        assert.equal(await picker.locator(".pick").count(), 0);

        // A wheel left untouched is not kept, and neither is a choice point with nothing written.
        await press(page, "Enter", "values");
        await press(page, "ArrowDown", "choice-point");
        await press(page, "ArrowDown", "wheel");
        await press(page, "Enter", "wheel-sheet:0");
        await press(page, "Escape", "row");
        assert.equal(await page.locator("wheel-sheet").evaluate((el) => getComputedStyle(el).display), "none");

        await press(page, "Enter", "values");
        await press(page, "ArrowDown", "choice-point");
        await press(page, "Enter", "choice-point-cards:situation");
        await press(page, "Escape", "row");
        assert.equal(await page.locator("choice-point-cards").evaluate((el) => getComputedStyle(el).display), "none");

        // Your values with nothing written comes off the day again.
        await press(page, "Enter", "values");
        await press(page, "Enter", "values-sheet:name");
        await press(page, "Escape", "row");
        assert.equal(await page.locator("values-sheet").evaluate((el) => getComputedStyle(el).display), "none");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: focus and keys.
    test("with Vim keys on: j, k, gg and G move in the list and stay in it, k from the closed row goes up, and j comes back", async () => {
      const { context, page, problems, picker } = await open(browser, { vim: true });
      try {
        await page.locator("journal-entry .cm-content").first().click();
        await page.keyboard.press("Escape");
        await press(page, "j", "row");
        await press(page, "k", "text");
        await press(page, "j", "row");
        await press(page, "Enter", "values");
        await press(page, "k", "values");
        await press(page, "j", "choice-point");
        await press(page, "G", "wheel");
        await press(page, "j", "wheel");
        await page.keyboard.press("g");
        await press(page, "g", "values");
        await press(page, "Escape", "row");
        await press(page, "k", "text");

        await press(page, "j", "row");
        await press(page, "Enter", "values");
        await press(page, "G", "wheel");
        await press(page, "Enter", "wheel-sheet:0");
        await press(page, "Escape", "row");
        await press(page, "k", "text");
        assert.equal(await picker.locator(".pick").count(), 0);
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

    // Browser: rendering and layout.
    test("in the phone preview the list fits the page, with targets large enough for a finger", async () => {
      const { context, page, problems, picker } = await open(browser, { phone: true });
      try {
        await picker.locator(".new").click();
        const pick = await picker.locator(".pick").first().boundingBox();
        const box = await page.locator("journal-entry").boundingBox();
        assert.ok(pick.height >= 44, `a target ${pick.height} tall`);
        assert.ok(pick.x >= box.x && pick.x + pick.width <= box.x + box.width, "nothing runs off the page");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
