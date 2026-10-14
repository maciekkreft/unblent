import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// A press inside the editor that lands on nothing that takes focus, as every press on a
// button does in Safari, must not hand the focus to the evaluator's name: with the name
// scrolled away, that scrolled the editor to the top between mousedown and mouseup, and
// the click landed on whatever was then under the pointer, so "Add an option" did
// nothing. Playwright's WebKit focuses a pressed button, so the press beside the button
// stands in for Safari's press on it.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { ENGINES, until, watch } = await import(process.env.UNBLENT_KIT);

const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");

const JOURNAL = "00000000000000000000000JRN";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const inEditor = (page, fn, arg) =>
  page.evaluate(
    ([fn, arg]) => new Function("root", "arg", `return (${fn})(root, arg)`)(document.querySelector("evaluator-editor").shadowRoot, arg),
    [fn.toString(), arg],
  );
const optionCount = (page) => inEditor(page, (root) => root.querySelectorAll(".option").length);
// Where the editor is scrolled: its own scroller and the document, whichever moves.
const scrolled = (page) => inEditor(page, (root) => [root.querySelector(".page").scrollTop, document.scrollingElement.scrollTop]);

// A press at the pace a person presses: over, down, up.
async function press(page, x, y) {
  await page.mouse.move(x, y);
  await pause(60);
  await page.mouse.down();
  await pause(100);
  await page.mouse.up();
}

for (const engine of ENGINES.filter((e) => e.name === "webkit")) {
  describe(`evaluator-editor in ${engine.name}`, { timeout: 30000 }, () => {
    let browser;
    before(async () => {
      browser = await engine.launch();
    }, { timeout: 20000 });
    after(async () => {
      await browser?.close();
    }, { timeout: 15000 });

    test("a press beside Add an option leaves the scroll and the name alone, and the button adds one option", async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
      context.setDefaultTimeout(4000);
      try {
        const page = await context.newPage();
        const problems = watch(page);
        await page.goto(`${BASE_URL}/workshop/design/evaluators`, { waitUntil: "domcontentloaded" });
        await page.click(`book-shelf .tile[data-id="${JOURNAL}"]`);
        await page.click("evaluator-list .row.new .open");
        await page.fill("evaluator-editor input.title", "Goal or value");
        await page.locator("evaluator-editor").getByText("Pick one").click();
        // Options enough that the name scrolls out of view.
        for (let i = 0; i < 6; i++) await inEditor(page, (root) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add an option").click());
        await until(async () => (await optionCount(page)) === 8);
        await inEditor(page, (root) => {
          root.querySelector(".page").scrollTop = 1e6;
          document.scrollingElement.scrollTop = 1e6;
          [...root.querySelectorAll(".option input")].at(-1).focus();
        });
        const add = page.locator("evaluator-editor").getByRole("button", { name: "Add an option" });
        const box = await add.boundingBox();
        const before = await scrolled(page);
        assert.ok(before.some((top) => top > 0), "the editor is scrolled, so the name is out of view");

        await press(page, box.x + box.width + 40, box.y + box.height / 2);
        assert.deepEqual(await scrolled(page), before, "the editor did not jump");
        assert.equal(await inEditor(page, (root) => root.activeElement?.matches("input.title") ?? false), false, "the name did not take the keyboard");
        assert.equal(await optionCount(page), 8);

        const again = await add.boundingBox();
        await press(page, again.x + again.width / 2, again.y + again.height / 2);
        await until(async () => (await optionCount(page)) === 9);
        assert.equal(await inEditor(page, (root) => root.activeElement === [...root.querySelectorAll(".option input")].at(-1)), true, "the keyboard is in the new option");
        assert.deepEqual(problems, []);
      } finally {
        await context.close();
      }
    });
  });
}
