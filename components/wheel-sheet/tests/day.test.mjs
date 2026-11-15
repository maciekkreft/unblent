import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// The day closing at 2:00 while a Wheel of Life answer is being written, on the product
// page with a mocked clock. Kept separately so the boxes suite stays within its time budget.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch, signedIn, forgeCookie } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const ID = "01K7TEST00000000000000WHD1";
const ACTUAL = [6, 5, 4, 7, 3, 6, 5, 2];
const WANTED = [9, 7, 6, 8, 7, 6, 7, 6];
const ONE = "What does a 1 look like for you?";

const dayOf = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
};
const inSheet = (page, fn) =>
  page.evaluate((fn) => new Function("root", `return (${fn})(root)`)(document.querySelector("wheel-sheet").shadowRoot), fn.toString());

// The area the keyboard is on, or the class of what else has it inside the view.
const at = (page) => inSheet(page, (root) => root.activeElement?.dataset?.i ?? root.activeElement?.className?.trim() ?? null);
// The question whose box has the keyboard.
const inBox = (page) => inSheet(page, (root) => (root.activeElement?.classList.contains("cm-content") ? root.activeElement.getAttribute("aria-label") : null));
const storedOne = async (context) => {
  const { wheels } = await (await context.request.get(`${BASE_URL}/api/wheels`)).json();
  return wheels.find((w) => w.id === ID).answers[0].one;
};

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`wheel-sheet's day boundary in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    // Browser: focus and keys.
    test("at 2:00 what was typed is kept, the sheet stays to be read, and the keyboard moves from the box onto its area", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
      try {
        context.setDefaultTimeout(4000);
        const now = new Date();
        const twenty = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 59, 40);
        const day = dayOf(twenty.getTime() - 2 * 3600e3);
        await context.clock.install({ time: twenty });
        await signedIn(context, forgeCookie("wheeltwo"));
        const answers = [{ one: "Tired" }, ...Array(7).fill({})];
        assert.equal((await context.request.put(`${BASE_URL}/api/wheels/${ID}`, { data: { day, actual: ACTUAL, wanted: WANTED, answers, baseVersion: null } })).status(), 200);
        const record = { id: "01J00000000000000000000DAY", day, text: "Late", editedAt: twenty.getTime() - 3600e3 };
        assert.equal((await context.request.put(`${BASE_URL}/api/journal/days`, { data: { record, baseVersion: null } })).status(), 200);
        // The product page, whose feature is held back until released, so the answer about features
        // is replaced: the day named from its book's contents is the one the page stays on past 2:00.
        await context.route(/\/api\/flags$/, (route) => route.fulfill({ json: { off: [], hidden: [], released: ["wheel-of-life"], shown: ["wheel-of-life"] } }));
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
        await page.locator("book-shelf .tile", { hasText: "Journal" }).click();
        await page.locator("book-toc .entry").first().click();
        const sheet = page.locator("wheel-sheet");
        await sheet.locator(".card").click();
        await sheet.locator(".sheet").waitFor();
        await page.keyboard.press("Enter");
        await sheet.locator(".qs").waitFor();
        await page.keyboard.press("Enter");
        await until(async () => (await inBox(page)) === ONE);
        await page.keyboard.type("Very ");

        await page.clock.fastForward(40000);
        await sheet.locator(".sheet.read").waitFor();
        await until(async () => (await at(page)) === "0");
        assert.equal(await sheet.locator(".box").count(), 0);
        assert.deepEqual(await sheet.locator(".q-read .cm-line").allTextContents(), ["Very Tired"]);
        await until(async () => (await storedOne(context)) === "Very Tired");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });

  });
}
